import { isAbsolute, relative, resolve } from 'path'
import { inflateRawSync } from 'zlib'
import { applyBps } from '../../src/rom/Bps'
import { decodeIps } from '../../src/rom/Ips'
/**
 * Pure parts of hack-fetch.ts (#543): listing rows, archive-entry vetting, patch
 * choice and the index record. No network, no files, so CI can test them.
 */
export interface ListingItem {
  id: number
  name: string
  authors: { name: string }[]
  rating: number | null
  rating_count: number
  downloads: number
  download_url: string
  obsoleted_by: unknown
  fields: { version?: string; type?: string; difficulty?: string }
}

export interface Candidate {
  id: number
  name: string
  downloads: number
  url: string
}

/** Listing items not yet in the store, highest downloads first, skipping obsoleted entries. */
export function candidates(items: readonly ListingItem[], known: ReadonlySet<number>): Candidate[] {
  return items
    .filter(i => !known.has(i.id) && !i.obsoleted_by && i.download_url)
    .map(i => ({ id: i.id, name: i.name, downloads: i.downloads, url: i.download_url }))
    .sort((a, b) => b.downloads - a.downloads)
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Listing rows that are safe to dereference: ids become directory and file names, so only a
 * positive integer passes, and the download link must be https. Others are dropped.
 */
export function validListing(page: unknown): ListingItem[] {
  if (!isRecord(page) || !Array.isArray(page.data)) throw new Error('listing has no data array')
  return page.data.filter((r): r is ListingItem => {
    if (!isRecord(r) || !Number.isSafeInteger(r.id) || (r.id as number) <= 0) return false
    return (
      typeof r.name === 'string' &&
      Array.isArray(r.authors) &&
      r.authors.every(a => isRecord(a) && typeof a.name === 'string') &&
      typeof r.downloads === 'number' &&
      typeof r.rating_count === 'number' &&
      (r.rating === null || typeof r.rating === 'number') &&
      typeof r.download_url === 'string' &&
      r.download_url.startsWith('https://') &&
      isRecord(r.fields)
    )
  })
}

/** index.json as text: parses, holds a hacks array, and every record carries a numeric smwc_id. */
export function readIndex(text: string): { hacks: Record<string, unknown>[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('index.json is not valid JSON')
  }
  if (!isRecord(raw) || !Array.isArray(raw.hacks)) throw new Error('index.json has no hacks array')
  for (const h of raw.hacks) {
    if (!isRecord(h)) throw new Error('index.json holds a hacks entry that is not a record')
    if (typeof h.smwc_id !== 'number')
      throw new Error('index.json holds a record without a numeric smwc_id')
  }
  return raw as { hacks: Record<string, unknown>[] }
}

/** Value of a flag: undefined when absent, an error when it has no value of its own. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  if (at < 0) return undefined
  const v = argv[at + 1]
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}

/** True when the store would sit inside the repository, where git could pick up its ROMs. */
export function storeInsideRepo(store: string, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(store))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Last path part of an archive entry, whichever separator it uses; null when nothing safe is left. */
export function patchBasename(entry: string): string | null {
  const name = entry.split(/[\\/]/).pop() ?? ''
  return name === '' || name === '.' || name === '..' ? null : name
}

/** HTTPS only, in and after redirects; -f turns an HTTP error (429 included) into a failure. */
export function curlArgs(url: string, out?: string): string[] {
  return [
    '-s',
    '-S',
    '-f',
    '-L',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '-m',
    '120',
    '--max-filesize',
    '104857600',
    ...(out ? ['-o', out] : []),
    url,
  ]
}

/** SMW Central blocked the request; the one error that stops the whole run. */
export class HtmlStop extends Error {}

const MAX_ROM = 0x1000000 // the same 16 MiB limit as src/rom/Bps.ts

/** The patched ROM, or the reason the patch was refused. */
export function applyPatch(
  vanilla: Uint8Array,
  patch: Uint8Array,
  format: string,
): Uint8Array | string {
  if (format === 'bps') {
    const r = applyBps(vanilla, patch)
    return r.ok ? r.bytes : r.reason.slice(0, 200)
  }
  const records = decodeIps(patch)
  if (!records) return 'decodeIps refused the patch'
  let end = vanilla.length
  for (const p of records) end = Math.max(end, p.offset + 1)
  if (end > MAX_ROM) return `IPS record ends past the 16 MiB limit (${end} bytes)`
  const out = new Uint8Array(end)
  out.set(vanilla)
  for (const p of records) out[p.offset] = p.value
  return out
}

export interface ArchiveResult {
  failure: string | null
  format: 'bps' | 'ips' | null
  patch: { name: string; bytes: Uint8Array } | null
  rom: Uint8Array | null
}

/** What fetchOne decides about a downloaded zip, with no network and no files: a failure is a value. */
export function processArchive(zip: Uint8Array, vanilla: Uint8Array): ArchiveResult {
  const none = (failure: string): ArchiveResult => ({
    failure,
    format: null,
    patch: null,
    rom: null,
  })
  try {
    const entries = zipEntries(zip).filter(e => !e.name.endsWith('/'))
    const bad = entries.find(e => unsafeEntry(e.name))
    if (bad) return none(`unsafe archive entry ${bad.name}`)
    const choice = pickPatch(entries.map(e => e.name))
    if (!choice.ok) return none(choice.reason)
    const bytes = zipRead(
      zip,
      entries.find(e => e.name === choice.file)!,
    )
    const name = patchBasename(choice.file)
    if (!name) return none(`unusable patch name ${choice.file}`)
    const rom = applyPatch(vanilla, bytes, choice.format)
    const patch = { name, bytes }
    if (typeof rom === 'string')
      return {
        failure: `${choice.format} apply failed: ${rom}`,
        format: choice.format,
        patch,
        rom: null,
      }
    return { failure: null, format: choice.format, patch, rom }
  } catch (e) {
    return none(e instanceof Error ? e.message : String(e))
  }
}

/**
 * SMW Central answers a blocked request with an HTML page (copyright banner or the
 * Cloudflare check). That is a refusal, never something to get around.
 */
export function looksLikeHtml(head: Uint8Array): boolean {
  // A UTF-8 byte-order mark in front of the markup must not hide it.
  const start = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0
  const text = String.fromCharCode(...head.subarray(start, start + 64))
    .trimStart()
    .toLowerCase()
  return text.startsWith('<')
}

/** A zip entry that could land outside its extraction directory. */
export function unsafeEntry(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  return p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').includes('..')
}

export type PatchChoice =
  { ok: true; file: string; format: 'bps' | 'ips' } | { ok: false; reason: string }

/** Exactly one .bps or .ips in the archive; anything else is recorded as a failure, not guessed. */
export function pickPatch(files: readonly string[]): PatchChoice {
  const patches = files.filter(f => /\.(bps|ips)$/i.test(f))
  if (patches.length === 0) return { ok: false, reason: 'no .bps or .ips in the archive' }
  if (patches.length > 1)
    return { ok: false, reason: `${patches.length} patch files: ${patches.join(', ')}` }
  const file = patches[0]!
  return { ok: true, file, format: file.toLowerCase().endsWith('.bps') ? 'bps' : 'ips' }
}

export interface Provenance {
  item: ListingItem
  patchSha256: string | null
  patchFormat: string | null
  sourceZipSha256: string | null
  patchedRomSha256: string | null
  patchedRomSize: number | null
  baseRomSha256: string
  failure: string | null
  date: string
}

/** One index.json record, in the shape of the 99 entries the 2026-09-26 build wrote. */
export function indexRecord(p: Provenance): Record<string, unknown> {
  const i = p.item
  return {
    smwc_id: i.id,
    name: i.name,
    authors: i.authors.map(a => a.name),
    version: i.fields.version ?? '',
    smwc_type: i.fields.type ?? '',
    rating: i.rating,
    rating_count: i.rating_count,
    downloads: i.downloads,
    difficulty: i.fields.difficulty ?? '',
    patch_url: i.download_url,
    patch_format: p.patchFormat,
    patch_result: p.failure ? 'failed' : 'success',
    patch_sha256: p.patchSha256,
    source_zip_sha256: p.sourceZipSha256,
    base_rom_sha256: p.baseRomSha256,
    patched_rom_file: p.failure ? null : `roms/${i.id}.sfc`,
    patched_rom_sha256: p.patchedRomSha256,
    patched_rom_size: p.patchedRomSize,
    ...(p.failure ? { failure_reason: p.failure } : {}),
    date_processed: p.date,
  }
}

export interface ZipEntry {
  name: string
  method: number
  csize: number
  usize: number
  offset: number
}

const MAX_ENTRIES = 5000
const MAX_UNPACKED = 256 * 1024 * 1024

/** Central-directory listing of a zip, without unpacking anything. Throws on a malformed archive. */
export function zipEntries(zip: Uint8Array): ZipEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  if (count > MAX_ENTRIES) throw new Error(`zip lists ${count} entries`)
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || v.getUint32(p, true) !== 0x02014b50)
      throw new Error('bad central directory')
    const nameLen = v.getUint16(p + 28, true)
    const extra = v.getUint16(p + 30, true) + v.getUint16(p + 32, true)
    // The whole record, name and extra and comment fields included, must lie inside the archive.
    if (p + 46 + nameLen + extra > zip.length) throw new Error('bad central directory')
    out.push({
      name: new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen)),
      method: v.getUint16(p + 10, true),
      csize: v.getUint32(p + 20, true),
      usize: v.getUint32(p + 24, true),
      offset: v.getUint32(p + 42, true),
    })
    p += 46 + nameLen + extra
  }
  return out
}

/** Bytes of one entry (stored or deflate only). The caller has already vetted the name. */
export function zipRead(zip: Uint8Array, e: ZipEntry): Uint8Array {
  // A stored entry is returned as is, so its csize is the size that matters there.
  const size = e.method === 0 ? Math.max(e.usize, e.csize) : e.usize
  if (size > MAX_UNPACKED) throw new Error(`${e.name}: ${size} bytes unpacked is over the limit`)
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  if (e.offset + 30 > zip.length) throw new Error(`${e.name}: entry range is outside the archive`)
  if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`${e.name}: bad local header`)
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true)
  if (start + e.csize > zip.length) throw new Error(`${e.name}: entry range is outside the archive`)
  const raw = zip.subarray(start, start + e.csize)
  if (e.method === 0) return raw
  if (e.method === 8) return new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED }))
  throw new Error(`${e.name}: unsupported zip method ${e.method}`)
}
