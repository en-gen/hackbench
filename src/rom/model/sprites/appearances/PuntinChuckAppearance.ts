import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $97 (Puntin' Chuck), rendered in canonical kick wind-up pose $11
 * with sprite $1B Football composed at its spawn position.
 *
 * Geometry verified directly via Mesen sprite inspector against a running
 * level $1F1 frame; ASM citations below corroborate.
 *
 * ASM grounding (C:\Projects\SMWDisX):
 *   InitPuntinChuck (bank_01.asm:764-766) sets SpriteTableC2 = $09 then BRA's
 *   into shared InitChuck (which calls FaceMario). The chuck dispatch
 *   (bank_02.asm:8927-8942) at index $09 runs CODE_02C4BD (bank_02.asm:9139),
 *   which cycles SpriteMisc1602 through DATA_02C4B5 = db $00,$00,$11,$11,
 *   $11,$11,$00,$00 (bank_02.asm:9136). Two visible body poses:
 *     $00 = $0D/$4E idle stance
 *     $11 = $CB/$CC kick wind-up  ← shipped here
 *
 *   OAM slots (anchor = chuck level position, i.e. body2 top-left):
 *     head     $06   (-7, -10)  16x16 big-tile          (chuck body palette)
 *     body2    $CC   ( 0,   0)  16x16 big-tile          (chuck body palette)
 *     body1    $CB   (-8,  +3)  8x8 single (kick foot)  (chuck body palette)
 *     football $8A   (-20,  0)  16x16 big-tile, hflipped (football palette)
 *
 *   Body1 ($CB) and body2 ($CC) live in SP4 high-page. Sprite166EVals[$97]=$0B
 *   → bodyCharHigh=$100. $1F1's sprite set 3 maps SP4=GFX04, which contains
 *   Puntin's kick body tiles at chars $1CB/$1CC + the football tile at $18A.
 *
 *   Football: CODE_02C4BD's frame-0 trigger calls JSL CODE_03CBB3 (bank_03.asm:
 *   8769) spawning sprite $1B Football at (chuck_x + ChuckSprGenDispX[face],
 *   chuck_y). ChuckSprGenDispX = db $14,$EC (bank_03.asm:8760) → +20 px face-
 *   right, -20 px face-left. Football tile $8A is a single 16x16 in SP4 high-
 *   page (char $18A). Its sprite attr puts it on OBJ palette 0 (CGRAM row 8,
 *   bodyPalette = 8) with charHigh $100. The hflip on the football tile flips
 *   with chuck's facing so the football graphic always points the way it's
 *   travelling.
 *
 *   Face-right is the mirror: X offsets negated, hflip toggled per part.
 *   Football flip semantics swap (face-left chuck = football moving left =
 *   hflipped tile; face-right chuck = football moving right = unflipped).
 */
export class PuntinChuckAppearance extends StaticSpriteAppearance {
  /**
   * @param bodyPalette   8 + ((Sprite166EVals[$97] >> 1) & 0x07) = 13
   * @param bodyCharHigh  (Sprite166EVals[$97] & 0x01) ? 0x100 : 0 = 0x100
   * @param faceRight     true when marioStartPx.x >= spritePx (FaceMario semantics)
   */
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
    bodyPalette: number,
    bodyCharHigh: number,
    ballPalette: number,
    ballCharHigh: number,
    faceRight: boolean,
  ): PuntinChuckAppearance {
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

    // Face-left geometry comes directly from a Mesen OAM dump on level $1F1.
    // Face-right mirrors X offsets, toggles hflip per part, and swaps the
    // football's hflip (so the ball always points its travel direction).
    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,   7, -10, true,  bodyPalette, bodyCharHigh),  // head
          ...bigTile(0xCC,   0,   0, true,  bodyPalette, bodyCharHigh),  // body2 16x16
          smallTile(0xCB,    8,   3, true,  bodyPalette, bodyCharHigh),  // body1 8x8 kick foot
          ...bigTile(0x8A,  20,   0, false, ballPalette, ballCharHigh),  // football 16x16, no flip
        ]
      : [
          ...bigTile(0x06,  -7, -10, false, bodyPalette, bodyCharHigh),  // head
          ...bigTile(0xCC,   0,   0, false, bodyPalette, bodyCharHigh),  // body2 16x16
          smallTile(0xCB,   -8,   3, false, bodyPalette, bodyCharHigh),  // body1 8x8 kick foot
          ...bigTile(0x8A, -20,   0, true,  ballPalette, ballCharHigh),  // football 16x16, hflip
        ]
    return new PuntinChuckAppearance(parts)
  }
}
