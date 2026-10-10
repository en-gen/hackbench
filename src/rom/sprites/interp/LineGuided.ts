/**
 * Whether a cart's line-guided grinder ($67) still has the vanilla order: its MAIN draws, and only
 * then runs the line step that snaps it onto the track. A hack that rewrites the handler gets the
 * runner's generic rule instead, so nothing here is a claim about a cart it has not read.
 */
import type { RomFile } from '../../RomFile'

/** null matches any byte (operands that name a label or a constant). */
type Shape = readonly (number | null)[]

/**
 * LineGrinder (SMWDisX bank_01.asm:11837-11846) to its `JMP CODE_01D9A7`: LDA TrueFrame / AND #7 /
 * ORA SpriteMisc1626,X / ORA SpriteLock / BNE / LDA #sfx / STA SPCIO1 / JMP.
 */
const ENTRY: Shape = [0xa5, 0x13, 0x29, 0x07, 0x1d, 0x26, 0x16, 0x05, 0x9d, 0xd0, null, 0xa9, null, 0x8d, null, null, 0x4c] // prettier-ignore

/**
 * CODE_01D9A7 (bank_01.asm:12182-12204) for sprite $67: the number tests ($64, $65, $68), the CMP #$67
 * arm, JSR CODE_01DC0B (the draw, offset 23), JSR MarioSprInteractRt (26), BRA to the `+` (29), the
 * other arm (31-37) and `+ JMP CODE_01D74D` (38), the line step.
 */
const DISPATCH: Shape = [0xb5, 0x9e, 0xc9, 0x64, 0xf0, null, 0xc9, 0x65, 0x90, null, 0xc9, 0x68, 0xd0, null, 0x20, null, null, 0x80, null, 0xc9, 0x67, 0xd0, null, 0x20, null, null, 0x20, null, null, 0x80, 0x07, 0x20, null, null, 0x22, null, null, null, 0x4c] // prettier-ignore

const matches = (b: Uint8Array, shape: Shape): boolean =>
  b.length >= shape.length && shape.every((v, i) => v === null || b[i] === v)

/** `handler`: the 24-bit address the ROM's own MAIN pointer table gives for $67. */
export function grinderDrawsBeforeSnap(rom: RomFile, handler: number): boolean {
  const entry = rom.readAt(handler, ENTRY.length + 2)
  if (!entry || !matches(entry, ENTRY)) return false
  const target = (handler & 0xff0000) | entry[ENTRY.length]! | (entry[ENTRY.length + 1]! << 8)
  const body = rom.readAt(target, DISPATCH.length)
  return !!body && matches(body, DISPATCH)
}
