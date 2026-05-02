import type { Char } from '../../chars/Char'
import { ChuckAppearance } from './ChuckAppearance'
import type { SpritePart } from './StaticSpriteAppearance'

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
 *   Face-right composition: head and football X mirror face-left (head from
 *   DATA_02C830 negation; football from ChuckSprGenDispX = db $14,$EC = ±20).
 *   Body1 X is NOT a mirror — the chuck X tables DATA_02C909/DATA_02C93D are
 *   face-doubled (52 entries; face-LEFT 0..25, face-RIGHT 26..51), and
 *   CODE_02CA27 (bank_02.asm:9755) reads body1 from DATA_02C909[pose+$1A]
 *   for face-right. For pose $11 that is DATA_02C909[$2B] = $10 = +16 (vs
 *   face-left $F8 = -8). hflip toggles per chuck part; football hflip swaps
 *   so the ball always points its travel direction.
 */
export class PuntinChuckAppearance extends ChuckAppearance {
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
    const { bigTile, smallTile } = ChuckAppearance.builders(chars, placeholder)

    // Face-left geometry comes directly from a Mesen OAM dump on level $1F1.
    // Face-right: head/football X mirror face-left, but body1 X is read
    // straight from DATA_02C909[$11+$1A] = $10 = +16 (chuck X tables are
    // face-doubled; see top-of-file note). hflip toggles per chuck part;
    // football hflip swaps so the ball points its travel direction.
    const parts: SpritePart[] = faceRight
      ? [
          ...bigTile(0x06,   7, -10, true,  bodyPalette, bodyCharHigh),  // head
          ...bigTile(0xCC,   0,   0, true,  bodyPalette, bodyCharHigh),  // body2 16x16  (DATA_02C93D[$2B] = $00)
          smallTile(0xCB,   16,   3, true,  bodyPalette, bodyCharHigh),  // body1 8x8 kick foot  (DATA_02C909[$2B] = $10)
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
