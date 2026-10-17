/**
 * The synthetic cart's stand-ins for the pointer loader (CODE_05D8B7), the level data loader (CODE_05801E)
 * and the Layer 3 handler (CODE_009FB8, bank_00.asm:4870), with the option mutants the level loader tests plant.
 * Split from syntheticSpriteRom.ts to keep that file under the content gate's byte-token limit. Hand-written
 * (test/suite/support/asm65.ts) to leave the state the tests read and to end where the refusal tests patch;
 * they are NOT the ROM's code. The loader pins the first bytes of the first two by fingerprint, and
 * syntheticSpriteRom.ts vouches for this cart's own with markSyntheticRom. The handler is the exception: the
 * loader checks its first eight bytes literally (operands wildcarded), which ROW_OF_TILESET supplies.
 */
import { long, OP, word } from './asm65'
import { ROW_OF_TILESET } from './syntheticLayer3'
import type { SyntheticOptions } from './syntheticSpriteRom'

export function putLoaderStandIns(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? OP.NOP : b)
  // Pointer loader: SEP #$30 / LDA #7 -> $1692 and $1A / record the level number from $0E/$0F in two cells
  // of this cart / LDA #irqCommand -> $0D9B / PLB / RTL. The refusal tests patch from $D8C9 (offset 18).
  put(0x05d8b7, [
    bad('pointers', OP.SEP), 0x30, OP.LDA_IMM, 7, OP.STA_ABS, ...word(0x1692), OP.STA_DP, 0x1a,
    OP.LDA_DP, 0x0e, OP.STA_ABS, ...word(0x1f50), OP.LDA_DP, 0x0f, OP.STA_DP, 0x03,
    OP.LDA_IMM, o.irqCommand ?? 0, OP.STA_ABS, ...word(0x0d9b), OP.PLB, OP.RTL,
  ]) // prettier-ignore
  // Data loader: PHP / SEP #$20 / LDA #$25 -> $7EC800 (Map16 cell 0) / LDA #$77 -> $5E (CODE_0584E3 rewrites
  // $5E, bank_05.asm:560, so only a data loader run AFTER the screen setup leaves $77) / NOPs up to offset 18,
  // where the refusal tests patch ($8030) / STZ $5B (ScreenMode, as the header loader rewrites it,
  // bank_05.asm:553: only a Layer 3 handler run after it leaves bit 7) / PLP RTL (or COP).
  put(0x05801e, [
    bad('data', OP.PHP), OP.SEP, 0x20, OP.LDA_IMM, 0x25, OP.STA_LONG, ...long(0x7ec800),
    OP.LDA_IMM, 0x77, OP.STA_DP, 0x5e, ...new Array(5).fill(OP.NOP), OP.STZ_DP, 0x5b,
    ...(o.loaderCop ? [OP.COP, 0] : [OP.PLP, OP.RTL]),
  ]) // prettier-ignore
  // Layer 3 handler: the row-of-tileset shape the loader checks, then SEP #$20 / LDA #$80 / TSB $5B / RTS:
  // the stand-in for the handler's ScreenMode bit 7.
  put(0x009fb8, [
    bad('layer3', ROW_OF_TILESET[0]), ...ROW_OF_TILESET.slice(1),
    OP.SEP, 0x20, OP.LDA_IMM, 0x80, OP.TSB_DP, 0x5b, OP.RTS,
  ]) // prettier-ignore
}
