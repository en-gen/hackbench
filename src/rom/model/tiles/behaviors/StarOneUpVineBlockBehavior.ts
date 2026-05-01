// Consumes: editorStore.cursorPx

import type { Char } from '../../chars/Char'
import type { CellBox, RenderTarget } from '../../RenderTarget'
import { editorStore } from '../../stores/editorStore'
import type { MapStore } from '../../stores/mapStore'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Tile $1A (Map16 low byte): the 3-state item block that cycles star/1-up/
 * vine by screen-local column.
 *
 * Ports CODE_00F1AE (bank_00.asm:12868) via DATA_00F080[$09] = $81 (column
 * cycle, second-half offset) and DATA_00F100[16..31] = $07,$0A,$10 ...
 * which decodes (via SpriteInBlock) to:
 *   col % 16 % 3 == 0 → sprite $76 (star)
 *   col % 16 % 3 == 1 → sprite $78 (1-up mushroom)
 *   col % 16 % 3 == 2 → sprite $79 (vine)
 *
 * TouchBlockXPos (direct page $9A) is the low byte of the block's pixel X,
 * so the lookup wraps every 16 tiles = 1 screen. The pattern repeats
 * identically on every screen.
 *
 * Behavior draws the tile's own quad normally; `renderOverlay` draws the
 * appropriate vine / 1-up / star indicator 8 px above the block in the
 * pre-pass (so the tile's pixels cover the lower half = "peek from behind").
 * Alpha is 0.5 at rest, 1.0 when the cursor hovers the cell.
 */

export type ItemType = 'star' | '1up' | 'vine'

/** Pure per-column dispatch. Exported so tests / other tools can re-use it. */
export function starOneUpVineItemAt(col: number): ItemType {
  const m = (col % 16) % 3
  if (m === 0) return 'star'
  if (m === 1) return '1up'
  return 'vine'
}

// Sprite $78 (1-up): OBJ base tile $24 → chars $424/$425/$434/$435,
// palette row 13 (Sprite166EVals[$78]=$0A → 8+(0xA&7)=13).
export const ONEUP_CHAR_NUMS = [0x424, 0x425, 0x434, 0x435] as const
const ONEUP_PALETTE_ROW = 13

// Sprite $76 (star): OBJ base tile $48 → chars $448/$449/$458/$459,
// palette row 8 (Sprite166EVals[$76]=$20 → 8+(0&7)=8).
export const STAR_CHAR_NUMS = [0x448, 0x449, 0x458, 0x459] as const
const STAR_PALETTE_ROW = 8

const OVERLAY_OFFSETS = [
  { dx: 0, dy: -8 }, { dx: 8, dy: -8 },
  { dx: 0, dy:  0 }, { dx: 8, dy:  0 },
] as const

export class StarOneUpVineBlockBehavior implements TileBehavior {
  constructor(
    readonly quad: SubtileQuad,
    readonly vineOverlayQuad: SubtileQuad | null,
    readonly oneupChars: readonly (Char | null)[],
    readonly starChars: readonly (Char | null)[],
  ) {}

  selectQuad(): SubtileQuad { return this.quad }

  itemAtCol(col: number): ItemType {
    return starOneUpVineItemAt(col)
  }

  renderOverlay(target: RenderTarget, cell: CellBox, mapStore: MapStore): void {
    const col = cell.tl.x / 16
    const type = starOneUpVineItemAt(col)
    if (type === 'vine' && this.vineOverlayQuad) drawQuadOverlay(this.vineOverlayQuad, target, cell, mapStore)
    else if (type === '1up') drawCharsOverlay(this.oneupChars, ONEUP_PALETTE_ROW, target, cell, mapStore)
    else if (type === 'star') drawCharsOverlay(this.starChars, STAR_PALETTE_ROW, target, cell, mapStore)
  }
}

function indicatorAlpha(cell: CellBox): number {
  const cursor = editorStore.cursorPx
  if (cursor !== null
    && cursor.x >= cell.tl.x && cursor.x < cell.tl.x + 16
    && cursor.y >= cell.tl.y && cursor.y < cell.tl.y + 16) return 1.0
  return 0.5
}

function drawQuadOverlay(quad: SubtileQuad, target: RenderTarget, cell: CellBox, mapStore: MapStore): void {
  const alpha = indicatorAlpha(cell)
  for (let i = 0; i < 4; i++) {
    const { dx, dy } = OVERLAY_OFFSETS[i]
    quad[i].render(target, { x: cell.tl.x + dx, y: cell.tl.y + dy }, mapStore.palette, alpha)
  }
}

function drawCharsOverlay(chars: readonly (Char | null)[], paletteIdx: number, target: RenderTarget, cell: CellBox, mapStore: MapStore): void {
  const alpha = indicatorAlpha(cell)
  const paletteRow = mapStore.palette.row(paletteIdx)
  for (let i = 0; i < 4; i++) {
    const ch = chars[i]
    if (!ch) continue
    const { dx, dy } = OVERLAY_OFFSETS[i]
    target.blit8x8(ch.getPixels(), { x: cell.tl.x + dx, y: cell.tl.y + dy }, paletteRow, false, false, alpha)
  }
}
