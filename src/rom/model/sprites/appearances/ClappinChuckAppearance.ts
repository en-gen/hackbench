import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $95 (Clappin' Chuck), rendered in the clap follow-through pose $07
 * with the alt-glove tile $44 raised above the head — the moment SFX_CLAP
 * fires (CODE_02C4E3 line 9170-9176, bank_02.asm) and the Misc1FE2 timer
 * starts. This is the most distinctive Clappin' Chuck frame at editor
 * scale (visually unique from the other chuck variants which all reuse
 * pose $06's body tile $40 + small $0C arm tiles).
 *
 * Geometry verified directly via Mesen sprite inspector against a running
 * Clappin' Chuck on level $105 (YI1) at face-RIGHT — see slot data in PR
 * description. Face-LEFT is the X-mirror with all hflip flags toggled.
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   Init  bank_01.asm:380 → InitClappinChuck (bank_01.asm:749) sets
 *         SpriteTableC2 = $08, then JSR FaceMario.
 *   Main  bank_01.asm:1048 → Chucks dispatch → CODE_02C4E3 (bank_02.asm:9162)
 *         which calls CODE_02C556 every frame (resetting SpriteMisc151C to
 *         0 face-RIGHT or 1 face-LEFT). Pose $07 is set when SpriteMisc1FE2
 *         is zero (line 9170-9176): play SFX_CLAP, set Misc1FE2 = $20, write
 *         pose $07. Otherwise pose $06 default. Grounded chucks override to
 *         pose $04 (idle).
 *
 *   Pose $07 OAM (CODE_02C81A → 02C88C / 02CA27 / 02CA9D, bank_02.asm):
 *
 *     head      ChuckHeadTiles[Misc151C]:
 *                 face-RIGHT (Misc151C=0): tile $06
 *                 face-LEFT  (Misc151C=1): tile $0A
 *               dx  = ±DATA_02C830[$07] = ±0 (negation no-op).
 *               dy  = DATA_02C84A[$07] = $F5 = -11.
 *               hflip — Mesen face-RIGHT shows the head with H-mirror clear,
 *               which is the empirical truth even though
 *               `DATA_02C885[Misc151C] | base` would algebraically predict
 *               $40 | base → hflip set. We follow Mesen here; the
 *               face-LEFT branch toggles hflip to TRUE so the silhouette
 *               mirrors correctly.
 *
 *     body1     ChuckBody1[$07] = $42 (16x16 big-tile).
 *               dx face-LEFT  = DATA_02C909[$07]    = $F8 = -8
 *               dx face-RIGHT = DATA_02C909[$07+$1A]= $08 = +8
 *               dy = DATA_02C971[$07] = 0
 *               hflip = base XOR DATA_02C9BF[$07]=$00; toggles with face.
 *
 *     body2     ChuckBody2[$07] = $42 (same tile, mirrored).
 *               dx face-LEFT  = DATA_02C93D[$07]    = $08 = +8
 *               dx face-RIGHT = DATA_02C93D[$07+$1A]= $F8 = -8
 *               dy = 0 (hardcoded)
 *               hflip = base XOR DATA_02C9D9[$07]=$40; opposite of body1.
 *
 *     glove     ClappinChuckTiles[1] = $44 16x16 (DATA_02CA9B[1]=$02 size).
 *               dx = DATA_02CA93[1]/02CA95[1] = 0 (both arms collapse to
 *                    sprite_x for pose $07; face direction does not change
 *                    the offset).
 *               dy = DATA_02CA99[1] = $F0 = -16 (raised above head).
 *               hflip — Mesen face-RIGHT shows H-mirror set on the visible
 *               glove slot. CODE_02CA9D draws two glove slots (arm1 at
 *               sprite_x no-flip, arm2 at sprite_x | $40 hflip); they
 *               overlap perfectly so visually only the topmost glove
 *               survives. We render the hflipped glove for face-RIGHT and
 *               the un-flipped for face-LEFT.
 *
 *   Tiles $06, $0A, $42, $44 are all low-page → live in SP3 = chuck primary
 *   GFX13. Renders correctly in any chuck-using level's sprite set
 *   ($01C, $01D, $022, $0D0, $0D1, $0F5, $0F6, $105, $12B for $95).
 */
export class ClappinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$95] >> 1) & 0x07)
   * @param bodyCharHigh  (Sprite166EVals[$95] & 0x01) ? 0x100 : 0
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): ClappinChuckAppearance {
    const { bigTile } = ChuckAppearance.builders(chars, placeholder)

    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,  0, -11, false, bodyPalette, bodyCharHigh),  // head $06 NO hflip (Mesen)
          ...bigTile(0x42,  8,   0, true,  bodyPalette, bodyCharHigh),  // body1 hflip
          ...bigTile(0x42, -8,   0, false, bodyPalette, bodyCharHigh),  // body2 no flip
          ...bigTile(0x44,  0, -16, true,  bodyPalette, bodyCharHigh),  // glove raised, hflip
        ]
      : [
          ...bigTile(0x0A,  0, -11, true,  bodyPalette, bodyCharHigh),  // head $0A face-left (mirror)
          ...bigTile(0x42, -8,   0, false, bodyPalette, bodyCharHigh),  // body1 no flip (swapped)
          ...bigTile(0x42,  8,   0, true,  bodyPalette, bodyCharHigh),  // body2 hflip (swapped)
          ...bigTile(0x44,  0, -16, false, bodyPalette, bodyCharHigh),  // glove no flip (mirror)
        ]
    return new ClappinChuckAppearance(parts)
  }
}
