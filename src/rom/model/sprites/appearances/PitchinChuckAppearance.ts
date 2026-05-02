import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $98 (Pitchin' Chuck), rendered in the throw-cycle pose $18 with the
 * baseball composed at the captured runtime offset. Pose $18 (one of the
 * `DATA_02C3B7 = $18,$19,$14,$14` entries selected by `CODE_02C3CB`
 * bank_02.asm:9006) shows the chuck winding through the throw motion: a
 * single 8x8 body1 tile $BD held forward of the 16x16 body2 tile $A4, with
 * the head pulled back and slightly down.
 *
 * Geometry verified directly via Mesen sprite inspector against a face-LEFT
 * Pitchin' Chuck on level $015 (DP1) — captured slots:
 *
 *     | Slot | Tile | OAM (X, Y)  | H-flip | Notes                |
 *     |------|------|-------------|--------|----------------------|
 *     | 124  | $06  | (201, 168)  | ☐      | head, second-table   |
 *     | 122  | $A4  | (209, 176)  | ☐      | body2 16×16          |
 *     | 121  | $BD  | (201, 176)  | ☐      | body1 8×8            |
 *     |  43  | $AD  | (189, 176)  | ✓      | baseball, palette 4  |
 *
 * Solving for chuck anchor: face-LEFT head dx = `DATA_02C830[$18]` = $F8 = -8
 * → sprite_x = 201 + 8 = 209. body1 (head dx = $F8 → +1 in face-LEFT, but
 * Mesen shows body1 at sprite_x − 8 ✓ matches `DATA_02C909[$18]=$F8`),
 * body2 at sprite_x + 0 ✓ matches `DATA_02C93D[$18]=$00`.
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   Init  bank_01.asm:383 → InitPitchinChuck (bank_01.asm:753) sets
 *         SpriteMisc187B = (SpriteXPosLow & $30) >> 4 (a lane select used
 *         by `DATA_02C3B3` for throw-timer reload), SpriteTableC2 = $0A,
 *         then JSR FaceMario stores DATA_018526[Y] = 0/4 in SpriteMisc151C.
 *   Main  bank_01.asm:1050 → Chucks dispatch → CODE_02C3CB. Misc1540
 *         counts down; when ≥ $40 the pose comes from DATA_02C3B7 indexed
 *         by ((Misc1540 - $40) >> 3) & 3, so the chuck cycles {$18,$19,$14,$14}.
 *
 *   Pitchin' calls CODE_02C556 only every 64 frames (`LDA EffFrame /
 *   AND #$3F / BNE +`, line 9025-9028). For most frames SpriteMisc151C
 *   retains its InitChuck value: $00 face-RIGHT (Mario right) or $04
 *   face-LEFT (Mario left). `ChuckHeadTiles[0]` and `[4]` both = $06, so
 *   the head tile is the same for both faces. `DATA_02C885[0]=$40`
 *   forces hflip face-RIGHT; `DATA_02C885[4]=$00` keeps the head clear
 *   face-LEFT — matches Mesen.
 *
 *   Pose $18 OAM (CODE_02C81A → 02C88C / 02CA27, bank_02.asm):
 *     head    $06 16×16 at dx=∓DATA_02C830[$18] = ∓8, dy=DATA_02C84A[$18]=-8
 *     body1   $BD 8×8 (DATA_02C9F3[$18]=$00 → single-tile size)
 *             dx face-LEFT  = DATA_02C909[$18]    = -8
 *             dx face-RIGHT = DATA_02C909[$18+$1A]= +16
 *             dy = DATA_02C971[$18] = 0
 *             hflip = base XOR DATA_02C9BF[$18]=$00
 *     body2   $A4 16×16 (hardcoded size)
 *             dx face-LEFT  = DATA_02C93D[$18]    = 0
 *             dx face-RIGHT = DATA_02C93D[$18+$1A]= 0
 *             dy = 0 (hardcoded)
 *             hflip = base XOR DATA_02C9D9[$18]=$00
 *
 *   baseball  Sprite $19 (Baseball) — separately spawned by Pitchin's
 *             throw routine; not part of CODE_02CB53's pose-$14..$19 ball
 *             draw. Mesen captures it mid-flight at chuck_x − 20 face-LEFT,
 *             palette 4 (CGRAM row 12) charHigh $100 hflipped (default
 *             tile faces right; flips with travel direction). For the
 *             static editor view we render the baseball at the captured
 *             ±20 px offset so the editor conveys the throw.
 */
export class PitchinChuckAppearance extends ChuckAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$98] >> 1) & 0x07) = 13
   * @param bodyCharHigh  (Sprite166EVals[$98] & 0x01) ? 0x100 : 0 = 0x100
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): PitchinChuckAppearance {
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)
    // Baseball OAM: palette 4 (CGRAM row 12), charHigh $100, hardcoded
    // attr $09 in CODE_02CB53 family. Baseball travel direction sets the
    // hflip — face-LEFT chuck → ball moves left → hflip TRUE.
    const ballPalette  = 12
    const ballCharHigh = 0x100

    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,   8,  -8, true,  bodyPalette, bodyCharHigh),  // head hflipped (DATA_02C885[0]=$40)
          ...bigTile(0xA4,   0,   0, true,  bodyPalette, bodyCharHigh),  // body2 16x16, hflip
          smallTile(0xBD,   16,   0, true,  bodyPalette, bodyCharHigh),  // body1 8x8 at face-RIGHT dx=+16
          smallTile(0xAD,   20,   0, false, ballPalette, ballCharHigh),  // baseball flying right
        ]
      : [
          ...bigTile(0x06,  -8,  -8, false, bodyPalette, bodyCharHigh),  // head no flip (DATA_02C885[4]=$00)
          ...bigTile(0xA4,   0,   0, false, bodyPalette, bodyCharHigh),  // body2 16x16
          smallTile(0xBD,   -8,   0, false, bodyPalette, bodyCharHigh),  // body1 8x8 at face-LEFT dx=-8
          smallTile(0xAD,  -20,   0, true,  ballPalette, ballCharHigh),  // baseball flying left, hflip
        ]
    return new PitchinChuckAppearance(parts)
  }
}
