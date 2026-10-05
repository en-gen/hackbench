/**
 * Where the Maps grid's lines fall inside the scroller's VIEWPORT, as pure
 * arithmetic (no DOM, no Theia). Three weights: a thin line on every 16x16
 * tile, a medium one on sub-screen boundaries, a thick one on screen
 * boundaries; where two coincide the heavier wins.
 *
 * Geometry, per orientation (tiles; `LevelParser.ts` holds the same constants):
 *  - horizontal level: a screen is 16 wide x 27 tall, screens side by side.
 *    The sub-screen boundary is ROW 16 of each screen (top 16 rows, bottom 11).
 *  - vertical level: a screen is 32 wide x 16 tall, screens stacked. The
 *    sub-screen boundary is COLUMN 16 (two 16-wide halves).
 * SMWDisX: the loader picks the half from byte 0 bit 4 of an object
 * ("Lower half of horizontal level" / "Right half of vertical level",
 * bank_05.asm:777-781); an entrance's Y (horizontal) or X (vertical) high
 * byte is the same 256 px half (DATA_05D730/05D740/05D750/05D758,
 * bank_05.asm:7044-7053); orientation decides which high byte survives
 * (bank_05.asm:7435-7451). Evidence and what was not traced:
 * docs/architecture/screens.md.
 *
 * Free of `@theia/core` so vitest loads it in CI (see grid-lines.ts).
 */
import { GridLine, GridLines, place } from './grid-lines'
import { SCREEN_H, SCREEN_H_VERT, SCREEN_W, SCREEN_W_VERT } from '../../../../src/rom/LevelParser'

export const TILE_GRID_WEIGHT = 1
export const SUBSCREEN_GRID_WEIGHT = 3
export const SCREEN_GRID_WEIGHT = 5
/** Content pixels per tile. */
export const MAP_TILE_PX = 16
/** Tile row (horizontal level) or column (vertical level) where a screen's halves meet. */
export const SUBSCREEN_SPLIT = 16

export interface ScreenTiles {
  cols: number
  rows: number
}

export function mapScreenTiles(vertical: boolean): ScreenTiles {
  return vertical
    ? { cols: SCREEN_W_VERT, rows: SCREEN_H_VERT }
    : { cols: SCREEN_W, rows: SCREEN_H }
}

/** The weight of the boundary before tile `index` on `axis` (tile units from the strip's origin). */
export function mapGridWeight(vertical: boolean, axis: 'x' | 'y', index: number): number {
  const { cols, rows } = mapScreenTiles(vertical)
  const per = axis === 'x' ? cols : rows
  const within = ((index % per) + per) % per
  if (within === 0) return SCREEN_GRID_WEIGHT
  // The split runs across the axis the halves are stacked on: rows in a
  // horizontal level, columns in a vertical one.
  const splitAxis = vertical ? 'x' : 'y'
  return axis === splitAxis && within === SUBSCREEN_SPLIT ? SUBSCREEN_GRID_WEIGHT : TILE_GRID_WEIGHT
}

export interface MapGridSpec {
  vertical: boolean
  screenCount: number
  /** CSS pixels per content pixel (may be fractional, e.g. Fit). */
  zoom: number
  /** Device pixels per CSS pixel. Default 1. */
  dpr?: number
  /** The scroller's scroll offsets and client size, CSS px. */
  scrollX: number
  scrollY: number
  viewW: number
  viewH: number
}

/**
 * Only the lines that touch the viewport. `pos` is the content CSS px of the
 * boundary (tile * 16 * zoom); `start`, `from`, `to` are device px relative to
 * the viewport's top left, so they paint straight onto a viewport-sized canvas.
 */
export function computeMapGridLines(spec: MapGridSpec): GridLines {
  const { vertical, screenCount, zoom, scrollX, scrollY, viewW, viewH } = spec
  const dpr = spec.dpr ?? 1
  const out: GridLines = { x: [], y: [] }
  if (!(zoom > 0) || !(dpr > 0) || !(screenCount > 0) || !(viewW > 0) || !(viewH > 0)) return out
  const s = mapScreenTiles(vertical)
  const cols = vertical ? s.cols : s.cols * screenCount
  const rows = vertical ? s.rows * screenCount : s.rows
  const step = MAP_TILE_PX * zoom
  const dev = (css: number): number => Math.round(css * dpr)
  const endX = dev(cols * step - scrollX)
  const endY = dev(rows * step - scrollY)
  const hiX = Math.min(dev(viewW), endX)
  const hiY = Math.min(dev(viewH), endY)
  if (hiX <= 0 || hiY <= 0) return out
  const one = (
    i: number,
    scroll: number,
    hi: number,
    end: number,
    axis: 'x' | 'y',
    across: [number, number],
  ): GridLine | undefined => {
    const pos = i * step
    const at = dev(pos - scroll)
    const weight = mapGridWeight(vertical, axis, i)
    // `place` pulls a lone pixel inside the range, which would turn an
    // off-screen thin line into a ghost on the viewport edge.
    if (weight === TILE_GRID_WEIGHT && !(at >= 0 && (at < hi || (at === hi && hi === end))))
      return undefined
    const p = place(at, weight, 0, hi)
    return p && { pos, weight, start: p[0], size: p[1], from: across[0], to: across[1] }
  }
  const ix0 = Math.max(0, Math.floor(scrollX / step) - 1)
  const ix1 = Math.min(cols, Math.ceil((scrollX + viewW) / step) + 1)
  for (let i = ix0; i <= ix1; i++) {
    const l = one(i, scrollX, hiX, endX, 'x', [0, hiY])
    if (l) out.x.push(l)
  }
  const iy0 = Math.max(0, Math.floor(scrollY / step) - 1)
  const iy1 = Math.min(rows, Math.ceil((scrollY + viewH) / step) + 1)
  for (let i = iy0; i <= iy1; i++) {
    const l = one(i, scrollY, hiY, endY, 'y', [0, hiX])
    if (l) out.y.push(l)
  }
  return out
}
