import type { SmwMap } from '../../../rom/model/SmwMap'

/**
 * Minimal Canvas2D subset needed by `drawWalls`. Mirrors
 * `SurfaceDrawCtx` in `drawSurfaces.ts`; kept local to keep the two
 * overlay files decoupled.
 */
export interface WallDrawCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
}

const TILE_PX = 16
// Vivid purple - complement of the surfaces yellow (#ffeb3b) on the
// color wheel. The yellow/purple pair sits in a region SMW's palette
// barely uses, so both overlays pop cleanly against blue skies, green
// terrain, brown dirt, and red blocks without fighting any in-game hue.
const WALL_COLOR = '#d500f9'
const LINE_WIDTH = 2

/**
 * Switch palace state-dependent passthrough. See `drawSurfaces.ts` for
 * the design rationale - editor preview convention, not a ROM mechanism.
 * Copied (not shared) to keep overlay files decoupled; extract if a
 * third overlay ever needs the same rule.
 */
function switchPalacePassable(id: number, state: readonly boolean[]): boolean {
  const color =
    id >= 0x06a && id <= 0x06d ? id - 0x06a : id >= 0x16a && id <= 0x16d ? id - 0x16a : -1
  if (color < 0) return false
  return !state[color]
}

/**
 * Draw the "Show walls" overlay - a 2px purple line along the left edge
 * of every L1 cell whose `marioWall` is true AND whose left neighbour
 * is neither `marioWall` nor a slope cell, and symmetrically along the
 * right edge.
 *
 * Reads `tile.collision.marioWall` / `.slope` directly; the Mario
 * classify lives in `TileFactory.classify` and is gated by
 * `marioTileSolidity` (CODE_00F545 port) and the `isMarioStandable`
 * hand-list. See `src/rom/model/tiles/COLLISION.md` for derivation.
 *
 * Silhouette rule (vertical-edge variant): a left-face line is drawn
 * iff the cell at (c-1, r) is not itself a Mario-wall or slope, and a
 * right-face line iff (c+1, r) is neither. Without the wall half of
 * this rule, interior columns of a solid mass draw stripes on every
 * column. Without the slope half, a slope tile butting up against a
 * solid-fill column exposes a vertical face that the slope's diagonal
 * graphic actually covers - that was the stair-step artefact the Phase
 * 3 work removes. Slope cells themselves never draw vertical lines
 * (the `continue` on `!marioWall` below keeps them out); they only
 * suppress their neighbours' faces. Unlike surfaces, adjacency in the
 * Y-axis does NOT merge faces - a wall cell stacked on another wall
 * cell still exposes its left/right faces on both cells.
 */
export function drawWalls(
  octx: WallDrawCtx,
  map: SmwMap,
  switchPalaceState: readonly boolean[] = [false, false, false, false],
): void {
  const rows = map.l1.length
  if (rows === 0) return
  const cols = map.l1[0].length
  const wallishAt = (c: number, r: number): boolean => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false
    const id = map.l1[r]?.[c]
    if (id === null || id === undefined) return false
    const tile = map.l1Tiles.get(id)
    if (!tile) return false
    if (switchPalacePassable(tile.id, switchPalaceState)) return false
    return tile.collision.marioWall || tile.collision.slope !== undefined
  }
  octx.save()
  octx.strokeStyle = WALL_COLOR
  octx.lineWidth = LINE_WIDTH
  octx.beginPath()
  for (let r = 0; r < rows; r++) {
    const row = map.l1[r]
    for (let c = 0; c < cols; c++) {
      const id = row[c]
      if (id === null || id === undefined) continue
      const tile = map.l1Tiles.get(id)
      if (!tile) continue
      if (switchPalacePassable(tile.id, switchPalaceState)) continue
      if (!tile.collision.marioWall) continue
      const x = c * TILE_PX
      const y = r * TILE_PX
      if (!wallishAt(c - 1, r)) {
        octx.moveTo(x, y)
        octx.lineTo(x, y + TILE_PX)
      }
      if (!wallishAt(c + 1, r)) {
        octx.moveTo(x + TILE_PX, y)
        octx.lineTo(x + TILE_PX, y + TILE_PX)
      }
    }
  }
  octx.stroke()
  octx.restore()
}
