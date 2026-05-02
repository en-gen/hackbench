import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $92 (Splittin' Chuck), rendered in the running pose with body
 * tile $2D mirrored across the chuck's centerline. This matches a Mesen
 * sprite-inspector capture of the chuck mid-cycle, and is visually
 * distinct from $91 Chargin' Chuck (which ships pose $13 = $20/$21 +
 * football) and the other chuck variants which cluster around body
 * tile $40.
 *
 * Geometry verified directly via Mesen sprite inspector — captured slots
 * for a face-LEFT Splittin' Chuck:
 *
 *     | Slot | Tile | OAM (X, Y)  | H-flip | Notes              |
 *     |------|------|-------------|--------|--------------------|
 *     | 116  | $06  | (184, 92)   | ☐      | head, second-table |
 *     | 118  | $2D  | (180, 96)   | ☐      | body1 16×16        |
 *     | 119  | $2D  | (188, 96)   | ✓      | body2 16×16 hflip  |
 *
 * Chuck anchor at sprite_x = 184: head dx = 0 (matches Mesen 184), body1
 * dx = -4 (matches 180), body2 dx = +4 (matches 188). The `$2D / $2D`
 * mirrored body matches `ChuckBody1[$04] = ChuckBody2[$04] = $2D` from
 * the shared chuck OAM tables (bank_02.asm:9719/9725).
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   Init  bank_01.asm:377 → InitChuck (bank_01.asm:772) sets
 *         SpriteTableC2 = $05 then JSR FaceMario stores DATA_018526[Y] in
 *         SpriteMisc151C ($00 face-RIGHT, $04 face-LEFT).
 *   Main  bank_01.asm:1044 → Chucks dispatch → CODE_02C582 (bank_02.asm:9247).
 *         When SpriteMisc1540 == 1 the $93-only branch fails through to
 *         the SPLIT logic at line 9265-9272: SpriteTableC2 = $00, play
 *         SFX_MAGIC, JSR CODE_02C5BC twice spawning two sprite $91 clones.
 *
 *   The Mesen capture's head shows H-mirror clear, which lines up with
 *   `DATA_02C885[Misc151C=4] = $00` (no extra hflip XOR'd into the head
 *   attr). Misc151C retains the InitChuck face-LEFT value of $04 because
 *   the chuck's CODE_02C63B / CODE_02C726 idle-state path only calls
 *   CODE_02C556 conditionally — most frames keep the InitChuck-set
 *   Misc151C = $00 (face-RIGHT) or $04 (face-LEFT).
 *
 *   Pose $04 OAM (CODE_02C81A → 02C88C / 02CA27, bank_02.asm):
 *     head    $06 16x16 at dx=±DATA_02C830[$04]=±0 (negation no-op),
 *             dy=DATA_02C84A[$04]=$FC=-4. attr = DATA_02C885[Misc151C] | base.
 *     body1   $2D 16x16 (DATA_02C9F3[$04]=$02 size).
 *             dx face-LEFT  = DATA_02C909[$04]    = -4
 *             dx face-RIGHT = DATA_02C909[$04+$1A]= +4 (simple mirror)
 *             dy = DATA_02C971[$04] = 0
 *             hflip = base XOR DATA_02C9BF[$04]=$00; toggles with face.
 *     body2   $2D 16x16 (same tile as body1, mirrored).
 *             dx face-LEFT  = DATA_02C93D[$04]    = +4
 *             dx face-RIGHT = DATA_02C93D[$04+$1A]= -4
 *             dy = 0 (hardcoded)
 *             hflip = base XOR DATA_02C9D9[$04]=$40; opposite of body1.
 *     no extras — CODE_02CA9D's pose-$06/$07/$12/$13/$14-$19 dispatches
 *     all skip when pose is $04.
 *
 *   Tiles $06, $2D are low-page → live in SP3 = chuck primary GFX13.
 *   Renders correctly in any chuck-using level's sprite set ($001, $118,
 *   $123 for Splittin' specifically).
 *
 *   Note: pose $04 is the canonical "running with body tile $2D" frame
 *   shared across the chuck OAM tables and matches the Mesen capture
 *   above; the formal asm path through CODE_02C504 only writes pose $04
 *   from the Clappin' Chuck branch (state $08) when grounded, but the
 *   silhouette is the same regardless of which state machine produced it.
 */
export class SplittinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$92] >> 1) & 0x07) = 13
   * @param bodyCharHigh  (Sprite166EVals[$92] & 0x01) ? 0x100 : 0 = 0x100
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): SplittinChuckAppearance {
    const { bigTile } = ChuckAppearance.builders(chars, placeholder)

    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,  0, -4, true,  bodyPalette, bodyCharHigh),  // head hflipped (Misc151C=0 face-right)
          ...bigTile(0x2D,  4,  0, true,  bodyPalette, bodyCharHigh),  // body1 face-right swap
          ...bigTile(0x2D, -4,  0, false, bodyPalette, bodyCharHigh),  // body2 mirror, no flip
        ]
      : [
          ...bigTile(0x06,  0, -4, false, bodyPalette, bodyCharHigh),  // head no flip (Misc151C=4 face-left)
          ...bigTile(0x2D, -4,  0, false, bodyPalette, bodyCharHigh),  // body1 left side, no flip
          ...bigTile(0x2D,  4,  0, true,  bodyPalette, bodyCharHigh),  // body2 right side, hflip
        ]
    return new SplittinChuckAppearance(parts)
  }
}
