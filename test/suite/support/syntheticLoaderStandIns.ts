/**
 * The synthetic cart's stand-ins for the pointer loader tail (CODE_05D8B7), the level data loader
 * (CODE_05801E) and the Layer 3 handler (CODE_009FB8, bank_00.asm:4870), with the option mutants the level
 * loader tests plant. Split from syntheticSpriteRom.ts to keep that file under the content gate's
 * byte-token limit. No ROM-derived bytes: the shapes are the loader's own checks, the rest hand-written.
 */
import type { SyntheticOptions } from './syntheticSpriteRom'

export function putLoaderStandIns(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? 0xea : b)
  // CODE_05D8B7 shape, then SEP #$30 / LDA #7 / STA $1692 / STA $1A / LDA #irqCommand / STA $0D9B / PLB / RTL
  put(0x05d8b7, [bad('pointers', 0xc2), 0x30, 0xa5, 0x0e, 0x0a, 0x18, 0x65, 0x0e, 0xa8, 0xe2, 0x30, 0xa9, 0x07, 0x8d, 0x92, 0x16, 0x85, 0x1a, 0xa9, o.irqCommand ?? 0, 0x8d, 0x9b, 0x0d, 0xab, 0x6b]) // prettier-ignore
  // CODE_05801E shape, STA $7EC800,X, LDA #$77 / STA $5E (CODE_0584E3 rewrites $5E, bank_05.asm:560,
  // so only a data loader run AFTER the screen setup leaves $77), STZ $5B (ScreenMode, as the header loader
  // rewrites it, bank_05.asm:553: only a Layer 3 handler run after it leaves bit 7), then PLP RTL (or COP)
  put(0x05801e, [bad('data', 0x08), 0xe2, 0x20, 0xc2, 0x10, 0xa2, 0x00, 0x00, 0xa9, 0x25, 0x9f, 0x00, 0xc8, 0x7e, 0xa9, 0x77, 0x85, 0x5e, 0x64, 0x5b, ...(o.loaderCop ? [0x02, 0x00] : [0x28, 0x6b])]) // prettier-ignore
  // CODE_009FB8 shape (LDA ObjectTileset / ASL / CLC / ADC ObjectTileset), then SEP #$20 / LDA #$80 / TSB $5B / RTS:
  // the stand-in for the Layer 3 handler's ScreenMode bit 7.
  put(0x009fb8, [bad('layer3', 0xad), 0x31, 0x19, 0x0a, 0x18, 0x6d, 0x31, 0x19, 0xe2, 0x20, 0xa9, 0x80, 0x04, 0x5b, 0x60]) // prettier-ignore
}
