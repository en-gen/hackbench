// Consumes: (none)

import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9A (Sumo Brother) - patrol-and-projectile enemy.
 *
 * Custom OAM build via `SumoBroGfx` (bank_02.asm:12456). The handler reads
 * 4 tile slots per pose from `SumoBrosTiles` / `SumoBrosDispX` /
 * `SumoBrosDispY` / `SumoBrosTileSize` (bank_02.asm:12436–12454).
 *
 * Pose 0 (resting/walking idle, `Misc1602 = 0`, left-facing `Misc157C = 1`):
 *   - 8×8  tile $98 at (−1, −8)   ← head left
 *   - 8×8  tile $99 at (+7, −8)   ← head right
 *   - 16×16 tile $A7 at (−4,  0)  ← body left  (4 chars: $A7,$A8,$B7,$B8)
 *   - 16×16 tile $A8 at (+4,  0)  ← body right (4 chars: $A8,$A9,$B8,$B9)
 *
 * Palette/charHigh: SumoBroGfx hard-codes `LDA #$34` then `ADC _2` with
 * carry set for tile != $66. Result `$35` = palette index 2 (CGRAM row
 * 8 + 2 = 10) and `c = 1` (charHigh = $100 within the OBJ tile bank).
 */
export class SumoBrotherAppearance extends StaticSpriteAppearance {
  static fromTables(chars: Map<number, Char>, placeholder: Char): SumoBrotherAppearance {
    const OBJ_BASE = 0x400
    const charHigh = 0x100
    const palette = 10 // CGRAM row 8 + (($34 >> 1) & 0x07) = 8 + 2 = 10

    const part = (tile: number, dx: number, dy: number): SpritePart => ({
      char: chars.get(OBJ_BASE + charHigh + (tile & 0x1ff)) ?? placeholder,
      palette,
      flipX: false,
      flipY: false,
      dx,
      dy,
    })

    // SNES 16×16 OBJ: base N → [N, N+1, N+$10, N+$11] at (0,0)/(8,0)/(0,8)/(8,8).
    const bigTile = (baseTile: number, bdx: number, bdy: number): SpritePart[] => [
      part(baseTile + 0x00, bdx, bdy),
      part(baseTile + 0x01, bdx + 8, bdy),
      part(baseTile + 0x10, bdx, bdy + 8),
      part(baseTile + 0x11, bdx + 8, bdy + 8),
    ]

    // Pose 0, left-facing (initial pose: 157C toggles to 1 at end of init's
    // state-3 attack window, so first pacing entry walks left).
    const parts: SpritePart[] = [
      part(0x98, -1, -8), // head L (8×8)
      part(0x99, 7, -8), // head R (8×8)
      ...bigTile(0xa7, -4, 0), // body L (16×16)
      ...bigTile(0xa8, 4, 0), // body R (16×16) - overlaps body L's right column
      // with identical chars ($A8/$B8); benign duplication
      // matches the in-game OAM layout.
    ]
    return new SumoBrotherAppearance(parts)
  }

  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
