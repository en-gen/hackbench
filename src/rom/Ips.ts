/**
 * IPS, the standard ROM patch format, as read and written by HackBench.
 *
 * An edit layer is stored as one of these: a real patch file that applies to
 * the base ROM with any patcher, not just with this tool. That is the whole
 * point of the format choice. HackBench stacks them in order, but nothing
 * about a layer requires HackBench to exist.
 *
 * Layout, big-endian throughout:
 *   "PATCH"
 *   records, each:  offset (3 bytes) | size (2 bytes) | size bytes of data
 *                   or, when size is 0, an RLE record:
 *                   offset (3) | 0x0000 | run length (2) | one byte
 *   "EOF"
 *
 * Consequences of the format, both of which callers must respect:
 *
 * - Offsets are 24-bit, so it cannot describe a ROM past 16 MB. Fine for SNES.
 * - The literal offset $454F46 cannot be written, because those three bytes
 *   read as "EOF" and a decoder stops there. Encoding refuses rather than
 *   producing a file that silently truncates.
 */
import { Patch } from './PatchLayer'

const MAGIC = [0x50, 0x41, 0x54, 0x43, 0x48] // "PATCH"
const EOF_MARKER = [0x45, 0x4f, 0x46] // "EOF"
const EOF_AS_OFFSET = 0x454f46
const MAX_OFFSET = 0xffffff
const MAX_RECORD = 0xffff
// Record headers address 24-bit offsets (16 MiB); a patch writing more bytes than that is overlapping or runaway data.
const MAX_DECODED_WRITES = 1 << 24

/** Consecutive patches collapse into one record; this is where that happens. */
function toRuns(patches: readonly Patch[]): { offset: number; bytes: number[] }[] {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset)
  const runs: { offset: number; bytes: number[] }[] = []
  for (const p of sorted) {
    const last = runs[runs.length - 1]
    // Later duplicates of the same offset win, matching flatten().
    if (last && p.offset === last.offset + last.bytes.length - 1) {
      last.bytes[last.bytes.length - 1] = p.value
    } else if (
      last &&
      p.offset === last.offset + last.bytes.length &&
      last.bytes.length < MAX_RECORD
    ) {
      last.bytes.push(p.value)
    } else {
      runs.push({ offset: p.offset, bytes: [p.value] })
    }
  }
  return runs
}

export function encodeIps(patches: readonly Patch[]): Uint8Array {
  const out: number[] = [...MAGIC]
  for (const run of toRuns(patches)) {
    if (run.offset < 0 || run.offset > MAX_OFFSET) {
      throw new RangeError(`IPS cannot address offset ${run.offset}; limit is 16 MB`)
    }
    if (run.offset === EOF_AS_OFFSET) {
      // Writable in principle by splitting the run, but a patch that lands
      // here at all is so surprising that guessing is worse than refusing.
      throw new RangeError(
        'IPS cannot start a record at offset $454F46; it reads as the EOF marker',
      )
    }
    out.push((run.offset >> 16) & 0xff, (run.offset >> 8) & 0xff, run.offset & 0xff)
    out.push((run.bytes.length >> 8) & 0xff, run.bytes.length & 0xff)
    out.push(...run.bytes)
  }
  out.push(...EOF_MARKER)
  return Uint8Array.from(out)
}

/**
 * Read an IPS back into patches.
 *
 * Returns null for anything malformed rather than partial results. A patch
 * decoded halfway would apply halfway, and a half-applied ROM looks like a
 * mysterious rendering bug rather than a corrupt file. Records that would
 * expand past `budget` writes are rejected the same way, before expansion.
 * `budget` exists for tests; it must be a non-negative safe integer.
 */
export function decodeIps(bytes: Uint8Array, budget = MAX_DECODED_WRITES): Patch[] | null {
  if (!Number.isSafeInteger(budget) || budget < 0)
    throw new RangeError('IPS budget must be a non-negative safe integer')
  if (bytes.length < MAGIC.length + EOF_MARKER.length) return null
  if (!MAGIC.every((b, i) => bytes[i] === b)) return null

  // Pass 1 validates and totals without expanding; pass 2 expands once it is known to fit.
  const records: { offset: number; length: number; at: number; rle: boolean }[] = []
  let i = MAGIC.length
  let writes = 0
  for (;;) {
    if (i + 3 > bytes.length) return null
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x4f && bytes[i + 2] === 0x46) break

    if (i + 5 > bytes.length) return null
    const offset = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    const size = (bytes[i + 3] << 8) | bytes[i + 4]
    i += 5

    if (size === 0) {
      // RLE record: run length, then the single byte to repeat.
      if (i + 3 > bytes.length) return null
      const length = (bytes[i] << 8) | bytes[i + 1]
      if (length === 0 || (writes += length) > budget) return null
      records.push({ offset, length, at: i + 2, rle: true })
      i += 3
    } else {
      if (i + size > bytes.length || (writes += size) > budget) return null
      records.push({ offset, length: size, at: i, rle: false })
      i += size
    }
  }

  const patches: Patch[] = []
  for (const r of records) {
    for (let n = 0; n < r.length; n++) {
      patches.push({ offset: r.offset + n, value: bytes[r.rle ? r.at : r.at + n] })
    }
  }
  return patches
}
