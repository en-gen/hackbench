import type { Char } from '../../chars/Char'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9F - Banzai Bill. Renders the full 4×4 big-tile body (64×64 px)
 * from CODE_02D5E4 (bank_02.asm:11338).
 *
 * ROM sources:
 *   BanzaiBillTiles  (bank_02.asm:11331) - 16 base char numbers, row-major
 *   DATA_02D5A4      (bank_02.asm:11325) - 16 X offsets (0,16,32,48 × 4 rows)
 *   DATA_02D5B4      (bank_02.asm:11328) - 16 Y offsets (0,16,32,48 × 4 cols)
 *   DATA_02D5D4      (bank_02.asm:11334) - OAM attrs; $33 for all tiles, $B3 for
 *                    the last two (adds Y-flip). Written directly to OAMTileAttr,
 *                    bypassing SpriteOBJAttribute entirely.
 *
 * Each entry is a 16×16 OAM big-tile (hardware large-size expansion from
 * char N to [N, N+1, N+$10, N+$11]). The 4×4 grid covers the full bill body.
 *
 * Extends StaticSpriteAppearance so it serializes transparently as {kind:'static'}
 * - no changes to MapPayload / serialize / rehydrate needed.
 */
export class BanzaiBillAppearance extends StaticSpriteAppearance {
  // DATA_02D5D4 = $33 written as SNES hardware OAM attribute byte:
  //   bits 3-1 = OBJ palette 1  → CGRAM row 9
  //   bit  0   = name table 1   → SP3/SP4  → charHigh 0x100
  private static readonly OAM_ATTR = 0x33

  static fromTables(chars: Map<number, Char>, placeholder: Char): BanzaiBillAppearance {
    const oamAttr = BanzaiBillAppearance.OAM_ATTR
    const palette = 8 + ((oamAttr >> 1) & 0x07)
    const charHigh = (oamAttr & 0x01) !== 0 ? 0x100 : 0
    const parts: SpritePart[] = BANZAI_TILES.flatMap(([baseChar, dx, dy, yFlip]) =>
      expandBigTile(chars, baseChar, dx, dy, yFlip, palette, charHigh, placeholder),
    )
    return new BanzaiBillAppearance(parts)
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

const OBJ_CHAR_BASE = 0x400

// [baseChar, dx, dy, yFlip]
const BANZAI_TILES = [
  [0x80, 0, 0, false],
  [0x82, 16, 0, false],
  [0x84, 32, 0, false],
  [0x86, 48, 0, false],
  [0xa0, 0, 16, false],
  [0x88, 16, 16, false],
  [0xce, 32, 16, false],
  [0xee, 48, 16, false],
  [0xc0, 0, 32, false],
  [0xc2, 16, 32, false],
  [0xce, 32, 32, false],
  [0xee, 48, 32, false],
  [0x8e, 0, 48, false],
  [0xae, 16, 48, false],
  [0x84, 32, 48, true], // DATA_02D5D4 = $B3 → Y-flip
  [0x86, 48, 48, true], // DATA_02D5D4 = $B3 → Y-flip
] as const

function expandBigTile(
  chars: Map<number, Char>,
  baseChar: number,
  dx: number,
  dy: number,
  yFlip: boolean,
  palette: number,
  charHigh: number,
  placeholder: Char,
): SpritePart[] {
  const subDx = [0, 8, 0, 8]
  const subDy = yFlip ? [8, 8, 0, 0] : [0, 0, 8, 8]
  const charOff = yFlip ? [0x10, 0x11, 0x00, 0x01] : [0x00, 0x01, 0x10, 0x11]

  return [0, 1, 2, 3].map(i => ({
    char: chars.get(OBJ_CHAR_BASE + charHigh + ((baseChar + charOff[i]) & 0x1ff)) ?? placeholder,
    palette,
    flipX: false,
    flipY: yFlip,
    dx: dx + subDx[i],
    dy: dy + subDy[i],
  }))
}
