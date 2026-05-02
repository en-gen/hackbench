import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $95 (Clappin' Chuck), rendered in clapping pose frame $06.
 *
 * InitClappinChuck (bank_01.asm:749) sets SpriteTableC2=$08 then falls
 * through to JSR FaceMario (bank_01.asm:788), which calls SubHorizPos
 * (bank_01.asm:6124): Y=0 when Mario.X >= Sprite.X (face right), Y=1
 * when Mario.X < Sprite.X (face left). Stored in SpriteMisc157C (_3).
 * CODE_02C556 (bank_02.asm:9217) re-evaluates facing every frame the
 * same way via CODE_02D4FA (bank_02.asm:11275). Static display uses
 * marioStartPx.x >= spriteX as the equivalent.
 *
 * Frame $06 is the first clapping frame (CODE_02CA9D bank_02.asm:9824,
 * X=0 branch after SBC #$06) showing the spread-glove pose with the
 * small $0C tiles. It is the most visually distinctive Clappin' Chuck
 * frame at editor scale.
 *
 * Head — CODE_02C88C (bank_02.asm:9627):
 *   tile $06  (ChuckHeadTiles[0], line 9621) — head-frame 0 for static
 *   X offset 0 (DATA_02C830[6]=$00, line 9603) — negate(0)=0, direction-invariant
 *   Y offset −12 (DATA_02C84A[6]=$F4, line 9609)
 *   DATA_02C885[0]=$40 ORed into attr → flipX = faceRight (same convention as $91)
 *
 * Body — CODE_02CA27 (bank_02.asm:9755), frame $06:
 *   body1 tile $40 (ChuckBody1[6], line 9719), size 16×16 (DATA_02C9F3[6]=$02, line 9743)
 *   body2 tile $40 (ChuckBody2[6], line 9725), size 16×16 (hardcoded)
 *   body Y offset 0 (DATA_02C971[6]=$00, line 9713)
 *   body1 flipX = faceRight  (DATA_02C9BF[6]=$00, line 9731 — XOR 0)
 *   body2 flipX = !faceRight (DATA_02C9D9[6]=$40, line 9737 — XOR $40 inverts)
 *   body1 X: −4 facing left (DATA_02C909[6]=$FC, line 9695), +4 facing right ([32]=$04)
 *   body2 X: +4 facing left (DATA_02C93D[6]=$04, line 9704), −4 facing right ([32]=$FC)
 *
 * Clapping hands — CODE_02CA9D (bank_02.asm:9824), X=0 branch (frame $06):
 *   tile $0C (ClappinChuckTiles[0], line 9815), size 8×8 (DATA_02CA9B[0]=$00, line 9821)
 *   left hand X offset −6 (DATA_02CA93[0]=$FA, line 9809)
 *   right hand X offset +14 (DATA_02CA95[0]=$0E, line 9812)
 *   both hands Y offset −8 (DATA_02CA99[0]=$F8, line 9818)
 *   left: base attr (no extra flip); right: attr | $40 (H-flip)
 *   Hand positions are direction-invariant (no +$1A offset in CODE_02CA9D).
 *
 * Extends StaticSpriteAppearance → serializes as { kind:'static' }, no
 * changes to serialize.ts / rehydrate.ts needed.
 */
export class ClappinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$95] >> 1) & 0x07)
   * @param bodyCharHigh  0x100 when Sprite166EVals[$95] & 0x01, else 0
   * @param faceRight     true when marioStartPx.x >= spritePx (mirrors SubHorizPos Y=0)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): ClappinChuckAppearance {
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)

    const parts: SpritePart[] = [
      // head: tile $06, centered (X=0), Y=−12 (DATA_02C84A[6]=$F4)
      ...bigTile(0x06, 0, -12, faceRight, bodyPalette, bodyCharHigh),
      // body2: tile $40, mirrored — X and flipX both inverted vs body1
      ...bigTile(0x40, faceRight ? -4 : 4, 0, !faceRight, bodyPalette, bodyCharHigh),
      // body1: tile $40, direction-facing side
      ...bigTile(0x40, faceRight ? 4 : -4, 0, faceRight, bodyPalette, bodyCharHigh),
      // left glove: tile $0C at (−6, −8), no H-flip (DATA_02CA93[0]=$FA)
      smallTile(0x0C, -6, -8, false, bodyPalette, bodyCharHigh),
      // right glove: tile $0C at (+14, −8), H-flipped (DATA_02CA95[0]=$0E, attr|$40)
      smallTile(0x0C, 14, -8, true, bodyPalette, bodyCharHigh),
    ]
    return new ClappinChuckAppearance(parts)
  }
}
