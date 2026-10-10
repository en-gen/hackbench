import { inflateRawSync } from 'zlib'
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

/**
 * SMW Central answers a blocked request with an HTML page (copyright banner or the
 * Cloudflare check). That is a refusal, never something to get around.
 */
export function looksLikeHtml(head: Uint8Array): boolean {
  const text = String.fromCharCode(...head.subarray(0, 64))
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
  sourceZipSha256: string
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
  if (e.usize > MAX_UNPACKED)
    throw new Error(`${e.name}: ${e.usize} bytes unpacked is over the limit`)
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  if (v.getUint32(e.offset, true) !== 0x04034b50) throw new Error(`${e.name}: bad local header`)
  const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true)
  const raw = zip.subarray(start, start + e.csize)
  if (e.method === 0) return raw
  if (e.method === 8) return new Uint8Array(inflateRawSync(raw, { maxOutputLength: MAX_UNPACKED }))
  throw new Error(`${e.name}: unsupported zip method ${e.method}`)
}
