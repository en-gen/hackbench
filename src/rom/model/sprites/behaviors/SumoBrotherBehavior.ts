import type { GetL1Tile } from '../../OverlayContext'
import { buildSurfacePath, type SurfaceEntry } from '../../SurfacePath'
import {
  MovementBehavior,
  type BehaviorMeta,
} from '../MovementBehavior'

/**
 * $9A Sumo Brother patrol-and-projectile behavior.
 *
 * State machine (per `CODE_02DCB7` dispatch in bank_02.asm:12286):
 *   - State 0 (CODE_02DCEA): pose-set wait until Misc1540 == 0
 *   - State 1 (CODE_02DCFF): brief 3-frame pose change before pacing
 *   - State 2 (CODE_02DD0E): horizontal pacing — sets X speed from
 *     `DATA_02DD0C[Misc157C]` ($20 / $E0 = +2 / -2 px/frame), with
 *     periodic standing pauses (`Misc1558 = $20`).
 *   - State 3 (CODE_02DD4B): 112-frame attack window; lightning spawns
 *     at frame Misc1540 == $2E. End of state 3 toggles `Misc157C`
 *     (CODE_02DD81: `EOR #$01`), flipping pacing direction next cycle.
 *
 * **Movement extent:** Each pacing cycle (`Misc1570` cycle of 0→1→2→3)
 * has roughly 8–10 active frames at 2 px/frame ≈ 16–20 px = ~1 tile.
 * Direction is constant within a cycle and only toggles when state 3
 * ends, so the sprite oscillates over a small fixed span centred on
 * its spawn position (no Mario-tracking, no ledge detection).
 *
 * **Lightning attack** (`GenSumoLightning`, bank_02.asm:12410): spawns
 * sprite $2B at (SpriteX + 4, SpriteY). The lightning falls vertically
 * at Y speed = $30 (`CODE_02DEB0`, bank_02.asm:12527 — 3 px/frame).
 *
 * **No-collide pass-through window**: at spawn time `Misc1FE2` is set
 * to $10 = 16 frames (bank_02.asm:12430-12431). The handler skips its
 * `JSL CODE_019138` collision check while `Misc1FE2 != 0`, so for the
 * first 16 frames the lightning falls *through* solid tiles. The
 * timer is decremented once per frame in the main sprite loop
 * (bank_01.asm:171). Fall distance during the window:
 * `16 frames × 3 px/frame = 48 px = 3 tiles`. This is the
 * gameplay reason a Sumo on a 1-tile-thick platform can hit the
 * ground below — the bolt clears the platform plus the next two
 * rows before any collision resolves.
 *
 * On ground contact (`SpriteBlockedDirs & 4`), `Misc1540` is set to
 * $22 and the sprite remains as "fire on ground" for 34 frames,
 * spawning **cluster fires** in 3 waves at frames 1540 ∈ {$21, $11,
 * $01} via `CODE_02DF2C` indexed by an incrementing `Misc1570`.
 * Cluster X offsets from the lightning are `DATA_02DF22 =
 * {$FC,$0C,$EC,$1C,$DC}` = signed `{−4, +12, −20, +28, −36}` →
 * 5 fires across SumoX + `{−32, −16, 0, +16, +32}` (lightning is at
 * SumoX+4). Each cluster fire is 16 px wide, so the resting fire
 * band spans **SumoX−32 to SumoX+48** (5 tiles) along the ground.
 *
 * Overlay vocabulary:
 *   - Dashed horizontal patrol line with end caps (turn-around extents)
 *   - Dashed vertical lightning-fall line from sprite bottom to ground
 *   - Dashed horizontal fire-spread band on the impact row
 */

/**
 * Half-width (in pixels) of the patrol band centered on the sprite.
 * Derived from the ASM analysis above: ~1 tile of net oscillation
 * around the spawn point in each direction.
 */
export const PATROL_HALF_PX = 16

/**
 * Cluster-fire X offsets from the lightning's X position, expanding
 * out to ±36 px across 5 spawn slots. Source: `DATA_02DF22`
 * (bank_02.asm:12578). Sign-extended via `DATA_02DF27` ($FF/$00).
 */
const CLUSTER_FIRE_DX_FROM_LIGHTNING = [-4, 12, -20, 28, -36] as const

/** Cluster fire sprite is rendered as a 16×16 tile. */
const CLUSTER_FIRE_WIDTH_PX = 16

/**
 * Number of tile rows the lightning passes through before its first
 * collision check fires. Derived from `Misc1FE2 = $10` × Y-speed
 * `$30 / 16 = 3 px/frame` ÷ 16 px/row = 3 rows.
 */
const NO_COLLIDE_ROWS = 3

export interface LightningFall {
  /**
   * True when a solid floor was found at or below the sprite in the
   * lightning's fall column. False means the lightning would fall
   * off the level; appearances should suppress all fire rendering.
   */
  hasFloor:  boolean
  /** X pixel of the lightning's vertical fall path (SumoX + 4). */
  fallX:     number
  /** Y where the fall begins — sprite bottom edge. */
  fallTopY:  number
  /** Y where the lightning stops on the ground (top of first solid row). */
  groundY:   number
  /** Left X of the cluster-fire band along the ground. */
  fireLeftX:  number
  /** Right X of the cluster-fire band along the ground. */
  fireRightX: number
  /**
   * Per-pixel surface polyline along the fire band, slope-aware. Each
   * entry is the surface Y at the corresponding `fireLeftX..fireRightX`
   * X coordinate. Empty when the band has no continuous floor below it.
   */
  surfacePoints: ReadonlyArray<readonly [x: number, y: number]>
}

export class SumoBrotherBehavior extends MovementBehavior {
  readonly kind = 'sumo_brother'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * Patrol range: left/right pixel bounds centered on the sprite's
   * spawn X. Total span ≈ 2 tiles (32 px), matching the in-game
   * oscillation: ~1 tile each way before the direction toggle in
   * `CODE_02DD81`.
   *
   * The bounds are clipped to the level width so the dashed line
   * doesn't extend off-map for a sprite spawned near an edge.
   */
  getPatrolRange(spriteX: number, levelCols: number): { leftX: number; rightX: number } {
    const levelPixels = levelCols * 16
    return {
      leftX:  Math.max(0,           spriteX + 8 - PATROL_HALF_PX),
      rightX: Math.min(levelPixels, spriteX + 8 + PATROL_HALF_PX),
    }
  }

  /**
   * Lightning attack geometry: the projectile fall path and the
   * resulting cluster-fire spread on the ground.
   *
   * Scans the L1 grid downward from the sprite's row to find the
   * first vertically solid floor (same predicate Thwomp uses for its
   * react-range floor). If no floor is found the band is anchored to
   * the level bottom — Mario can't be hit by fire below the playfield
   * either way, and the visual still communicates the attack.
   */
  getLightningFall(
    spriteX:   number,
    spriteY:   number,
    getL1:     GetL1Tile,
    levelCols: number,
    levelRows: number,
  ): LightningFall {
    const fallX     = spriteX + 4
    const fallTopY  = spriteY + 16
    const fallCol   = Math.max(0, Math.min(levelCols - 1, Math.floor((fallX + 8) / 16)))
    // Scan starts past the no-collide pass-through window (the
    // lightning's Misc1FE2 = $10 timer skips collision for ~3 tile
    // rows of fall; see the doc-comment above). The first row that
    // can actually stop the bolt is `spriteRow + 1 + NO_COLLIDE_ROWS`
    // — i.e. one row beyond Sumo's own body, plus the three rows
    // covered during the pass-through window.
    const startRow  = Math.floor(spriteY / 16) + 1 + NO_COLLIDE_ROWS

    // Use the same "any landable surface" predicate that
    // `solidityFromL1.solidV` and `buildSurfacePath` use — namely
    // `cell.collision.floor` (covers slopes $6E..$D7, hard floors, and
    // "solid from above" tiles per `CODE_01933B`). The narrower
    // `isActsLikeVertSolid` predicate excludes slopes, which would
    // make a Sumo over a sloped grass platform fail to find a floor.
    // Priority-decorative cells are filtered to match sprite collision
    // semantics (they pass through hard collision in this codebase).
    let blockerRow = levelRows
    for (let r = startRow; r < levelRows; r++) {
      const cell = getL1(fallCol, r)
      if (cell !== null && !cell.isPriority && cell.collision?.floor) {
        blockerRow = r
        break
      }
    }
    const hasFloor = blockerRow < levelRows
    // For slopes, refine the impact Y using the slope's per-pixel
    // heights at the lightning's X-within-tile column.
    let groundY = hasFloor ? blockerRow * 16 : levelRows * 16
    if (hasFloor) {
      const cell = getL1(fallCol, blockerRow)
      const slope = cell?.collision?.slope
      if (slope) {
        const px = (fallX - fallCol * 16 + 16) % 16
        groundY = blockerRow * 16 + (slope.heights[px]! & 0x0F)
      }
    }

    const levelPixels = levelCols * 16
    const fireLeftX   = Math.max(0,           fallX - 36)
    const fireRightX  = Math.min(levelPixels, fallX + 28 + CLUSTER_FIRE_WIDTH_PX)

    // Build a per-pixel surface polyline along the fire band so the
    // visual hugs the actual floor — including slopes — instead of
    // floating at a single uniform Y.
    const surfacePoints = computeFireSurface(
      getL1, levelCols, levelRows, startRow, fireLeftX, fireRightX,
    )

    return { hasFloor, fallX, fallTopY, groundY, fireLeftX, fireRightX, surfacePoints }
  }

  /** Cluster-fire spawn positions for editor markers (5 fires). */
  getClusterFireXs(spriteX: number, levelCols: number): readonly number[] {
    const lightningX = spriteX + 4
    const levelPixels = levelCols * 16
    return CLUSTER_FIRE_DX_FROM_LIGHTNING.map(dx => lightningX + dx)
      .filter(fx => fx >= 0 && fx + CLUSTER_FIRE_WIDTH_PX <= levelPixels)
  }

  /**
   * Lightning spawn X offset: `GenSumoLightning` (bank_02.asm:12417)
   * sets `SpriteXPosLow,Y = SpriteXPosLow,X + #$04`. The Y position
   * is unchanged from the parent.
   */
  getLightningSpawnX(spriteX: number): number {
    return spriteX + 4
  }
}

/**
 * Walk every column from `fireLeftX..fireRightX` and produce a polyline
 * tracking the first floor surface at or below `startRow`. Slope tiles
 * contribute per-pixel height samples (matching `patrolPath`'s
 * surface-following loop); flat tiles contribute the row top at the two
 * tile edges. Returns absolute pixel coordinates.
 *
 * The polyline ends at column boundaries where no surface exists below
 * the sprite's row (gaps/pits in the floor) — callers can split the
 * line into segments by detecting non-contiguous X values. For the
 * editor, we just treat each tile as its own segment and let the
 * stroker handle the breaks.
 */
function computeFireSurface(
  getL1:     GetL1Tile,
  levelCols: number,
  levelRows: number,
  startRow:  number,
  fireLeftX: number,
  fireRightX: number,
): ReadonlyArray<readonly [number, number]> {
  const path = buildSurfacePath(getL1, levelCols, levelRows)
  const startCol = Math.max(0, Math.floor(fireLeftX / 16))
  const endCol   = Math.min(levelCols, Math.ceil(fireRightX / 16))

  const points: Array<readonly [number, number]> = []

  for (let c = startCol; c < endCol; c++) {
    let surface: SurfaceEntry | null = null
    for (const s of path.surfacesAt(c)) {
      if (s.floorRow >= startRow) { surface = s; break }
    }
    if (!surface) continue

    const cell     = getL1(c, surface.floorRow)
    const slope    = cell?.collision?.slope
    const tileTopY = surface.floorRow * 16
    const tileX    = c * 16

    if (slope) {
      // Sample every other pixel — fine enough for the editor's pixel
      // grid and avoids 16×N polyline points per slope tile.
      for (let px = 0; px <= 16; px += 2) {
        const pxClamped = Math.min(15, px)
        points.push([tileX + px, tileTopY + (slope.heights[pxClamped]! & 0x0F)])
      }
    } else {
      points.push([tileX,      tileTopY])
      points.push([tileX + 16, tileTopY])
    }
  }

  return points
}
