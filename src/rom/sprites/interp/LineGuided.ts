/**
 * Whether a cart's line-guided grinder ($67) still dispatches in the vanilla order: draw, then the
 * line step. A hack that rewrites the handler gets the runner's generic rule. The gate reads the
 * dispatch shape (opcodes and the branches inside it), not the routines it calls.
 */
import type { RomFile } from '../../RomFile'
import { fingerprint } from '../../Fingerprint'

/** LineGrinder to its JMP (SMWDisX bank_01.asm:11837-11846), under the ~32-byte literal limit; null = free operand. */
const ENTRY: readonly (number | null)[] = [0xa5, 0x13, 0x29, 0x07, 0x1d, 0x26, 0x16, 0x05, 0x9d, 0xd0, 0x05, 0xa9, null, 0x8d, null, null, 0x4c] // prettier-ignore

/** Offsets of ENTRY's pinned bytes (the rest are operands that name a constant or a register). */
export const ENTRY_PINNED = ENTRY.flatMap((v, i) => (v === null ? [] : [i]))

/**
 * CODE_01D9A7's $67 arm, 41 bytes (bank_01.asm:12182-12204), is over the literal limit
 * (docs/rom/level-table-gate.md), so it is pinned as the SHA-256 of the span with these operand
 * offsets zeroed: the JSR/JSL/JMP targets and the two branches that leave the span. Branches that stay
 * inside it (13, 18, 22) are hashed, so the draw JSR (23) stays ahead of the JMP to the line step (38).
 */
export const DISPATCH_LEN = 41
export const DISPATCH_OPERANDS: readonly number[] = [5, 9, 15, 16, 24, 25, 27, 28, 32, 33, 35, 36, 37, 39, 40] // prettier-ignore
export const DISPATCH_PINNED = Array.from({ length: DISPATCH_LEN }, (_, i) => i).filter(
  i => !DISPATCH_OPERANDS.includes(i),
)

/** Vanilla's masked-span digest, from the unmodified US ROM (one cart). */
export const VANILLA_DISPATCH_SHA =
  '75b5f1f4e0388d88ee79255d53b610623edfb734405f6ce1544dfe5503af57c7'

export function dispatchDigest(span: Uint8Array | null): string | null {
  if (!span || span.length < DISPATCH_LEN) return null
  const masked = Uint8Array.from(span.subarray(0, DISPATCH_LEN))
  for (const i of DISPATCH_OPERANDS) masked[i] = 0
  return fingerprint(masked)
}

/** `handler`: the 24-bit address from the ROM's own MAIN pointer table for $67; `sha`: the dispatch digest to accept. */
export function grinderDrawsBeforeSnap(
  rom: RomFile,
  handler: number,
  sha = VANILLA_DISPATCH_SHA,
): boolean {
  const entry = rom.readAt(handler, ENTRY.length + 2)
  if (!entry || ENTRY_PINNED.some(i => entry[i] !== ENTRY[i])) return false
  const target = (handler & 0xff0000) | entry[ENTRY.length]! | (entry[ENTRY.length + 1]! << 8)
  return dispatchDigest(rom.readAt(target, DISPATCH_LEN)) === sha
}
