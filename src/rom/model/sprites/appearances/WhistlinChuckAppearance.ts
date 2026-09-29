import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $94 (Whistlin' Chuck), rendered in the active whistle pose $06 with
 * the whistling head tile $4B (lips puckered). Verified directly via Mesen
 * sprite inspector against a face-LEFT Whistlin' Chuck on level $120 (FoI2):
 *
 *     | Slot | Tile | OAM (X, Y)   | H-flip | Notes              |
 *     |------|------|--------------|--------|--------------------|
 *     |  96  | $0C  | (143, 176)   | ☐      | arm1 8x8           |
 *     |  97  | $0C  | (163, 176)   | ✓      | arm2 8x8 hflip     |
 *     |  98  | $4B  | (149, 172)   | ☐      | head 16x16         |
 *     |  99  | $40  | (145, 184)   | ☐      | body1 16x16        |
 *     | 100  | $40  | (153, 184)   | ✓      | body2 16x16 hflip  |
 *
 * Sprite anchor sprite_x = 149: head dx = 0, body1 dx = -4, body2 dx = +4,
 * arm1 dx = -6, arm2 dx = +14. Sprite_y = 184: head dy = -12, body dy = 0,
 * arms dy = -8. Body and arm geometry is byte-for-byte identical to the
 * Bouncin' Chuck pose $06 frame; only the head tile differs ($4B whistling
 * lips vs. $06 standard chuck face).
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   Init  bank_01.asm:380 → InitWhistlinChuck (bank_01.asm:768) sets
 *         SpriteTableC2 = $0B then JSR FaceMario stores DATA_018526[Y]
 *         in SpriteMisc151C ($00 face-RIGHT, $04 face-LEFT).
 *   Main  bank_01.asm:1046 → Chucks → ChucksMain → CODE_02C22C dispatches
 *         on SpriteTableC2 via the table at bank_02.asm:8930-8942:
 *           state $0B → CODE_02C356 (bank_02.asm:8944) - proximity gate.
 *             When |player_x - sprite_x| <= $30, transitions to state $0C;
 *             then JMP CODE_02C556 to refresh face direction.
 *           state $0C → CODE_02C37B (bank_02.asm:8963) - active whistle:
 *             • plays SFX_WHISTLE every 64 frames (EffFrame & $3F == 0)
 *             • Misc1602 ← $03 (1/4 of frames) or $06 (3/4 of frames) per
 *               (EffFrame & $30) test - pose $06 dominates the cycle.
 *             • Misc151C ← DATA_02C373[(EffFrame >> 2) & 7], where
 *               DATA_02C373 = $05,$05,$05,$02,$02,$06,$06,$06.
 *               This OVERWRITES the InitWhistlinChuck face-derived
 *               Misc151C, so the head animation is decoupled from face
 *               direction (the body still mirrors via Misc157C).
 *             • sets ChuckIsWhistling - overrides the $3D Rip Van Fish
 *               wake-up distance check (`RIP_VAN_FISH_DETECT_HALF_PX` in
 *               `RipVanFishBehavior.ts`, read by `RipVanFishAppearance`).
 *
 *   Pose $06 OAM emit (CODE_02C81A → CODE_02C88C / 02CA27 / 02CA9D):
 *
 *     head:  ChuckHeadTiles[Misc151C]:
 *              Misc151C = $05 (3/8 of cycle): tile $4B no flip
 *              Misc151C = $02 (2/8 of cycle): tile $0E no flip
 *              Misc151C = $06 (3/8 of cycle): tile $4B hflip ($40)
 *            i.e. tile $4B dominates (6/8 frames). Editor freezes the
 *            cycle at Misc151C=$05 (the most common no-flip $4B) and
 *            mirrors hflip with face direction so the static frame
 *            matches one of the asm-emitted phases in each orientation.
 *            dx = ±DATA_02C830[$06] = ±0; dy = DATA_02C84A[$06] = -12.
 *
 *     body:  ChuckBody1[$06] = ChuckBody2[$06] = $40 (16x16 each).
 *            face-LEFT  body1 dx = DATA_02C909[$06]    = -4 no flip
 *                       body2 dx = DATA_02C93D[$06]    = +4 hflip
 *            face-RIGHT body1 dx = DATA_02C909[$06+$1A]= +4 hflip
 *                       body2 dx = DATA_02C93D[$06+$1A]= -4 no flip
 *            body dy = DATA_02C971[$06] = 0; size = DATA_02C9F3[$06] = $02 (16x16).
 *
 *     arms:  CODE_02CA9D draws ClappinChuckTiles[pose-$06] = $0C twice
 *            (8x8 each, DATA_02C9F3-driven) at HARDCODED offsets that do
 *            NOT mirror with face direction:
 *              arm1 dx = DATA_02CA93[0] = -6, attr = base (no flip)
 *              arm2 dx = DATA_02CA95[0] = +14, attr = base | $40 (hflip)
 *              both at dy = DATA_02CA99[0] = -8.
 *
 *   Sprite166EVals[$94] = $0B → bodyCharHigh = $100, OBJ palette 5 (CGRAM 13).
 *   Tiles $0C, $40, $4B are all low-page → live in SP3 = chuck primary
 *   GFX13. Renders correctly in any chuck-using level's sprite set ($120, $125
 *   for Whistlin' specifically).
 */
export class WhistlinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$94] >> 1) & 0x07) = 13
   * @param bodyCharHigh  (Sprite166EVals[$94] & 0x01) ? 0x100 : 0 = 0x100
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): WhistlinChuckAppearance {
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)

    // Body and arm geometry mirrors BouncinChuckAppearance's pose $06 frame
    // exactly - only the head tile differs ($4B whistling lips vs. $06).
    // Head hflip toggles with face direction so each orientation matches one
    // of the asm-emitted cycle phases (face-LEFT = Misc151C=$05 no flip per
    // Mesen capture; face-RIGHT = Misc151C=$06 hflip, also a valid phase).
    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x4b, 0, -12, true, bodyPalette, bodyCharHigh), // head $4B hflip (mirror of capture)
          ...bigTile(0x40, 4, 0, true, bodyPalette, bodyCharHigh), // body1 hflip
          ...bigTile(0x40, -4, 0, false, bodyPalette, bodyCharHigh), // body2 no flip
          smallTile(0x0c, -6, -8, false, bodyPalette, bodyCharHigh), // arm1 (always)
          smallTile(0x0c, 14, -8, true, bodyPalette, bodyCharHigh), // arm2 (always)
        ]
      : [
          ...bigTile(0x4b, 0, -12, false, bodyPalette, bodyCharHigh), // head $4B no flip (Mesen capture)
          ...bigTile(0x40, -4, 0, false, bodyPalette, bodyCharHigh), // body1 no flip
          ...bigTile(0x40, 4, 0, true, bodyPalette, bodyCharHigh), // body2 hflip
          smallTile(0x0c, -6, -8, false, bodyPalette, bodyCharHigh), // arm1 (always)
          smallTile(0x0c, 14, -8, true, bodyPalette, bodyCharHigh), // arm2 (always)
        ]
    return new WhistlinChuckAppearance(parts)
  }
}
