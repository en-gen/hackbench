/**
 * A run of raw cartridge bytes, as an op a WorkingRom layer can carry.
 *
 * src/rom/PaletteOp.ts's `Op` writes a BGR555 WORD and masks bit 15 off,
 * because a palette entry has no bit 15. Graphics bytes do, so a palette op
 * cannot express them: a compressed stream byte of $80 or more would come
 * back as something else, silently, in whichever half of the word it landed.
 *
 * This is the other op shape, and it is deliberately the only other one:
 * the two together are "a colour" and "some bytes", not an open-ended
 * instruction set. Layers carrying these are DERIVED (the GFX arena rewrite)
 * and are not persisted, so nothing cartridge-derived reaches `ops/`. See
 * src/rom/EditStack.ts for why what is stored is the edit, not the bytes.
 */
import { loromToOffset } from './addressing'
import { parseHexAddr } from './PaletteOp'

export interface ByteRunOp {
  /** 24-bit SNES address of the first byte, hex, e.g. "$0BD9F9". */
  address: string
  /** The bytes this op expects to find there, as hex, e.g. "A0FF12". */
  oldBytes: string
  /** The bytes it writes. Must be the same length as `oldBytes`. */
  newBytes: string
}

export function isByteRunOp(op: { address: string }): op is ByteRunOp {
  return typeof (op as ByteRunOp).newBytes === 'string'
}

/** Parses "A0FF12" into bytes. Throws on odd length or non-hex. */
export function parseHexBytes(s: string): Uint8Array {
  const text = s.trim()
  if (text.length % 2 !== 0 || !/^[0-9A-Fa-f]*$/.test(text)) {
    throw new Error(`not a hex byte run: ${JSON.stringify(s)}`)
  }
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function formatHexBytes(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).toUpperCase().padStart(2, '0')
  return s
}

/** The file offset this op's first byte resolves to, or null if it is
 *  outside the cart. The whole run must fit, not only its first byte. */
export function byteRunFileOffset(
  op: ByteRunOp,
  romSize: number,
  hasHeader: boolean,
): number | null {
  const length = parseHexBytes(op.newBytes).length
  const offset = loromToOffset(parseHexAddr(op.address), romSize, hasHeader)
  if (offset === null) return null
  const base = hasHeader ? offset - 512 : offset
  return base + length <= romSize ? offset : null
}

/** Writes `op.newBytes` at `op.address`. Mutates `out` in place. */
export function applyByteRun(
  out: Uint8Array,
  op: ByteRunOp,
  romSize: number,
  hasHeader: boolean,
): void {
  const offset = byteRunFileOffset(op, romSize, hasHeader)
  if (offset === null) throw new Error(`byte run at ${op.address} does not fit in the cart`)
  const bytes = parseHexBytes(op.newBytes)
  if (bytes.length !== parseHexBytes(op.oldBytes).length) {
    throw new Error(`byte run at ${op.address} changes length, which an op cannot do`)
  }
  out.set(bytes, offset)
}
