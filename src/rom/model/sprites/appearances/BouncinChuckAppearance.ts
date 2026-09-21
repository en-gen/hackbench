import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $93 (Bouncin' Chuck), rendered in the active arms-up bounce pose $06.
 *
 * Geometry derived directly from the chuck OAM-emit asm in bank_02.asm. The
 * face-LEFT and face-RIGHT branches are NOT simple X-mirrors: body1 / body2
 * swap which side they sit on AND swap their hflip flags, the head's hflip
 * toggles, and the two $0C arms keep their hardcoded offsets in both
 * orientations.
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   Init  bank_01.asm:378 → InitChuck which sets SpriteTableC2 = $05 then calls
 *         FaceMario; SpriteMisc151C = DATA_018526[Y] = $00 (Mario-right) or
 *         $04 (Mario-left). DATA_018526 only ever produces those two values.
 *   Main  bank_01.asm:1045 → Chucks → ChucksMain → CODE_02C582 → CODE_02C556
 *         every frame, which REWRITES SpriteMisc151C from
 *         DATA_02C639[Misc157C] = $00 / $04 (same scheme as InitChuck - see
 *         bank_02.asm:9221). The chuck transitions to SpriteTableC2 = $06 on
 *         player approach, hitting CODE_02C53C (bank_02.asm:9204) which
 *         writes pose $06 into Misc1602.
 *
 *   Pose $06 OAM emit (CODE_02C81A → CODE_02C88C / 02CA27 / 02CA9D):
 *
 *     head:  ChuckHeadTiles[SpriteMisc151C] (NOT pose-indexed). Misc151C is
 *            always $00 or $04 for Bouncin' Chuck (per InitChuck / CODE_02C556
 *            above), so the head tile is ALWAYS the same:
 *              ChuckHeadTiles[$00] = $06   (face-RIGHT)
 *              ChuckHeadTiles[$04] = $06   (face-LEFT)
 *            attr = DATA_02C885[Misc151C] OR base:
 *              DATA_02C885[$00] = $40 → hflipped head at face-RIGHT
 *              DATA_02C885[$04] = $00 → un-flipped head at face-LEFT
 *            dx = ±DATA_02C830[$06] = ±0 (sign no-op for pose $06).
 *            dy = DATA_02C84A[$06] = -12.
 *
 *     body:  ChuckBody1[$06] = ChuckBody2[$06] = $40 (16x16 bigtile each).
 *            face-LEFT  body1 dx = DATA_02C909[$06] = -4
 *                       body2 dx = DATA_02C93D[$06] = +4
 *                       body1 hflip = base XOR DATA_02C9BF[$06] = no flip
 *                       body2 hflip = base XOR DATA_02C9D9[$06] = hflip
 *            face-RIGHT body1 dx = DATA_02C909[$06+$1A] = +4
 *                       body2 dx = DATA_02C93D[$06+$1A] = -4
 *                       body1 hflip = (base|$40) XOR $00 = hflip
 *                       body2 hflip = (base|$40) XOR $40 = no flip
 *            body1 dy = DATA_02C971[$06] = 0; body2 dy = 0 (hardcoded).
 *
 *     arms:  CODE_02CA9D draws ClappinChuckTiles[pose-$06] = $0C twice (8x8
 *            each, DATA_02C9F3-driven) at offsets that DO NOT mirror with face:
 *              arm1 dx = DATA_02CA93[0] = -6, attr = base (no flip)
 *              arm2 dx = DATA_02CA95[0] = +14, attr = base | $40 (hflip)
 *              both at dy = DATA_02CA99[0] = -8
 *
 *   Sprite166EVals[$93] = $0B → bodyCharHigh = $100, OBJ palette 5 (CGRAM 13).
 *   Tiles $06, $0A, $40, $0C are all low-page → live in SP3 = chuck primary
 *   GFX13. Renders correctly in any chuck-using level's sprite set.
 */
export class BouncinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$93] >> 1) & 0x07) = 13
   * @param bodyCharHigh  (Sprite166EVals[$93] & 0x01) ? 0x100 : 0 = 0x100
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario semantics)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): BouncinChuckAppearance {
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)

    // Each branch is the literal asm output:
    //   - head is always tile $06; hflip toggles with face direction
    //     (DATA_02C885: $40 face-right, $00 face-left)
    //   - body1 / body2 swap which side they sit on AND swap hflip flags
    //   - $0C arm offsets and hflips are HARDCODED - they do NOT mirror
    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06, 0, -12, true, bodyPalette, bodyCharHigh), // head hflip (Misc151C=$00 → DATA_02C885=$40)
          ...bigTile(0x40, 4, 0, true, bodyPalette, bodyCharHigh), // body1 hflip
          ...bigTile(0x40, -4, 0, false, bodyPalette, bodyCharHigh), // body2 no flip
          smallTile(0x0c, -6, -8, false, bodyPalette, bodyCharHigh), // arm1 (always)
          smallTile(0x0c, 14, -8, true, bodyPalette, bodyCharHigh), // arm2 (always)
        ]
      : [
          ...bigTile(0x06, 0, -12, false, bodyPalette, bodyCharHigh), // head no flip (Misc151C=$04 → DATA_02C885=$00)
          ...bigTile(0x40, -4, 0, false, bodyPalette, bodyCharHigh), // body1 no flip
          ...bigTile(0x40, 4, 0, true, bodyPalette, bodyCharHigh), // body2 hflip
          smallTile(0x0c, -6, -8, false, bodyPalette, bodyCharHigh), // arm1 (always)
          smallTile(0x0c, 14, -8, true, bodyPalette, bodyCharHigh), // arm2 (always)
        ]
    return new BouncinChuckAppearance(parts)
  }
}
