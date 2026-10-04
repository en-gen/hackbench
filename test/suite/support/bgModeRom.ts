/**
 * A 512 KB ROM holding just the three byte runs `readLevelBgMode` pins, at their
 * stock addresses (bank_05.asm:428 and 592-597, bank_00.asm:464-465), so a test
 * can plant, drop or flip each one without a cart.
 */
import { RomFile } from '../../../src/rom/RomFile'

export const SET_AT = 0x058568
export const CALL_AT = 0x0583ac
export const IRQ_AT = 0x0083a8
/** AND #$80, LSR x4, ORA #operand, STA $3E. */
export const setBytes = (operand = 1): number[] => [0x29, 0x80, 0x4a, 0x4a, 0x4a, 0x4a, 0x09, operand, 0x85, 0x3e] // prettier-ignore
/** JSR $84E3, JSR $81FB, LDA LevelModeSetting, CMP #$09, BEQ. */
export const CALL_BYTES = [0x20, 0xe3, 0x84, 0x20, 0xfb, 0x81, 0xad, 0x25, 0x19, 0xc9, 0x09, 0xf0, 0x07] // prettier-ignore
/** LDA $3E, STA $2105. */
export const IRQ_BYTES = [0xa5, 0x3e, 0x8d, 0x05, 0x21]

export type Run = [addr: number, bytes: number[]]

/** The three runs as stock, with `extra` planted after them (a later write wins). */
export function bgModeRom(operand = 1, ...extra: Run[]): RomFile {
  const rom = new RomFile('bg.sfc', Buffer.alloc(0x80000, 0))
  rom.writeAt(0x00ffd5, [0x20]) // the map mode byte `SmwRom` checks
  for (const [addr, bytes] of [
    [SET_AT, setBytes(operand)],
    [CALL_AT, CALL_BYTES],
    [IRQ_AT, IRQ_BYTES],
    ...extra,
  ] as Run[])
    // prettier-ignore
    rom.writeAt(addr, bytes)
  return rom
}
