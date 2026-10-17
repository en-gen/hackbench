/**
 * The synthetic cart's stand-ins for the pointer loader tail (CODE_05D8B7), the level data loader
 * (CODE_05801E) and the Layer 3 handler (CODE_009FB8, bank_00.asm:4870), with the option mutants the level
 * loader tests plant. Split from syntheticSpriteRom.ts to keep that file under the content gate's
 * byte-token limit. Hand-written (test/suite/support/asm65.ts): each routine is the shortest sequence that
 * meets the loader's shape check and leaves the state the tests read, not a copy of the ROM's bytes.
 */
import { long, OP, word } from './asm65'
import { ROW_OF_TILESET } from './syntheticLayer3'
import type { SyntheticOptions } from './syntheticSpriteRom'

export function putLoaderStandIns(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? OP.NOP : b)
  // Pointer loader: the shape the loader checks (REP #$30 / LDA $0E / ASL / CLC / ADC $0E / TAY), then
  // SEP #$30 / LDA #7 -> $1692 and $1A / LDA #irqCommand -> $0D9B / PLB / RTL. The tests patch from $D8C9.
  put(0x05d8b7, [
    bad('pointers', OP.REP), 0x30, OP.LDA_DP, 0x0e, OP.ASL_A, OP.CLC, OP.ADC_DP, 0x0e, OP.TAY,
    OP.SEP, 0x30, OP.LDA_IMM, 7, OP.STA_ABS, ...word(0x1692), OP.STA_DP, 0x1a,
    OP.LDA_IMM, o.irqCommand ?? 0, OP.STA_ABS, ...word(0x0d9b), OP.PLB, OP.RTL,
  ]) // prettier-ignore
  // Data loader: the shape the loader checks (PHP / SEP #$20 / REP #$10 / LDX #0 / LDA #$25 / STA long,X), then
  // LDA #$77 -> $5E (CODE_0584E3 rewrites $5E, bank_05.asm:560, so only a data loader run AFTER the screen
  // setup leaves $77), STZ $5B (ScreenMode, as the header loader rewrites it, bank_05.asm:553: only a Layer 3
  // handler run after it leaves bit 7), then PLP RTL (or COP).
  put(0x05801e, [
    bad('data', OP.PHP), OP.SEP, 0x20, OP.REP, 0x10, OP.LDX_IMM, ...word(0), OP.LDA_IMM, 0x25,
    OP.STA_LONGX, ...long(0x7ec800), OP.LDA_IMM, 0x77, OP.STA_DP, 0x5e, OP.STZ_DP, 0x5b,
    ...(o.loaderCop ? [OP.COP, 0] : [OP.PLP, OP.RTL]),
  ]) // prettier-ignore
  // Layer 3 handler: the row-of-tileset shape the loader checks, then SEP #$20 / LDA #$80 / TSB $5B / RTS:
  // the stand-in for the handler's ScreenMode bit 7.
  put(0x009fb8, [
    bad('layer3', ROW_OF_TILESET[0]), ...ROW_OF_TILESET.slice(1),
    OP.SEP, 0x20, OP.LDA_IMM, 0x80, OP.TSB_DP, 0x5b, OP.RTS,
  ]) // prettier-ignore
}
