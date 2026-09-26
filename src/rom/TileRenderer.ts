/**
 * Renders Map16 tiles to RGBA pixel data using loaded VRAM and palette.
 *
 * The pipeline for a single Map16 tile:
 *   1. For each of the 4 subtiles (TL, TR, BL, BR):
 *      a. Look up charNum in VRAM → 64 palette indices
 *      b. Apply X/Y flip, look up palette row + index → RGBA color, via the
 *         core's `composeTile` (src/rom/render/TileResolver.ts, #421 step 2
 *         - see its header).
 *   2. Composite 4 subtiles into a 16×16 RGBA block
 *
 * Color index 0 in any palette row is transparent.
 */

import { Map16Tile, SubTile } from './Map16'
import { VramState, getCharPixels } from './GfxLoader'
import { getPaletteColor } from './PaletteLoader'
import { RgbaColor } from './GraphicsDecoder'
import { composeTile } from './render/TileResolver'

const TILE_PX = 8 // 8×8 pixels per subtile
const MAP16_PX = 16 // 16×16 pixels per Map16 tile

/** RGBA bytes for one 16×16 Map16 tile (16*16*4 = 1024 bytes). */
export type TileRgba = Uint8ClampedArray

/**
 * Render one 8×8 subtile into an RGBA block.
 * `dest` is a 64-pixel (256-byte) buffer, written in row-major order.
 * Index 0 relies on `dest` starting fresh (zeroed): `composeTile` never
 * calls `put` for it, so those bytes are only correct because
 * `renderMap16Tile` always hands this a newly allocated buffer.
 */
function renderSubTile(
  sub: SubTile,
  vram: VramState,
  palette: { colors: RgbaColor[] },
  dest: Uint8ClampedArray,
  destOffset: number,
  destStride: number, // bytes per destination row (4 * MAP16_PX)
): void {
  const pixels = getCharPixels(vram, sub.charNum)
  if (!pixels) {
    // A char missing from VRAM entirely: magenta placeholder over the whole
    // subtile, not just its transparent pixels - there is no real index 0 to
    // distinguish it from.
    for (let py = 0; py < TILE_PX; py++)
      for (let px = 0; px < TILE_PX; px++) {
        const d = destOffset + py * destStride + px * 4
        dest[d] = 255
        dest[d + 1] = 0
        dest[d + 2] = 255
        dest[d + 3] = 128
      }
    return
  }
  const fields = { char: sub.charNum, flipX: sub.flipX ? 1 : 0, flipY: sub.flipY ? 1 : 0 }
  composeTile(
    fields,
    (_ch, x, y) => pixels[y * TILE_PX + x],
    (px, py, v) => {
      const color: RgbaColor = getPaletteColor(palette, sub.palette, v)
      const d = destOffset + py * destStride + px * 4
      dest[d] = color[0]
      dest[d + 1] = color[1]
      dest[d + 2] = color[2]
      dest[d + 3] = 255
    },
  )
}

/** Render a single Map16 tile to a 16×16 RGBA block (1024 bytes). */
export function renderMap16Tile(
  tile: Map16Tile,
  vram: VramState,
  palette: { colors: RgbaColor[] },
): TileRgba {
  const rgba = new Uint8ClampedArray(MAP16_PX * MAP16_PX * 4)
  const stride = MAP16_PX * 4

  // TL: top-left, pixel offset (0, 0)
  renderSubTile(tile.tl, vram, palette, rgba, 0, stride)
  // TR: top-right, pixel offset (8, 0)
  renderSubTile(tile.tr, vram, palette, rgba, TILE_PX * 4, stride)
  // BL: bottom-left, pixel offset (0, 8)
  renderSubTile(tile.bl, vram, palette, rgba, TILE_PX * stride, stride)
  // BR: bottom-right, pixel offset (8, 8)
  renderSubTile(tile.br, vram, palette, rgba, TILE_PX * stride + TILE_PX * 4, stride)

  return rgba
}

/**
 * Build a tile atlas: render every Map16 tile used in the level into a
 * flat RGBA sprite sheet, arranged as 16 tiles per row.
 *
 * Returns:
 *   - `atlas`: flat RGBA buffer (atlasWidth × atlasHeight × 4 bytes)
 *   - `atlasWidth`, `atlasHeight`: pixel dimensions
 *   - `tileUvs`: for each tile ID, the (col, row) position in the atlas
 */
export function buildTileAtlas(
  tiles: Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
  tilesPerRow = 16,
): {
  atlas: Uint8ClampedArray
  atlasWidth: number
  atlasHeight: number
  tileUvs: Map<number, { col: number; row: number }>
} {
  const rows = Math.ceil(tiles.length / tilesPerRow)
  const atlasWidth = tilesPerRow * MAP16_PX
  const atlasHeight = rows * MAP16_PX
  const atlas = new Uint8ClampedArray(atlasWidth * atlasHeight * 4)
  const tileUvs = new Map<number, { col: number; row: number }>()

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]
    const col = i % tilesPerRow
    const row = Math.floor(i / tilesPerRow)
    tileUvs.set(tile.id, { col, row })

    const tileRgba = renderMap16Tile(tile, vram, palette)

    // Blit 16×16 block into atlas
    for (let py = 0; py < MAP16_PX; py++) {
      const destY = row * MAP16_PX + py
      const srcOffset = py * MAP16_PX * 4
      const destOffset = (destY * atlasWidth + col * MAP16_PX) * 4
      atlas.set(tileRgba.subarray(srcOffset, srcOffset + MAP16_PX * 4), destOffset)
    }
  }

  return { atlas, atlasWidth, atlasHeight, tileUvs }
}
