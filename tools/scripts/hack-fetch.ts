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
 * ever executed. HTTPS only (curl --proto =https, also after redirects). The run ends
 * with nothing recorded on: a 429 or 5xx, any HTML answer (the stop), any other HTTP
 * status, and a curl failure such as a timeout; none of these is permanent, so the hack
 * is tried again next run. Only what the archive, the patch or the store write does
 * (no or several patches, unsafe names, a patch that will not apply) is recorded as
 * patch_result "failed" and not retried. The store must sit outside the repository.
 * Writes: patches/<id>/patch.<bps|ips> (the entry name is kept in index.json as patch_entry), roms/<id>.sfc, index.json (previous copy kept
 * as index.json.bak-<date>). Prints ids, names and hashes; no ROM bytes.
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { romPath, VANILLA } from '../../test/suite/support/corpus'
import {
  candidates,
  checkResponse,
  curlArgs,
  positiveIntFlag,
  fetchHack,
  readIndex,
  splitStatus,
  storeInsideRepo,
  validListing,
  type ListingItem,
} from './hackFetch'

const API = 'https://www.smwcentral.net/ajax.php?a=getsectionlist&s=smwhacks&u=0&o=downloads&d=desc'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
let lastCall = 0

/** One rate-limited curl call; the status and body go to the caller, who decides what they mean. */
async function curl(url: string, out?: string): Promise<{ status: number; bytes: Buffer }> {
  const wait = lastCall + 6500 - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()
  const { status, body } = splitStatus(
    execFileSync('curl', curlArgs(url, out), { maxBuffer: 1 << 28 }),
  )
  return { status, bytes: out ? readFileSync(out) : Buffer.from(body) }
}

/** A listing page as text, checked by the same status rules as a download. */
async function listPage(url: string): Promise<string> {
  const { status, bytes } = await curl(url)
  checkResponse(status, bytes, url)
  return bytes.toString('utf8')
}

async function listing(pages: number): Promise<ListingItem[]> {
  const items: ListingItem[] = []
  for (let n = 1; n <= pages; n++)
    items.push(
      ...validListing(JSON.parse(await listPage(`${API}&n=${n}`)), (k, why) =>
        console.error(`listing page ${n}: dropped ${k} unusable row(s), first: ${why}`),
      ),
    )
  return items
}

/** A download goes in its own new directory, removed afterwards; nothing in it is executed. */
async function download(url: string) {
  const dir = mkdtempSync(join(process.env.HACKBENCH_FETCH_TMP ?? tmpdir(), 'hack-'))
  try {
    return await curl(url, join(dir, 'download.zip'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  const wanted = process.argv.includes('--id')
    ? String(positiveIntFlag(process.argv, '--id', 1))
    : undefined
  if (wanted && known.has(Number(wanted))) throw new Error(`${wanted} is already in the store`)
  const pages = positiveIntFlag(process.argv, '--pages', process.argv.includes('--list') ? 1 : 3)
  const listed = await listing(pages)
  const missing = candidates(listed, known)
  if (process.argv.includes('--list')) {
    for (const c of missing) console.log(`${c.id}	${c.downloads}	${c.name}`)
    return
  }
  const ids = wanted
    ? [Number(wanted)]
    : missing.slice(0, positiveIntFlag(process.argv, '--count', 1)).map(c => c.id)
  const items = ids.map(id => listed.find(i => i.id === id))
  if (!ids.length || items.some(i => !i))
    throw new Error(
      'nothing to fetch: id not in the listed pages, or all listed hacks are in the store',
    )
  for (const item of items) {
    const fetched = await fetchHack(item!, vanilla, store, download)
    index.hacks.push(fetched.record)
    console.log(fetched.line)
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
