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
 * HACKBENCH_FETCH_TMP (default the OS temp dir), removed when the hack is done,
 * has its listing vetted before one file is read from it, and nothing in it is
 * ever executed. Only the HTML stop ends the run; any other failure (download,
 * archive, patch) is recorded (patch_result "failed") so it is not retried.
 * The store must sit outside the repository.
 * Writes: patches/<id>/<patch>, roms/<id>.sfc, index.json (previous copy kept
 * as index.json.bak-<date>). Prints ids, names and hashes; no ROM bytes.
 */
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { romPath, VANILLA } from '../../test/suite/support/corpus'
import {
  candidates,
  curlArgs,
  flagValue,
  HtmlStop,
  indexRecord,
  looksLikeHtml,
  processArchive,
  readIndex,
  storeInsideRepo,
  validListing,
  type ListingItem,
} from './hackFetch'

const API = 'https://www.smwcentral.net/ajax.php?a=getsectionlist&s=smwhacks&u=0&o=downloads&d=desc'
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let lastCall = 0

async function curl(url: string, out?: string): Promise<Buffer> {
  const wait = lastCall + 6500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()
  const body = execFileSync('curl', curlArgs(url, out), { maxBuffer: 1 << 28 })
  const bytes = out ? readFileSync(out) : body
  if (looksLikeHtml(bytes))
    throw new HtmlStop(`HTML answer from ${url}; stopping (see docs/runbooks/smwc-api.md)`)
  return bytes
}

async function listing(pages: number): Promise<ListingItem[]> {
  const items: ListingItem[] = []
  for (let n = 1; n <= pages; n++)
    items.push(...validListing(JSON.parse((await curl(`${API}&n=${n}`)).toString('utf8'))))
  return items
}

async function fetchOne(
  item: ListingItem,
  vanilla: Uint8Array,
  store: string,
  index: { hacks: Record<string, unknown>[] },
): Promise<void> {
  const dir = mkdtempSync(join(process.env.HACKBENCH_FETCH_TMP ?? tmpdir(), `hack-${item.id}-`))
  let zipBytes: Uint8Array | null = null
  let result = processArchive(new Uint8Array(), vanilla)
  try {
    const zip = join(dir, 'download.zip')
    await curl(item.download_url, zip)
    zipBytes = readFileSync(zip)
    result = processArchive(zipBytes, vanilla)
  } catch (e) {
    if (e instanceof HtmlStop) throw e
    result = {
      ...result,
      failure: `download failed: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const { failure, patch, rom } = result
  if (patch && rom && !failure) {
    mkdirSync(join(store, 'patches', String(item.id)), { recursive: true })
    mkdirSync(join(store, 'roms'), { recursive: true })
    writeFileSync(join(store, 'patches', String(item.id), patch.name), patch.bytes)
    writeFileSync(join(store, 'roms', `${item.id}.sfc`), rom)
  }
  index.hacks.push(
    indexRecord({
      item,
      patchSha256: patch ? sha(patch.bytes) : null,
      patchFormat: result.format,
      sourceZipSha256: zipBytes ? sha(zipBytes) : null,
      patchedRomSha256: failure || !rom ? null : sha(rom),
      patchedRomSize: failure || !rom ? null : rom.length,
      baseRomSha256: sha(vanilla),
      failure,
      date: new Date().toISOString().slice(0, 10),
    }),
  )
  console.log(
    `${item.id} ${item.name}: ${failure ? `FAILED ${failure}` : `ok ${rom!.length} bytes sha256 ${sha(rom!)}`}`,
  )
}

async function main() {
  const vanillaPath = romPath(VANILLA)
  const store = process.env.HACKBENCH_HACKS ?? join(vanillaPath, '..', '..', 'hacks')
  if (storeInsideRepo(store, resolve(__dirname, '..', '..')))
    throw new Error(
      `${store} is inside the repository; set HACKBENCH_HACKS to a directory outside it`,
    )
  const indexPath = join(store, 'index.json')
  const index = readIndex(readFileSync(indexPath, 'utf8'))
  const known = new Set(index.hacks.map(h => h.smwc_id as number))
  const vanilla = new Uint8Array(readFileSync(vanillaPath))
  const wanted = flagValue(process.argv, '--id')
  if (wanted && known.has(Number(wanted))) throw new Error(`${wanted} is already in the store`)
  const pages = Number(
    flagValue(process.argv, '--pages') ?? (process.argv.includes('--list') ? 1 : 3),
  )
  const listed = await listing(pages)
  const missing = candidates(listed, known)
  if (process.argv.includes('--list')) {
    for (const c of missing) console.log(`${c.id}	${c.downloads}	${c.name}`)
    return
  }
  const ids = wanted
    ? [Number(wanted)]
    : missing.slice(0, Number(flagValue(process.argv, '--count') ?? 1)).map(c => c.id)
  const items = ids.map(id => listed.find(i => i.id === id))
  if (!ids.length || items.some(i => !i))
    throw new Error(
      'nothing to fetch: id not in the listed pages, or all listed hacks are in the store',
    )
  for (const item of items) {
    await fetchOne(item!, vanilla, store, index)
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
