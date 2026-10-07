/**
 * The synthetic cart's stand-ins for what GM11LoadLevel runs between the entrance setup and the
 * level data call (bank_00.asm:2652-2656): CODE_00A796 and UpdateScreenPosition, with the option
 * mutants the level loader tests plant. Split from syntheticSpriteRom.ts to keep that file under
 * the content gate's byte-token limit. No ROM-derived bytes: the shapes are the loader's own checks.
 */
import type { SyntheticOptions } from './syntheticSpriteRom'

export function putGm11Spans(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? 0xea : b)
  // CODE_00A796 shape, then SEP #$20 / RTS. UpdateScreenPosition shape, then SEP #$20 / LDA $1462
  // (the copied $1A: proves the pointer loader and the copy ran first) / STA $1E / LDA $71 (the
  // entrance setup's) / STA $20 / PLB / RTL.
  put(0x00a796, [bad('scroll', 0xc2), 0x20, 0xac, 0x13, 0x14, 0xf0, 0x03, 0x88, o.badLoader === 'scrollTail' ? 0xea : 0xd0, 0x00, ...(o.badLoader === 'scrollPop' ? [0x68, 0x68, 0x68, 0x48, 0x48, 0x4c, 0x0f, 0x97] : [0xe2, 0x20, o.badLoader === 'scrollRtl' ? 0x6b : 0x60])]) // prettier-ignore
  const upd = [bad('update', 0x8b), 0x4b, 0xab, 0xc2, 0x20, 0xad, 0x2a, 0x14, o.badLoader === 'updateTail' ? 0xea : 0x38, 0xe9, 0x0c, 0x00, 0x8d, 0x2c, 0x14, 0xe2, 0x20, 0xad, 0x62, 0x14, 0x85, 0x1e, 0xad, 0x71, 0x00, 0x85, 0x20, 0xab, o.badLoader === 'updateRts' ? 0x60 : 0x6b] // prettier-ignore
  put(0x00f6db, upd)
  // A hack hook as the real ones are (10186, 5559, 6593 at $1F:B182): JML at $F6E4 over SBC #$000C and
  // STA $142C; the target redoes both, copies $1A-$21 to $7F:831F (word moves, X = 6..0), and JMLs back
  // to $00:F6EA, the instruction after the STA.
  if (o.updateHook) {
    put(0x00f6e4, [0x5c, 0x00, 0xf0, 0x05])
    const redo = [0xe9, 0x0c, 0x00, 0x8d, 0x2c, 0x14]
    const copy = [
      0x48, 0xa2, 0x06, 0xb5, 0x1a, 0x9f, 0x1f, 0x83, 0x7f, 0xca, 0xca, 0x10, 0xf6, 0x68,
    ]
    put(0x05f000, o.updateHook === 'loop' ? [0x80, 0xfe] : o.updateHook === 'rts' ? [...redo, 0xab, 0x60] : [...redo, ...copy, 0x5c, 0xea, 0xf6, 0x00]) // prettier-ignore
  }
}
