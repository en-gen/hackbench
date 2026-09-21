/**
 * SurfacePath - pixel-accurate floor silhouette over an L1 grid, queried
 * with edge-to-edge matching so adjacent surface entries connect along
 * the same continuous polyline that `drawSurfaces` (the "Show surfaces"
 * editor overlay) draws.
 *
 * Why edge matching instead of mid-pixel sampling: at slope corners
 * where two slope tiles share a column boundary, mid-pixel sampling can
 * pick the wrong surface (the upper slope's mid-Y can be closer to the
 * koopa's previous mid-Y than the lower slope's, even when the koopa is
 * walking on the lower slope). The ROM's slope tables are designed so
 * the right-edge height of one tile equals the left-edge height of the
 * next - i.e. surfaces mate at boundaries with delta ≈ 0. Following
 * those edge values picks the same surface a designer would: the one
 * the koopa was walking on at the previous column.
 *
 * Design rules:
 *
 *   - Slopes contribute one entry per slope tile, with `yLeft` =
 *     `r*16 + heights[0]`, `yRight` = `r*16 + heights[15]`, `yMid` =
 *     `r*16 + heights[8]`. The full `heights` array stays available
 *     through the cell's `tile.collision.slope` for callers that need
 *     per-pixel rendering (the appearance polygon, the editor overlay).
 *
 *   - Non-slope floor tiles emit a surface only at the **silhouette
 *     top** - when the cell directly above is not also a floor. Without
 *     this, a tall solid pillar emits an entry on every interior row,
 *     and `nextSurface` would happily land the koopa inside the pillar
 *     when its tolerance window includes those interior rows. Slope
 *     tiles count as "floor above" for this suppression check; an
 *     adjacent slope-on-top-of-block stack already has its slope entry
 *     and doesn't need a duplicate from the block.
 *
 *   - Priority-decorative cells contribute nothing. They have
 *     `NO_COLLISION` already, but the priority short-circuit makes the
 *     intent explicit. Foreground grass / backdrop tubes / forest
 *     columns never form a walkable surface.
 *
 *   - Slope-info fallback. Test fixtures (and any cell built without a
 *     classification pass) won't have `tile.collision.slope` populated;
 *     they fall through to a flat silhouette emit (`yLeft = yRight =
 *     yMid = r*16`) so behavior tests using `buildSolidity` still see
 *     slope-range tiles as ground.
 */
import type { GetL1Tile, L1Cell } from './OverlayContext'

const TILE_PX = 16

/**
 * Default boundary-match tolerance. Vanilla SMW slopes mate at tile
 * boundaries with delta ≈ 0; single-tile vertical steps (flat-to-flat
 * down by one row) hit exactly 16. Anything beyond 16 px between
 * adjacent columns is geometrically a fall, not a step.
 */
export const DEFAULT_EDGE_TOLERANCE = 16

/**
 * Sprite-perspective floor predicate (default). Reads
 * `cell.collision.floor` - full CODE_01933B coverage including slopes.
 */
export const SPRITE_HAS_FLOOR = (cell: L1Cell): boolean => cell.collision?.floor ?? false

/**
 * Mario-perspective floor predicate. Reads `cell.collision.marioFloor`
 * - the editor's "Show surfaces" overlay uses this so the displayed
 * surface matches what Mario stops on, including spikes and slopes
 * but excluding climbables / coins / midway gates filtered by
 * `isMarioStandable`.
 */
export const MARIO_HAS_FLOOR = (cell: L1Cell): boolean => cell.collision?.marioFloor ?? false

export interface SurfacePathConfig {
  /**
   * Override the floor predicate. Defaults to sprite-side `floor`.
   * Use `MARIO_HAS_FLOOR` for editor overlays, or pass a custom
   * predicate to layer in extra filtering (e.g. switch palace state).
   */
  hasFloor?: (cell: L1Cell) => boolean
}

export interface SurfaceEntry {
  /** Surface pixel Y at the left edge of the cell - `floorRow*16 + heights[0]` for slopes, `floorRow*16` for flat. */
  readonly yLeft: number
  /** Surface pixel Y at the right edge of the cell - `floorRow*16 + heights[15]` for slopes, `floorRow*16` for flat. */
  readonly yRight: number
  /** Surface pixel Y at mid-column - `floorRow*16 + heights[8]` for slopes, `floorRow*16` for flat. */
  readonly yMid: number
  /** The L1 row that owns this surface (the floor tile / slope tile). */
  readonly floorRow: number
}

export interface SurfacePath {
  /**
   * All surface entries in column `c`, sorted by `yMid` top-down. Empty
   * for empty/out-of-bounds columns. Used for spawn-time floor lookup
   * and for tests that want to inspect raw geometry.
   */
  surfacesAt(c: number): readonly SurfaceEntry[]

  /**
   * Pick the surface entry in column `c` reachable by stepping from a
   * previous column along direction `dir`.
   *
   *   `prevExitY` is the previous column's edge Y on the side we step
   *   off - i.e. `prev.yLeft` when walking left (`dir = -1`) and
   *   `prev.yRight` when walking right (`dir = +1`).
   *
   *   The candidate's matching edge is on the OPPOSITE side: walking
   *   right, the koopa arrives at `c`'s left edge (`yLeft`); walking
   *   left, at `c`'s right edge (`yRight`).
   *
   * Returns the entry with the smallest `|arrivalY - prevExitY|` whose
   * delta is `<= tolerancePx`. Returns `null` if no entry matches.
   */
  nextSurface(c: number, prevExitY: number, dir: -1 | 1, tolerancePx?: number): SurfaceEntry | null
}

/**
 * Build a SurfacePath from an L1 grid accessor. Surfaces are computed
 * lazily per column and cached, so multiple sprite scans on the same
 * level share work without an explicit shared-instance plumbing.
 */
export function buildSurfacePath(
  getL1: GetL1Tile,
  cols: number,
  rows: number,
  config?: SurfacePathConfig,
): SurfacePath {
  const cache: (readonly SurfaceEntry[] | undefined)[] = new Array(cols)
  const hasFloor = config?.hasFloor ?? SPRITE_HAS_FLOOR

  function compute(c: number): readonly SurfaceEntry[] {
    if (c < 0 || c >= cols) return []
    const surfaces: SurfaceEntry[] = []
    let aboveIsFloor = false // tracks any-floor at (c, r-1) for silhouette suppression
    for (let r = 0; r < rows; r++) {
      const cell = getL1(c, r)
      // SurfacePath emits surfaces for ALL hasFloor cells, including
      // priority-decorative ones. SMW's sprite-tile collision routines
      // (CODE_01928E / CODE_0192C9 / CODE_01933B) and Mario's CODE_00F545
      // key off the Map16 tile's actsLike low byte - the priority bit is
      // a render-order flag, not a collision flag. Skipping priority cells
      // here previously collapsed level $11E patrol corridors when the
      // forest pillars (entirely priority columns) included the platform
      // tile $10D in the trunk's column.
      if (cell === null) {
        aboveIsFloor = false
        continue
      }
      const collision = cell.collision
      // Slope tiles ALWAYS emit a surface entry - they ARE the surface
      // by definition (DATA_00E632 surface-Y per pixel column). The
      // `hasFloor` predicate doesn't gate slopes: e.g. Mario's
      // `marioFloor` is false for slopes (feetLanding returns 'slope',
      // not 'land'), but the slope angle is still walkable and the
      // editor overlay still draws its diagonal line.
      if (collision?.slope) {
        const h = collision.slope.heights
        const base = r * TILE_PX
        surfaces.push({
          yLeft: base + (h[0] & 0x0f),
          yRight: base + (h[15] & 0x0f),
          yMid: base + (h[8] & 0x0f),
          floorRow: r,
        })
        // Slope tiles always have empty pixels above the surface line,
        // so the cell BELOW a slope can still emit its silhouette top
        // if the slope's lowest pixel doesn't reach the bottom edge -
        // but in practice slope tile + solid-below is the common case
        // and the slope's own entry already represents the surface.
        // We treat the slope as "floor above" for the next iteration so
        // the cell directly below doesn't double-emit.
        aboveIsFloor = true
        continue
      }
      if (!hasFloor(cell)) {
        aboveIsFloor = false
        continue
      }
      if (!aboveIsFloor) {
        surfaces.push({ yLeft: r * TILE_PX, yRight: r * TILE_PX, yMid: r * TILE_PX, floorRow: r })
      }
      aboveIsFloor = true
    }
    return surfaces
  }

  function getSurfaces(c: number): readonly SurfaceEntry[] {
    let s = cache[c]
    if (s === undefined) {
      s = compute(c)
      cache[c] = s
    }
    return s
  }

  return {
    surfacesAt(c) {
      return getSurfaces(c)
    },
    nextSurface(c, prevExitY, dir, tolerancePx = DEFAULT_EDGE_TOLERANCE) {
      const surfaces = getSurfaces(c)
      let best: SurfaceEntry | null = null
      let bestDist = Infinity
      for (const s of surfaces) {
        const arrivalY = dir > 0 ? s.yLeft : s.yRight
        const d = Math.abs(arrivalY - prevExitY)
        if (d <= tolerancePx && d < bestDist) {
          best = s
          bestDist = d
        }
      }
      return best
    },
  }
}
