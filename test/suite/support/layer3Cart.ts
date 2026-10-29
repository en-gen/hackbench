/**
 * A synthetic cart whose pointer loader leaves tileset `ts`, Layer 3 setting `l3` and a marker in both ends of
 * the interaction buffer, with the table-driven handler and tide helper over the cart's bare stand-in. `irq`
 * is the IRQNMICommand the loader leaves in $0D9B.
 */
import { long, OP, word } from './asm65'
import { BUFFER_FIRST, BUFFER_LAST, LAYER3_CELL, putLayer3, TILESET_CELL } from './syntheticLayer3'
import { buildSyntheticRom } from './syntheticSpriteRom'

/** The synthetic pointer loader's LDA #irqCommand, at offset 15 (before its STA $0D9B, PLB, RTL). */
export const POINTER_TAIL = 0x05d8c6

export function layer3Cart(ts: number, l3: number, irq = 0) {
  const rom = buildSyntheticRom()
  rom.writeAt(POINTER_TAIL, [
    ...[OP.LDA_IMM, ts, OP.STA_ABS, ...word(TILESET_CELL)],
    ...[OP.LDA_IMM, l3, OP.STA_ABS, ...word(LAYER3_CELL)],
    ...[OP.LDA_IMM, 0xff, OP.STA_LONG, ...long(BUFFER_FIRST), OP.STA_LONG, ...long(BUFFER_LAST)], // marker in both ends
    ...[OP.LDA_IMM, irq, OP.STA_ABS, ...word(0x0d9b), OP.PLB, OP.RTL],
  ])
  putLayer3((at, bytes) => rom.writeAt(at, bytes))
  return rom
}
