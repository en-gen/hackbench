import type { SmwMap } from '../../../rom/model/SmwMap'

/**
 * Minimal Canvas2D subset needed by `drawSurfaces`. The union on
 * `strokeStyle` matches the browser's `CanvasRenderingContext2D` signature
 * so the actual 2D context passes structurally; the test mock assigns
 * only the `string` variant.
 */
export interface SurfaceDrawCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth:   number
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
}

const TILE_PX       = 16
const SURFACE_COLOR = '#ffeb3b'  // yellow — distinct from vine green / block-view tints
const LINE_WIDTH    = 2

/**
 * Switch palace state-dependent passthrough. Tile IDs `$06A-$06D` and
 * `$16A-$16D` are the four colors of switch palace block. Both ranges
 * share `SwitchPalaceAlternateBehavior` which renders the dotted "off"
 * quad at `switchPalaceState[color] === false` (default, palace not
 * hit) and the solid "on" quad at `state[color] === true`. Collision
 * in the overlay follows the visual: passable when dotted (default),
 * solid when toggled on.
 *
 * This is an editor preview convention, not a ROM runtime mechanism —
 * per the ASM deep-dive, the game's collision routines never consult
 * `SwitchPalaceColor`. Lives in this overlay file (not in `TileCollision`)
 * because the tile's `marioFloor` / `marioCeiling` / `marioWall` fields
 * are static classify-time values; palace state is runtime UI state.
 */
function switchPalacePassable(id: number, state: readonly boolean[]): boolean {
  const color =
    id >= 0x06A && id <= 0x06D ? id - 0x06A :
    id >= 0x16A && id <= 0x16D ? id - 0x16A :
    -1
  if (color < 0) return false
  return !state[color]
}

/**
 * Draw the "Show surfaces" overlay — a 2px yellow line along the top
 * edge of every L1 cell that is a Mario-floor (standable from above)
 * and along the bottom edge of every Mario-ceiling (bonkable from below).
 *
 * Reads `tile.collision.marioFloor` / `.marioCeiling` directly; the
 * Mario classify lives in `TileFactory.classify` via
 * `isMarioStandable` (bank_00.asm-derived exclusions). Additionally
 * applies `switchPalacePassable` so switch palace tiles obey the
 * editor's palace-state toggle.
 *
 * Silhouette rule: a floor line is drawn iff the cell at (c, r-1) is
 * not itself a Mario-floor. Without this, interior fill tiles inside a
 * solid mass draw stripes on every row. Ceiling line suppressed when
 * the cell at (c, r+1) is a Mario-ceiling.
 */
export function drawSurfaces(
  octx: SurfaceDrawCtx,
  map: SmwMap,
  switchPalaceState: readonly boolean[] = [false, false, false, false],
): void {
  const rows = map.l1.length
  if (rows === 0) return
  const cols = map.l1[0].length
  const marioFloorAt = (c: number, r: number): boolean => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false
    const id = map.l1[r]?.[c]
    if (id === null || id === undefined) return false
    const tile = map.l1Tiles.get(id)
    if (!tile) return false
    if (switchPalacePassable(tile.id, switchPalaceState)) return false
    return tile.collision.marioFloor
  }
  const marioCeilingAt = (c: number, r: number): boolean => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false
    const id = map.l1[r]?.[c]
    if (id === null || id === undefined) return false
    const tile = map.l1Tiles.get(id)
    if (!tile) return false
    if (switchPalacePassable(tile.id, switchPalaceState)) return false
    return tile.collision.marioCeiling
  }
  octx.save()
  octx.strokeStyle = SURFACE_COLOR
  octx.lineWidth   = LINE_WIDTH
  octx.beginPath()
  for (let r = 0; r < rows; r++) {
    const row = map.l1[r]
    for (let c = 0; c < cols; c++) {
      const id = row[c]
      if (id === null || id === undefined) continue
      const tile = map.l1Tiles.get(id)
      if (!tile) continue
      if (switchPalacePassable(tile.id, switchPalaceState)) continue
      const { marioFloor, marioCeiling } = tile.collision
      if (!marioFloor && !marioCeiling) continue
      const x = c * TILE_PX
      const y = r * TILE_PX
      if (marioFloor && !marioFloorAt(c, r - 1)) {
        octx.moveTo(x,            y)
        octx.lineTo(x + TILE_PX,  y)
      }
      if (marioCeiling && !marioCeilingAt(c, r + 1)) {
        octx.moveTo(x,            y + TILE_PX)
        octx.lineTo(x + TILE_PX,  y + TILE_PX)
      }
    }
  }
  octx.stroke()
  octx.restore()
}
