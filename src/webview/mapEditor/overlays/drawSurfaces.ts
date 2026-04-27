import type { GetL1Tile, L1Cell } from '../../../rom/model/OverlayContext'
import type { SmwMap } from '../../../rom/model/SmwMap'
import { buildSurfacePath, MARIO_HAS_FLOOR } from '../../../rom/model/SurfacePath'

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
 * edge of every L1 cell that is a Mario-floor (standable from above),
 * the bottom edge of every Mario-ceiling (bonkable from below), and a
 * pixel-accurate diagonal polyline along the collision surface of every
 * slope cell.
 *
 * Reads `tile.collision.marioFloor` / `.marioCeiling` / `.slope`
 * directly; the Mario classify lives in `TileFactory.classify` via
 * `isMarioStandable` + `resolveSlope` (bank_00.asm-derived).
 * Additionally applies `switchPalacePassable` so switch palace tiles
 * obey the editor's palace-state toggle.
 *
 * Silhouette rule: a floor line is drawn iff the cell at (c, r-1) is
 * not itself a Mario-floor. Without this, interior fill tiles inside a
 * solid mass draw stripes on every row. Ceiling line suppressed when
 * the cell at (c, r+1) is a Mario-ceiling.
 *
 * Slope polyline: when `tile.collision.slope` is defined, draw 16 line
 * segments tracing the ROM's `DATA_00E632` surface Y per pixel column.
 * Each cell emits an independent sub-path (no cross-tile connection) so
 * the visual matches the per-tile dispatch in `CODE_00ED86`. Slope
 * cells do NOT also draw a horizontal floor line — `marioFloor` is
 * `false` for slopes by design (feet-landing returns `'slope'`, not
 * `'land'`).
 */
export function drawSurfaces(
  octx: SurfaceDrawCtx,
  map: SmwMap,
  switchPalaceState: readonly boolean[] = [false, false, false, false],
): void {
  const rows = map.l1.length
  if (rows === 0) return
  const cols = map.l1[0].length

  // Adapter: SmwMap → GetL1Tile. SurfacePath only reads
  // `cell.collision` and `cell.isPriority`, so the synthetic L1Cell
  // doesn't need a real `actsLike` value (slot filled with 0).
  const getL1: GetL1Tile = (c, r) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null
    const id = map.l1[r]?.[c]
    if (id === null || id === undefined) return null
    const tile = map.l1Tiles.get(id)
    if (!tile) return null
    if (switchPalacePassable(tile.id, switchPalaceState)) return null
    return { id: tile.id, actsLike: 0, collision: tile.collision } as L1Cell
  }

  // Floor surfaces come from SurfacePath with the Mario predicate.
  // This is the SAME source of truth `KoopaWalkBehavior.scanBoundary`
  // consumes — silhouette suppression, slope-vs-flat classification,
  // priority-decorative passthrough are all decided in one place.
  const path = buildSurfacePath(getL1, cols, rows, { hasFloor: MARIO_HAS_FLOOR })

  // Pre-index path-emitted floor surfaces by (col, row) so the
  // row-major drawing loop below can decide silhouette inline without
  // re-running surfacesAt per cell. Each entry maps `${c},${r}` → the
  // SurfaceEntry, used to classify slope vs flat at draw time.
  const floorAt = new Map<string, ReturnType<typeof path.surfacesAt>[number]>()
  for (let c = 0; c < cols; c++) {
    for (const s of path.surfacesAt(c)) {
      floorAt.set(`${c},${s.floorRow}`, s)
    }
  }

  // Ceiling silhouette: still computed inline. Mario-side ceilings are
  // a symmetric concern (mirrored predicate, mirrored suppression rule)
  // but SurfacePath models floors only; ceilings are exclusive to this
  // overlay. Keeping the closure here avoids generalising SurfacePath
  // for one consumer.
  const marioCeilingAt = (c: number, r: number): boolean => {
    const cell = getL1(c, r)
    return cell?.collision?.marioCeiling ?? false
  }

  octx.save()
  octx.strokeStyle = SURFACE_COLOR
  octx.lineWidth   = LINE_WIDTH
  octx.beginPath()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = getL1(c, r)
      if (cell === null) continue
      const slope = cell.collision?.slope
      const x = c * TILE_PX
      const y = r * TILE_PX
      // Floor / slope: emit when SurfacePath identifies (c, r) as a
      // surface-bearing cell. Slope cells render their per-pixel curve
      // (heights[0..15]); flat cells render a horizontal silhouette top.
      if (floorAt.has(`${c},${r}`)) {
        if (slope) {
          // 16 sample points (one per pixel column) + a terminal lineTo
          // at the right tile edge so the polyline closes cleanly against
          // any horizontally-adjacent tile's collision. Heights are
          // ROM-derived 0..15 for the $6E-$D7 range; mask defensively
          // in case hacked ROMs seed out-of-range values.
          octx.moveTo(x, y + (slope.heights[0] & 0x0F))
          for (let px = 1; px < TILE_PX; px++) {
            octx.lineTo(x + px, y + (slope.heights[px] & 0x0F))
          }
          octx.lineTo(x + TILE_PX, y + (slope.heights[TILE_PX - 1] & 0x0F))
        } else {
          octx.moveTo(x,           y)
          octx.lineTo(x + TILE_PX, y)
        }
      }
      if (cell.collision?.marioCeiling && !marioCeilingAt(c, r + 1)) {
        octx.moveTo(x,           y + TILE_PX)
        octx.lineTo(x + TILE_PX, y + TILE_PX)
      }
    }
  }
  octx.stroke()
  octx.restore()
}
