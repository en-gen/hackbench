/**
 * The synthetic cart's stand-in for CODE_009FB8 (Layer 3 handling, bank_00.asm:4870) and its
 * tide helper CODE_00A045 (bank_00.asm:4219-4238), written for the test and not copied from the
 * ROM: the same effect (a tide sets ScreenMode bit 7 and clears the interaction buffer, anything
 * else is left alone) by the shortest instruction sequence that does it. The loader byte-checks only
 * the handler's first eight bytes, with the two operands wildcarded, so the cells are this cart's own.
 * Table: tileset 0 = [1, 2, $C0], tileset 1 = [1, $80, $81], the Layer3TilemapSettings layout
 * (bank_00.asm:4121): below $80 is a tide, $80 and up is not.
 */
import { long, OP, word } from './asm65'

export const LAYER3_TABLE_AT = 0x009f88
export const LAYER3_AT = 0x009fb8
export const TIDE_HELPER_AT = 0x00a045
/** The cells the stand-in reads for the tileset and the Layer 3 setting (this cart's own, not the game's). */
export const TILESET_CELL = 0x1f40
export const LAYER3_CELL = 0x1f41
/** The first and last byte of the interaction buffer the helper clears ($7E:E400, $7E:FDFE). */
export const BUFFER_FIRST = 0x7ee400
export const BUFFER_LAST = 0x7efdfe

/** LDA tileset / ASL / CLC / ADC tileset: tileset * 3, the lookup row (the shape the loader checks). */
export const ROW_OF_TILESET: readonly number[] = [
  OP.LDA_ABS, ...word(TILESET_CELL), OP.ASL_A, OP.CLC, OP.ADC_ABS, ...word(TILESET_CELL),
] // prettier-ignore

/** Row + (setting - 1) indexes the table; a setting of 0 or a negative entry skips the helper. */
const TABLE_WALK: readonly number[] = [
  OP.STA_DP, 0x02,
  OP.LDA_ABS, ...word(LAYER3_CELL),
  OP.BEQ, 13,
  OP.DEC_A, OP.CLC, OP.ADC_DP, 0x02, OP.TAX,
  OP.LDA_ABSX, ...word(LAYER3_TABLE_AT),
  OP.BMI, 3,
  OP.JSR, ...word(TIDE_HELPER_AT),
  OP.RTS,
] // prettier-ignore

/** Zero both ends of the buffer (a marker at either shows the clear) and set ScreenMode bit 7. */
const TIDE_HELPER: readonly number[] = [
  OP.SEP, 0x30,
  OP.LDA_IMM, 0,
  OP.STA_LONG, ...long(BUFFER_FIRST),
  OP.STA_LONG, ...long(BUFFER_LAST),
  OP.LDA_IMM, 0x80,
  OP.TSB_DP, 0x5b,
  OP.RTS,
] // prettier-ignore

export function putLayer3(put: (snes: number, bytes: number[]) => void): void {
  put(LAYER3_TABLE_AT, [1, 2, 0xc0, 1, 0x80, 0x81])
  put(LAYER3_AT, [...ROW_OF_TILESET, ...TABLE_WALK])
  put(TIDE_HELPER_AT, [...TIDE_HELPER])
}
