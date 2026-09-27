/**
 * One Map16 cell as 16x16 RGBA, shared by the Map16 sheet and the map tab so
 * neither has drawing logic of its own: the sheet's own tile renderer
 * (`renderMap16Tile`, through the core resolver `composeTile`), plus the
 * hidden-tile overlay when the cell has one.
 */
import type { Map16Tile } from '../Map16'
import type { VramState } from '../GfxLoader'
import type { RgbaColor } from '../GraphicsDecoder'
import { renderMap16Tile, type TileRgba } from '../TileRenderer'
import { overlayHidden } from './HiddenTiles'

export function renderCell(
  def: Map16Tile,
  vram: VramState,
  palette: { colors: RgbaColor[] },
  hiddenAlt?: Uint8ClampedArray,
): TileRgba {
  const rgba = renderMap16Tile(def, vram, palette)
  if (hiddenAlt) overlayHidden(rgba, 16, 0, 0, hiddenAlt)
  return rgba
}
