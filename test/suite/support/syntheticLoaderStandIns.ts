/**
 * The synthetic cart's stand-ins for the pointer loader (CODE_05D8B7), the level data loader (CODE_05801E),
 * the Layer 3 reset (CODE_05BE8A) and the Layer 3 handler (CODE_009FB8, bank_00.asm:4870), with the option
 * mutants the level loader tests plant. Split from syntheticSpriteRom.ts to keep that file under the content
 * gate's byte-token limit. Hand-written (test/suite/support/asm65.ts) to leave the state the tests read and
 * to end where the refusal tests patch; they are NOT the ROM's code. The loader checks single instructions of
 * the first two, the reset's opening PHB, the handler's opening load and the GM12 call site (syntheticGm11Spans.ts)
 * the same way (LevelLoader.ts loaderSites).
 */
import { long, OP, word } from './asm65'
import { ROW_OF_TILESET } from './syntheticLayer3'
import type { SyntheticOptions } from './syntheticSpriteRom'

export function putLoaderStandIns(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? OP.NOP : b)
  // Pointer loader: REP #$20 (checked) / LDA $10 (the level number cell, checked at +2, not the game's) / NOP /
  // CLC (checked at +5) / SEP #$30 / LDA #7 -> $1692 and $1A / then, at offset 15, where the refusal tests
  // patch ($D8C6): LDA #irqCommand -> $0D9B / PLB / RTL.
  put(0x05d8b7, [
    bad('pointers', OP.REP), 0x20, OP.LDA_DP, 0x10, OP.NOP, OP.CLC, OP.SEP, 0x30, OP.LDA_IMM, 7,
    OP.STA_ABS, ...word(0x1692), OP.STA_DP, 0x1a,
    OP.LDA_IMM, o.irqCommand ?? 0, OP.STA_ABS, ...word(0x0d9b), OP.PLB, OP.RTL,
  ]) // prettier-ignore
  // Data loader: PHP (checked) / SEP #$20 / LDA #$25 -> $7EC800 (Map16 cell 0) / LDA #$77 -> $62 (the screen
  // setup stub stores $21 there, so only a data loader run AFTER the screen setup leaves $77) / STZ $5B
  // (ScreenMode, as the header loader rewrites it, bank_05.asm:553: only a Layer 3 handler run after it
  // leaves bit 7) / NOPs up to offset 18, where the refusal tests patch ($8030) / PLP RTL (or COP).
  put(0x05801e, [
    bad('data', OP.PHP), OP.SEP, 0x20, OP.LDA_IMM, 0x25, OP.STA_LONG, ...long(0x7ec800),
    OP.LDA_IMM, 0x77, OP.STA_DP, 0x62, OP.STZ_DP, 0x5b, ...new Array(3).fill(OP.NOP),
    ...(o.loaderCop ? [OP.COP, 0] : [OP.PLP, OP.RTL]),
  ]) // prettier-ignore
  // Layer 3 reset (CODE_05BE8A's stand-in): PHB (checked) / REP #$20 / LDA $1C / STA $24 / PLB / SEP #$20 / RTL, so
  // $24/$25 read Layer1YPos.
  put(0x05be8a, [
    bad('reset', 0x8b), OP.REP, 0x20, OP.LDA_DP, 0x1c, OP.STA_DP, 0x24, OP.PLB, OP.SEP, 0x20, OP.RTL,
  ]) // prettier-ignore
  // Layer 3 handler: LDA ObjectTileset (the opening load the loader checks) / ASL / CLC / ADC ObjectTileset, then SEP #$20 / LDA #$80 / TSB $5B / LDA #$40 /
  // STA $24 / RTS: the stand-in for the handler's ScreenMode bit 7 and for its write of Layer3YPos (the reset
  // runs before it, so $40 is the last write).
  put(0x009fb8, [
    bad('layer3', ROW_OF_TILESET[0]), ...ROW_OF_TILESET.slice(1),
    OP.SEP, 0x20, OP.LDA_IMM, 0x80, OP.TSB_DP, 0x5b, OP.LDA_IMM, 0x40, OP.STA_DP, 0x24, OP.RTS,
  ]) // prettier-ignore
}
