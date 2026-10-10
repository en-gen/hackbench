/**
 * Grows the hack store (#543): downloads SMW Central hacks, applies each patch to
 * the vanilla ROM, records provenance in index.json. Hand-run, never CI:
 *
 *   npx tsx tools/scripts/hack-fetch.ts --list [--pages 3]   what is missing, most downloaded first
 *   npx tsx tools/scripts/hack-fetch.ts --next [--count 1]   fetch and apply the next N missing hacks
 *   npx tsx tools/scripts/hack-fetch.ts --id 9794            fetch and apply one listed hack
 *
 * HACKBENCH_HACKS names the store (default: hackbench-tools/hacks beside the
 * ROMs). Rules from docs/runbooks/smwc-api.md: the JSON endpoint only, plain
 * curl, about 6 s between calls, and an HTML answer is a stop, never bypassed.
 * Downloads are untrusted: each goes in its own new directory under
 * HACKBENCH_FETCH_TMP (default the OS temp dir), has its listing vetted before
 * one file is read from it, and nothing in it is ever executed. A hack whose patch cannot be
 * applied is still recorded (patch_result "failed") so it is not retried.
 * Writes: patches/<id>/<patch>, roms/<id>.sfc, index.json (previous copy kept
 * as index.json.bak-<date>). Prints ids, names and hashes; no ROM bytes.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'
import { applyBps } from '../../src/rom/Bps'
import { decodeIps } from '../../src/rom/Ips'
import { romPath, VANILLA } from '../../test/suite/support/corpus'
import {
  candidates,
  indexRecord,
  looksLikeHtml,
  pickPatch,
  unsafeEntry,
  zipEntries,
  zipRead,
  type ListingItem,
} from './hackFetch'

const API = 'https://www.smwcentral.net/ajax.php?a=getsectionlist&s=smwhacks&u=0&o=downloads&d=desc'
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const arg = (name: string) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : (process.argv[at + 1] ?? '')
}

const vanillaPath = romPath(VANILLA)
const store = process.env.HACKBENCH_HACKS ?? join(vanillaPath, '..', '..', 'hacks')
const indexPath = join(store, 'index.json')
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { hacks: Record<string, unknown>[] }
const known = new Set(index.hacks.map(h => h.smwc_id as number))
let lastCall = 0

async function curl(url: string, out?: string): Promise<Buffer> {
  const wait = lastCall + 6500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()
  const args = [
    '-s',
    '-S',
    '-L',
    '-m',
    '120',
    '--max-filesize',
    '104857600',
    ...(out ? ['-o', out] : []),
    url,
  ]
  const body = execFileSync('curl', args, { maxBuffer: 1 << 28 })
  const bytes = out ? readFileSync(out) : body
  if (looksLikeHtml(bytes))
    throw new Error(`HTML answer from ${url}; stopping (see docs/runbooks/smwc-api.md)`)
  return bytes
}

async function listing(pages: number): Promise<ListingItem[]> {
  const items: ListingItem[] = []
  for (let n = 1; n <= pages; n++) {
    const page = JSON.parse((await curl(`${API}&n=${n}`)).toString('utf8')) as {
      data: ListingItem[]
    }
    items.push(...page.data)
  }
  return items
}

function applyPatch(vanilla: Uint8Array, patch: Uint8Array, format: string): Uint8Array | string {
  if (format === 'bps') {
    const r = applyBps(vanilla, patch)
    return r.ok ? r.bytes : r.reason.slice(0, 200)
  }
  const records = decodeIps(patch)
  if (!records) return 'decodeIps refused the patch'
  const out = new Uint8Array(records.reduce((m, p) => Math.max(m, p.offset + 1), vanilla.length))
  out.set(vanilla)
  for (const p of records) out[p.offset] = p.value
  return out
}

async function fetchOne(item: ListingItem, vanilla: Uint8Array): Promise<void> {
  const dir = mkdtempSync(join(process.env.HACKBENCH_FETCH_TMP ?? tmpdir(), `hack-${item.id}-`))
  const zip = join(dir, 'download.zip')
  await curl(item.download_url, zip)
  const zipBytes = readFileSync(zip)
  const entries = zipEntries(zipBytes).filter(e => !e.name.endsWith('/'))
  const bad = entries.find(e => unsafeEntry(e.name))
  let failure: string | null = bad ? `unsafe archive entry ${bad.name}` : null
  let choice: ReturnType<typeof pickPatch> | null = null
  let patchBytes: Uint8Array | null = null
  let rom: Uint8Array | string = ''
  if (!failure) {
    choice = pickPatch(entries.map(e => e.name))
    if (choice.ok) {
      const file = choice.file
      patchBytes = zipRead(
        zipBytes,
        entries.find(e => e.name === file)!,
      )
      rom = applyPatch(vanilla, patchBytes, choice.format)
      if (typeof rom === 'string') failure = `${choice.format} apply failed: ${rom}`
    } else failure = choice.reason
  }
  const format = choice?.ok ? choice.format : null
  if (patchBytes && choice?.ok && !failure) {
    mkdirSync(join(store, 'patches', String(item.id)), { recursive: true })
    mkdirSync(join(store, 'roms'), { recursive: true })
    const name = choice.file.split('/').pop()!
    writeFileSync(join(store, 'patches', String(item.id), name), patchBytes)
    writeFileSync(join(store, 'roms', `${item.id}.sfc`), rom as Uint8Array)
  }
  const out = typeof rom === 'string' ? null : rom
  index.hacks.push(
    indexRecord({
      item,
      patchSha256: patchBytes ? sha(patchBytes) : null,
      patchFormat: format,
      sourceZipSha256: sha(zipBytes),
      patchedRomSha256: failure || !out ? null : sha(out),
      patchedRomSize: failure || !out ? null : out.length,
      baseRomSha256: sha(vanilla),
      failure,
      date: new Date().toISOString().slice(0, 10),
    }),
  )
  console.log(
    `${item.id} ${item.name}: ${failure ? `FAILED ${failure}` : `ok ${out!.length} bytes sha256 ${sha(out!)}`}`,
  )
  console.log(`  download kept at ${relative(process.cwd(), dir)} (untrusted, not executed)`)
}

async function main() {
  const vanilla = new Uint8Array(readFileSync(vanillaPath))
  const wanted = arg('--id')
  if (wanted && known.has(Number(wanted))) throw new Error(`${wanted} is already in the store`)
  const listed = await listing(Number(arg('--pages') ?? (process.argv.includes('--list') ? 1 : 3)))
  const missing = candidates(listed, known)
  if (process.argv.includes('--list')) {
    for (const c of missing) console.log(`${c.id}	${c.downloads}	${c.name}`)
    return
  }
  const ids = wanted
    ? [Number(wanted)]
    : missing.slice(0, Number(arg('--count') ?? 1)).map(c => c.id)
  const items = ids.map(id => listed.find(i => i.id === id))
  if (!ids.length || items.some(i => !i))
    throw new Error(
      'nothing to fetch: id not in the listed pages, or all listed hacks are in the store',
    )
  for (const item of items) {
    await fetchOne(item!, vanilla)
    const backup = `${indexPath}.bak-${new Date().toISOString().slice(0, 10)}`
    if (!existsSync(backup)) copyFileSync(indexPath, backup) // the first copy of the day, from before this run
    writeFileSync(
      indexPath,
      `${JSON.stringify(index, null, 1)}
`,
    )
  }
}

main().catch(e => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exit(1)
})
