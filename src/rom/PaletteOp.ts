/**
 * The op reducer: one 16-bit word write against a byte array, addressed by
 * a 24-bit SNES address. This is the ONE mechanism every palette AND Map16
 * edit goes through - src/project/WorkingRom.ts is the store that sequences
 * these over a layer stack; this module is what actually changes bytes.
 *
 * Originally palette-only (hence the BGR555 name throughout), so every op
 * defaulted to masking bit 15 off - correct for a CGRAM colour, where bit 15
 * is unused. A Map16 tile-attribute word uses all 16 bits (bit 15 is
 * vertical flip), so `Op.mask` is now explicit: omitted, it keeps exactly
 * the old BGR555 behaviour (existing persisted ops files have no `mask`
 * field and must keep reading the same way); `FULL_WORD_MASK` opts a caller
 * into the full 16 bits. The op's shape - `{address, old, new}` - and the
 * write mechanism are unchanged; only the mask is now a parameter instead
 * of a hardcoded constant.
 *
 * Pure in the same sense src/rom/PatchLayer.ts's `applyPatches` is: no I/O,
 * no clock, no randomness, no reading anything off disk. `applyOp` mutates
 * the `out` buffer in place rather than allocating a fresh multi-megabyte
 * copy per op: a layer can hold many ops, and cloning the whole cartridge
 * for each one is wasted work. `out` is always a buffer `WorkingRom.
 * computeBytes` freshly allocated for this one recompute (never the array a
 * `bytes()` caller is holding) - see `WorkingRom.bytes`'s own docstring for
 * what IS and is not safe to do with what it returns.
 */
import { loromToOffset } from './addressing'

/** One 16-bit word write, addressed by the SNES address it targets. */
export interface Op {
  /** 24-bit SNES address, hex string, e.g. "$00B2CE". */
  address: string
  /** The word this op expects to find at `address` before it runs. */
  old: string
  /** The word this op writes. */
  new: string
  /**
   * Which bits actually matter, applied to both the stale-check and the
   * write. Omitted means `BGR555_MASK` (bit 15 ignored) - the default every
   * persisted palette op relies on. Pass `FULL_WORD_MASK` for a word (e.g. a
   * Map16 subtile attribute) where bit 15 is real data, not padding.
   */
  mask?: number
}

export const BGR555_MASK = 0x7fff
/** All 16 bits significant - for a word that is not a BGR555 colour. */
export const FULL_WORD_MASK = 0xffff

/** Parses "$00B2CE" (or "00B2CE") into a plain number. Throws on garbage. */
export function parseHexAddr(s: string): number {
  const m = /^\$?([0-9A-Fa-f]+)$/.exec(s.trim())
  if (!m) throw new Error(`not a hex address: ${JSON.stringify(s)}`)
  return parseInt(m[1], 16)
}

/** A BGR555 word: an integer 0..0xFFFF. Rejected outright, never truncated. */
export function parseBgr555Word(s: string): number {
  const n = parseHexAddr(s)
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) {
    throw new Error(`word out of range 0..0xFFFF: ${JSON.stringify(s)}`)
  }
  return n
}

/** The file offset an op's address resolves to, or null if it is outside the cart. */
export function opFileOffset(op: Op, romSize: number, hasHeader: boolean): number | null {
  return loromToOffset(parseHexAddr(op.address), romSize, hasHeader)
}

export function readBgr555Word(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

/**
 * Writes `op.new`, little-endian, masked by `op.mask` (default `BGR555_MASK`,
 * bit 15 dropped), into `out` at the file offset `op.address` resolves to.
 * Mutates `out` in place; throws (does not write anything) if the address is
 * outside the cart or `op.new` fails `parseBgr555Word`.
 */
export function applyOp(out: Uint8Array, op: Op, romSize: number, hasHeader: boolean): void {
  const offset = opFileOffset(op, romSize, hasHeader)
  if (offset === null) {
    throw new Error(`address ${op.address} is outside the cart`)
  }
  const word = parseBgr555Word(op.new) & (op.mask ?? BGR555_MASK)
  out[offset] = word & 0xff
  out[offset + 1] = (word >> 8) & 0xff
}
