/**
 * The synthetic cart's stand-ins for what GM11LoadLevel runs between the entrance setup and the
 * level data call (bank_00.asm:2652-2656): CODE_00A796 and UpdateScreenPosition, with the option
 * mutants the level loader tests plant. Split from syntheticSpriteRom.ts to keep that file under
 * the content gate's byte-token limit. No ROM-derived bytes: the checked sites are single instructions and
 * the hook is hand-written.
 */
import type { SyntheticOptions } from './syntheticSpriteRom'

/** Puts the cart's CODE_00A796 and UpdateScreenPosition stand-ins, and the optional hook, through `put`. */
export function putGm11Spans(
  put: (snes: number, bytes: number[]) => void,
  o: SyntheticOptions,
): void {
  const bad = (k: string, b: number) => (o.badLoader === k ? 0xea : b)
  // GM12PrepLevel's call site of the Layer 3 handler (bank_00.asm:4861-4870), 23 bytes the loader never runs (it calls
  // the reset and the handler itself) but checks instruction by instruction: LDA $0D9B / BPL over the skip, onto the
  // JSR at +10 / JSR / BRA / JSR / JSR / JSL reset (target not compared) / JSR handler. The other operands are arbitrary.
  put(0x00a5af, [
    bad('gm12', 0xad), 0x9b, 0x0d, o.badLoader === 'gm12Bpl' ? 0x30 : 0x10, 0x05, 0x20, 0x34, 0x12, 0x80, 0x16,
    0x20, 0x56, 0x34, 0x20, 0x78, 0x56, 0x22, 0x8a, 0xbe, 0x05,
    0x20, ...(o.badLoader === 'gm12Jsr' ? [0xb9, 0x9f] : [0xb8, 0x9f]),
  ]) // prettier-ignore
  // Hand-written stand-ins for CODE_00A796 and UpdateScreenPosition (the loader runs them, it does not compare
  // them). A796: REP #$20, LDA #$0003, a countdown, SEP #$20, RTS. UpdateScreenPosition: REP #$20, SEC, PHB PHK PLB,
  // LDA $142A, then the hook site (SBC #$000C / STA $142C) and SEP #$20 / LDA $1462 (the
  // copied $1A: proves the pointer loader and the copy ran first) / STA $1E / LDA $71 (the entrance
  // setup's) / STA $20 / PLB / RTL.
  put(0x00a796, [bad('scroll', 0xc2), 0x20, 0xa9, 0x03, 0x00, 0x3a, 0xd0, o.badLoader === 'scrollTail' ? 0xea : 0xfd, ...(o.badLoader === 'scrollPop' ? [0x68, 0x68, 0x68, 0x48, 0x48, 0x4c, 0x0f, 0x97] : [0xe2, 0x20, o.badLoader === 'scrollRtl' ? 0x6b : 0x60])]) // prettier-ignore
  const upd = [bad('update', 0xc2), 0x20, 0x38, 0x8b, 0x4b, 0xab, 0xad, o.badLoader === 'updateOperand' ? 0x74 : 0x2a, o.badLoader === 'updateTail' ? 0xea : 0x14, 0xe9, 0x0c, 0x00, 0x8d, 0x2c, 0x14, 0xe2, 0x20, 0xad, 0x62, 0x14, 0x85, 0x1e, 0xad, 0x71, 0x00, 0x85, 0x20, 0xab, o.badLoader === 'updateRts' ? 0x60 : 0x6b] // prettier-ignore
  put(0x00f6db, upd)
  // A hand-written hook that mirrors the shape of the common $00:F6E4 hook seen in the corpus: a JML at
  // $F6E4 over SBC #$000C and STA $142C; the target redoes both, copies $1A-$21 to $7F:831F (word
  // moves, X = 0..6 here), and JMLs back to $00:F6EA, the instruction after the STA.
  if (o.updateHook) {
    put(0x00f6e4, [0x5c, 0x00, 0xf0, 0x05])
    const redo = [0xe9, 0x0c, 0x00, 0x8d, 0x2c, 0x14]
    const copy = [
      0x48, 0xa2, 0x00, 0xb5, 0x1a, 0x9f, 0x1f, 0x83, 0x7f, 0xe8, 0xe8, 0xe0, 0x08, 0xd0, 0xf4,
      0x68,
    ]
    put(0x05f000, o.updateHook === 'loop' ? [0x80, 0xfe] : o.updateHook === 'rts' ? [...redo, 0xab, 0x60] : [...redo, ...copy, 0x5c, 0xea, 0xf6, 0x00]) // prettier-ignore
  }
}
