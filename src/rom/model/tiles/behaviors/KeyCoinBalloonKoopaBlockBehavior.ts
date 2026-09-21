// Consumes: editorStore.cursorPx

import type { Char } from '../../chars/Char'
import type { CellBox, RenderTarget } from '../../RenderTarget'
import { editorStore } from '../../stores/editorStore'
import type { MapStore } from '../../stores/mapStore'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Tile $25 (Map16 low byte): position-dependent 4-item block.
 *
 * Block-hit dispatch (CODE_00F17F, bank_00.asm:12846) gives _5=$0B and
 * spawns sprite $7D (P-Balloon) via CODE_028752 → CODE_028922:1150
 * (LDA SpriteInBlock,Y; Y=$0B → $7D). Then CODE_028972 (bank_02.asm:
 * 1199-1212) re-checks SpriteNumber and, when it equals $7D, OVERRIDES
 * it based on the block's pixel-X bits [5:4]:
 *
 *   Y = (TouchBlockXPos & $30) >> 4         ; 0..3
 *   SpriteNumber = DATA_0288D6[Y]           ; bank_02.asm:1091
 *
 *   DATA_0288D6 = $80, $7E, $7D
 *   Y=3 reads past the table into DATA_0288D9[0] = $09
 *
 * Pixel-X bits [5:4] vary every 16 px = every 1 tile and wrap every 4
 * tiles, so the cycle is keyed by `col % 4`:
 *
 *   col % 4 == 0 → sprite $80 (Key)
 *   col % 4 == 1 → sprite $7E (Flying Red Coin)
 *   col % 4 == 2 → sprite $7D (P-Balloon)
 *   col % 4 == 3 → sprite $09 (Green Para-Koopa, via DATA_0288D9 overflow)
 *
 * Editor overlay renders the appropriate sprite chars 8 px above the
 * block (centered horizontally, shifted up 50% its height) so the tile's
 * own pixels cover the lower half = "peek from behind". Alpha is 0.5 at
 * rest, 1.0 when the cursor hovers the cell.
 */

export type Tile25Item = 'key' | 'redCoin' | 'pBalloon' | 'paraKoopa'

/** Pure per-column dispatch. Exported so tests / other tools can re-use it. */
export function tile25ItemAt(col: number): Tile25Item {
  switch (col & 3) {
    case 0:
      return 'key'
    case 1:
      return 'redCoin'
    case 2:
      return 'pBalloon'
    default:
      return 'paraKoopa'
  }
}

// PowerUpTiles (bank_01.asm:9528) → OBJ tile number. OBJ tile N occupies
// a 2x2 grid: chars [N, N+1, N+$10, N+$11]. Flat-char addressing depends
// on the OBJ-page bit in Sprite166EVals (bit 0): page 0 = SP1/SP2 base
// $400, page 1 = SP3/SP4 base $500 (per GfxLoader.ts:138).
//
//   $80 Key        : Sprite166EVals[$80]=$20 page 0; tile $EC → [$4EC, $4ED, $4FC, $4FD]
//   $7E Red Coin   : Sprite166EVals[$7E]=$28 page 0; tile $E8 → [$4E8, $4E9, $4F8, $4F9]
//   $7D P-Balloon  : Sprite166EVals[$7D]=$21 page 1; tile $E4 → [$5E4, $5E5, $5F4, $5F5]
//   $09 Para-Koopa : Sprite166EVals[$09]=$0A page 0;
//                    SprTilemap[SprTilemapOffset[$09]=$09]=$C8 → [$4C8, $4C9, $4D8, $4D9]
export const KEY_CHAR_NUMS = [0x4ec, 0x4ed, 0x4fc, 0x4fd] as const
export const REDCOIN_CHAR_NUMS = [0x4e8, 0x4e9, 0x4f8, 0x4f9] as const
export const PBALLOON_CHAR_NUMS = [0x5e4, 0x5e5, 0x5f4, 0x5f5] as const
export const PARAKOOPA_CHAR_NUMS = [0x4c8, 0x4c9, 0x4d8, 0x4d9] as const

// Sprite166EVals (bank_07.asm:792) → OAM attribute byte. The palette row
// is 8 + ((val & $0F) >> 1) & 7 (CGRAM rows 8-15 = OBJ palette 0-7).
//
//   $80 Key        : $20 → row 8
//   $7E Red Coin   : $28 → row 12
//   $7D P-Balloon  : $21 → row 8
//   $09 Para-Koopa : $0A → row 13
const KEY_PALETTE_ROW = 8
const REDCOIN_PALETTE_ROW = 12
const PBALLOON_PALETTE_ROW = 8
const PARAKOOPA_PALETTE_ROW = 13

const OVERLAY_OFFSETS = [
  { dx: 0, dy: -8 },
  { dx: 8, dy: -8 },
  { dx: 0, dy: 0 },
  { dx: 8, dy: 0 },
] as const

export class KeyCoinBalloonKoopaBlockBehavior implements TileBehavior {
  constructor(
    readonly quad: SubtileQuad,
    readonly keyChars: readonly (Char | null)[],
    readonly redCoinChars: readonly (Char | null)[],
    readonly pballoonChars: readonly (Char | null)[],
    readonly paraKoopaChars: readonly (Char | null)[],
  ) {}

  selectQuad(): SubtileQuad {
    return this.quad
  }

  itemAtCol(col: number): Tile25Item {
    return tile25ItemAt(col)
  }

  renderOverlay(target: RenderTarget, cell: CellBox, mapStore: MapStore): void {
    const col = cell.tl.x / 16
    const item = tile25ItemAt(col)
    const cursor = editorStore.cursorPx
    const alpha =
      cursor !== null &&
      cursor.x >= cell.tl.x &&
      cursor.x < cell.tl.x + 16 &&
      cursor.y >= cell.tl.y &&
      cursor.y < cell.tl.y + 16
        ? 1.0
        : 0.5

    let chars: readonly (Char | null)[]
    let row: number
    switch (item) {
      case 'key':
        chars = this.keyChars
        row = KEY_PALETTE_ROW
        break
      case 'redCoin':
        chars = this.redCoinChars
        row = REDCOIN_PALETTE_ROW
        break
      case 'pBalloon':
        chars = this.pballoonChars
        row = PBALLOON_PALETTE_ROW
        break
      case 'paraKoopa':
        chars = this.paraKoopaChars
        row = PARAKOOPA_PALETTE_ROW
        break
    }

    const paletteRow = mapStore.palette.row(row)
    for (let i = 0; i < 4; i++) {
      const ch = chars[i]
      if (!ch) continue
      const { dx, dy } = OVERLAY_OFFSETS[i]
      target.blit8x8(
        ch.getPixels(),
        { x: cell.tl.x + dx, y: cell.tl.y + dy },
        paletteRow,
        false,
        false,
        alpha,
      )
    }
  }
}
