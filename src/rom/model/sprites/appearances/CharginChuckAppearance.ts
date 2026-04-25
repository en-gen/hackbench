import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $91 (Chargin' Chuck), rendered in charging pose $13.
 *
 * CODE_02C6A7 / state 1 (bank_02.asm:9401) selects pose $13 from
 * DATA_02C6A3. Geometry from:
 *   head:  ChuckHeadTiles (bank_02.asm), pose-specific offsets DATA_02C830/02C84A
 *          → pose $13 at (-10,-12) facing right; (10,-12) facing left
 *   body1: ChuckBody1[$13] = $20, DATA_02C909/02C971 → (-8,0) / (+8,0)
 *   body2: ChuckBody2[$13] = $21, DATA_02C93D → (0,0) both directions
 *   football: CODE_02CAFC (bank_02.asm:9874), ChuckGfxProp palette $07
 *             chars $1C/$1D at (0,-8),(8,-8) / (8,-8),(0,-8) facing left/right
 *
 * InitChuck (bank_01.asm:772) calls FaceMario; DATA_018526={$00,$04} maps
 * Mario-right → Chuck faces right (all body tiles hflipped), Mario-left
 * → Chuck faces left (no flips).
 *
 * Extends StaticSpriteAppearance → serializes as { kind:'static' }, no
 * changes to serialize.ts / rehydrate.ts needed.
 */
export class CharginChuckAppearance extends StaticSpriteAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$91] >> 1) & 0x07)
   * @param bodyCharHigh  0x100 when Sprite166EVals[$91] & 0x01, else 0
   * @param faceRight     true when marioStartPx.x >= spritePx
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    faceRight: boolean,
  ): CharginChuckAppearance {
    // Football uses hardcoded ChuckGfxProp attr $07 (palette bits only —
    // hflip is separate). Low nibble $07 → OBJ palette 3 → CGRAM row 11, charHigh 1.
    const BALL_ATTR    = 0x07
    const ballPalette  = 8 + ((BALL_ATTR >> 1) & 0x07)
    const ballCharHigh = (BALL_ATTR & 0x01) !== 0 ? 0x100 : 0

    const OBJ_BASE = 0x400
    const bigTile = (baseTile: number, bdx: number, bdy: number, flipX: boolean, pal: number, cHigh: number): SpritePart[] => {
      const co = flipX ? [0x01, 0x00, 0x11, 0x10] : [0x00, 0x01, 0x10, 0x11]
      return co.map((off, i) => ({
        char: chars.get(OBJ_BASE + cHigh + ((baseTile + off) & 0x1FF)) ?? placeholder,
        palette: pal, flipX, flipY: false,
        dx: bdx + [0, 8, 0, 8][i], dy: bdy + [0, 0, 8, 8][i],
      }))
    }
    const smallTile = (tile: number, dx: number, dy: number, flipX: boolean, pal: number, cHigh: number): SpritePart => ({
      char: chars.get(OBJ_BASE + cHigh + (tile & 0x1FF)) ?? placeholder,
      palette: pal, flipX, flipY: false, dx, dy,
    })

    // Draw order matches SMW OAM: head first (behind), body2, body1; football on top.
    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,  10, -12, true,  bodyPalette, bodyCharHigh),  // head
          ...bigTile(0x21,   0,   0, true,  bodyPalette, bodyCharHigh),  // body2
          ...bigTile(0x20,   8,   0, true,  bodyPalette, bodyCharHigh),  // body1
          smallTile(0x1C,  8,  -8, true,  ballPalette, ballCharHigh),    // football tile 1
          smallTile(0x1D,  0,  -8, true,  ballPalette, ballCharHigh),    // football tile 2
        ]
      : [
          ...bigTile(0x06, -10, -12, false, bodyPalette, bodyCharHigh),  // head
          ...bigTile(0x21,   0,   0, false, bodyPalette, bodyCharHigh),  // body2
          ...bigTile(0x20,  -8,   0, false, bodyPalette, bodyCharHigh),  // body1
          smallTile(0x1C,  0,  -8, false, ballPalette, ballCharHigh),    // football tile 1
          smallTile(0x1D,  8,  -8, false, ballPalette, ballCharHigh),    // football tile 2
        ]
    return new CharginChuckAppearance(parts)
  }
}
