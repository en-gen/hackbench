import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $0E (Keyhole).
 *
 * KeyHoleGfx (bank_01.asm:13209) writes two hardcoded 8x8 OAM entries:
 *   tile $EB at (x+8, y)   -- attr $30: OBJ palette 0 = CGRAM row 8, charHigh 0, priority 3
 *   tile $FB at (x+8, y+8)
 *
 * InitKeyHole (bank_01.asm:13199) permanently adds +8 to SpriteXPosLow before
 * the main loop starts, so the tile positions already include that offset.
 * The generic SprTilemapOffset path picks the wrong tiles; this case overrides it.
 *
 * Extends StaticSpriteAppearance -> serializes as { kind:'static' }, no
 * changes to serialize.ts / rehydrate.ts needed.
 */
export class KeyholeAppearance extends StaticSpriteAppearance {
  static fromTables(chars: Map<number, Char>, placeholder: Char): KeyholeAppearance {
    const OBJ_BASE = 0x400
    const KEYHOLE_PAL = 8
    const parts: SpritePart[] = [
      { char: chars.get(OBJ_BASE + 0xEB) ?? placeholder, palette: KEYHOLE_PAL, flipX: false, flipY: false, dx: 8, dy: 0 },
      { char: chars.get(OBJ_BASE + 0xFB) ?? placeholder, palette: KEYHOLE_PAL, flipX: false, flipY: false, dx: 8, dy: 8 },
    ]
    return new KeyholeAppearance(parts)
  }
}
