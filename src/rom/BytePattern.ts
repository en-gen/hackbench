/**
 * Locating a routine by the bytes it is made of, rather than by where it sits.
 *
 * A hack that relocates a routine still contains the same instruction
 * sequence somewhere, while a fixed address in a relocated routine lands
 * mid-instruction and yields a plausible wrong answer. Reading the title
 * screen at its vanilla $00:96CC on Invictus returns $C8 with full
 * confidence, because a JML has replaced the routine there.
 *
 * More than one match is not a match. Two candidate sites means we cannot
 * say which one the game runs, and picking the first would be a guess
 * dressed as a reading. Callers are expected to treat a length other than 1
 * as unavailable; `limit` exists so a caller that only needs to know whether
 * the count exceeds 1 does not scan the rest of a 4 MB cart.
 *
 * Offsets are CART-RELATIVE, the same thing `RomFile.readAtFileOffset` takes.
 * The copier header is skipped, not scanned: it is not code, and a byte run
 * in it that happened to match would make a real, unique load site look
 * ambiguous and lose it.
 */
import { RomFile } from './RomFile'
import { COPIER_HEADER_SIZE } from './addressing'

/** Matches any byte in that position: the operand we are here to read. */
export const WILD = -1

/** A byte run with WILD in the positions that vary. */
export type BytePattern = readonly number[]

/**
 * Cart-relative file offsets of every match for `pattern`, ascending.
 *
 * @param limit  Stop after this many matches. Unbounded by default; pass it
 *               only where the count itself is the verdict.
 */
export function findPattern(rom: RomFile, pattern: BytePattern, limit = Infinity): number[] {
  const base = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  return findInBytes(rom.buffer, pattern, base, base + rom.romSize, limit).map(at => at - base)
}

/** The bytes at cart-relative `at` when they match `p`, else null. */
export function matchesAt(rom: RomFile, at: number, p: BytePattern): Buffer | null {
  const bytes = rom.readAtFileOffset(at, p.length)
  return bytes && p.every((b, i) => b === WILD || bytes[i] === b) ? bytes : null
}

/**
 * The same scan over a plain byte range, for buffers that are not a cart.
 *
 * SfxTables searches an ARAM image rather than a ROM: same nested loop,
 * same wildcard, no copier header and no cart-relative convention to
 * apply. Offsets returned are absolute within `bytes`.
 */
export function findInBytes(
  bytes: Uint8Array,
  pattern: BytePattern,
  lo: number,
  hi: number,
  limit = Infinity,
): number[] {
  const hits: number[] = []
  const last = hi - pattern.length

  for (let at = lo; at <= last; at++) {
    let ok = true
    for (let k = 0; k < pattern.length; k++) {
      if (pattern[k] !== WILD && bytes[at + k] !== pattern[k]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    hits.push(at)
    if (hits.length >= limit) break
  }
  return hits
}
