import type { GetL1Tile } from '../../OverlayContext'
import { buildSurfacePath, type SurfacePath, type SurfaceEntry } from '../../SurfacePath'
import {
  MovementBehavior,
  type BehaviorMeta,
  type SolidH,
  type SolidV,
} from '../MovementBehavior'

/**
 * $04-$07 / $0C / (any Spr0to13Main-handled) walking sprite — the classic
 * Koopa patrol. Derived from the `Spr0to13Main` handler at bank_01.asm:1659.
 *
 * The overlay only cares about where the sprite can walk, so the behavior
 * exposes a single `computePatrolRange` method that returns the left/right
 * pixel boundaries of the corridor. This is geometry-only (no per-frame
 * sim) because ground walkers only turn at walls or (with prop bit 1) at
 * ledges — both decidable from the L1 grid alone.
 *
 * The factory derives `KoopaWalkConfig` from `Spr0to13Prop[spriteId]`:
 *   bit 1 → turnsAtLedges  (matches `SpriteInAir` at bank_01.asm:1718
 *                           which calls FlipSpriteDir when sprite is
 *                           airborne and this bit is set)
 *   bit 6 → tall            (2-tile body; affects which L1 rows the wall
 *                           scan covers per Spr0to13Start:1649)
 *
 * Collision rules:
 *   - Walls:   `CODE_01928E` (bank_01.asm:2613) — `$11..$6D` range.
 *              Supplied by `solidH`.
 *   - Floors:  `CODE_01933B` (bank_01.asm:2705) — full landing path,
 *              including hard floors AND slopes `$6E..$D7`.
 *              Supplied by `solidV` (`collision.floor`).
 *
 * Priority-decorative tiles pass through in both predicates
 * (filtered upstream in `SmwMap.renderSpriteOverlays`'s getL1 closure).
 */

export interface KoopaWalkConfig {
  /** Spr0to13Prop bit 1 — true → sprite turns at ledge edges. */
  readonly turnsAtLedges: boolean
  /** Spr0to13Prop bit 6 — true → 2-tile-tall body; false → single-row (goomba). */
  readonly tall: boolean
  /**
   * Walk speed magnitude in sub-pixels/frame (signed 8-bit unsigned form —
   * always positive; sign applied by the direction toggle). Slow koopas
   * ($04–$07/$0C, all prop bit 6 = 1) use $0C = 12; fast ($0F Goomba,
   * prop bit 6 = 0) uses $08 = 8. Matches Spr0to13SpeedX bank_01.asm:1390
   * `db $08,$F8,$0C,$F4`.
   */
  readonly walkSpeed: number
}

/**
 * Classification of what the patrol scan hit on each side. `wall` stops
 * the patrol AND bounces the koopa. `turnLedge` is a ledge that a
 * turning koopa ($05/$06) treats as a wall. `fallLedge` is a ledge a
 * non-turning koopa ($04/$07/$0C) walks off — the one case where the
 * overlay draws an L. `levelEdge` is reached when the scan runs off the
 * level without finding any obstacle; the koopa walks off-screen and
 * eventually despawns, so no fall indicator is drawn.
 */
export type BoundaryKind = 'wall' | 'turnLedge' | 'fallLedge' | 'levelEdge'

export interface PatrolRange {
  leftX:  number
  rightX: number
  /** Top body row (levelPx) at the effective landing position. */
  topY:    number
  /** Bottom body row (levelPx) = effective floor Y. */
  bottomY: number
  leftKind:  BoundaryKind
  rightKind: BoundaryKind
  /**
   * True when the overlay should draw a solid boundary line on this side.
   * Encodes wall || turnLedge — both are stopping boundaries that the koopa
   * bounces off of. Computed here (where turnsAtLedges is known) so the
   * appearance layer reads a plain boolean instead of comparing kind strings.
   */
  solidLeft:  boolean
  solidRight: boolean
  /**
   * Which boundary the koopa actually falls off, or null. Factored in:
   *   - initial direction (koopas face left at spawn)
   *   - wall bounces (walks left → hits wall → reverses right)
   *   - ledge turns (turnsAtLedges=true bounces like a wall)
   * Null when: both boundaries are walls/turnLedges (perpetual patrol),
   * or the first boundary the koopa reaches is a level edge (despawns).
   */
  fallSide: 'left' | 'right' | null
  /**
   * When the sprite spawns airborne (above ground rather than on it),
   * the Y pixel of the spawn's body bottom. The overlay draws a dotted
   * line from this Y down to `bottomY` (effective floor) to show that
   * the sprite falls to its patrol surface before walking. Undefined
   * when the sprite is already on the ground at spawn.
   */
  spawnDropFromY?: number
}

const BODY_W = 16

/**
 * Derive `KoopaWalkConfig` from a sprite ID. Spr0to13Prop values at
 * bank_01.asm:1393 — hardcoded because the overlay is rendered pre-ROM-load
 * in tests and the prop table lookup belongs in the factory (which reads
 * from `SpriteTileLoader.ts#readSpriteTileTables`). Unknown IDs fall back
 * to a safe `(false, true)` pair (doesn't turn at ledges, tall body).
 */
export function propsFromSpriteId(id: number): KoopaWalkConfig {
  // Slow speed = $0C (prop bit 6 set); fast = $08.
  const SLOW = 0x0C, FAST = 0x08
  switch (id) {
    // Shelless Koopas ($00-$03) — Spr0to13Prop: $00,$02,$03,$0D (bank_01.asm:1393).
    // Prop bit 1 = "stay on ledges" (turnsAtLedges). No shell → short body (tall=false).
    case 0x00: return { turnsAtLedges: false, tall: false, walkSpeed: FAST }  // prop $00
    case 0x01: return { turnsAtLedges: true,  tall: false, walkSpeed: FAST }  // prop $02 — bit 1 set
    case 0x02: return { turnsAtLedges: true,  tall: false, walkSpeed: FAST }  // prop $03 — bit 1 set
    case 0x03: return { turnsAtLedges: false, tall: false, walkSpeed: FAST }  // prop $0D — bit 1 clear
    case 0x04: return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }  // prop $40
    case 0x05: return { turnsAtLedges: true,  tall: true,  walkSpeed: SLOW }  // prop $42
    case 0x06: return { turnsAtLedges: true,  tall: true,  walkSpeed: SLOW }  // prop $43
    case 0x07: return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }  // prop $45
    case 0x0C: return { turnsAtLedges: true,  tall: true,  walkSpeed: SLOW }  // prop $DD — yellow koopa w/ wings; observed to turn at ledges in-game
    case 0x0F: return { turnsAtLedges: false, tall: false, walkSpeed: FAST }  // prop $20 — Goomba
    default:   return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }
  }
}

export class KoopaWalkBehavior extends MovementBehavior {
  readonly kind = 'koopa_walk'
  readonly turnsAtLedges: boolean
  readonly tall: boolean
  readonly walkSpeed: number

  constructor(config: KoopaWalkConfig, meta?: BehaviorMeta) {
    super(meta)
    this.turnsAtLedges = config.turnsAtLedges
    this.tall = config.tall
    this.walkSpeed = config.walkSpeed
  }

  /**
   * Compute the patrol corridor + fall side for this sprite at spawn
   * (ax, ay). Scans each side from the spawn column and classifies the
   * boundary, then folds in initial-direction + wall-bounce logic to
   * decide which side the koopa actually falls off (if any).
   *
   * Ground koopas spawn facing LEFT (SMW default for Spr0to13Init), so
   * they walk left first. If left is a wall/turnLedge they bounce and
   * walk right. If left is a fallLedge they fall there; the right side
   * is never reached.
   */
  computePatrolRange(
    ax: number,
    ay: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
    getL1?: GetL1Tile,
  ): PatrolRange {
    const sprCol = Math.floor(ax / 16)

    // Spawn rows — the sprite's initial placement in the level data.
    const rowBotSpawn   = Math.floor(ay / 16)
    const spawnBodyBottomY = (rowBotSpawn + 1) * 16

    // Surface path is the unified floor-silhouette source — same data
    // the "Show surfaces" overlay renders. When `getL1` is unavailable
    // (ROM-less tests that still pass `solidV`), fall back to a row-
    // granular scan that mimics the surface path's column-step semantics
    // without slope geometry.
    const path: SurfacePath | null = getL1
      ? buildSurfacePath(getL1, levelCols, levelRows)
      : null

    // Spawn floor lookup — first surface in the spawn column whose
    // mid-Y lies at or below the sprite's spawn body bottom. The koopa
    // falls onto that surface before patrolling.
    let startSurface: SurfaceEntry | null = null
    if (path) {
      for (const s of path.surfacesAt(sprCol)) {
        if (s.yMid >= spawnBodyBottomY) { startSurface = s; break }
      }
    } else {
      let r = rowBotSpawn + 1
      while (r < levelRows && !solidV(sprCol, r)) r++
      if (r < levelRows) {
        const y = r * 16
        startSurface = { yLeft: y, yRight: y, yMid: y, floorRow: r }
      }
    }

    // No ground within the level — sprite falls off-screen. Cap the
    // effective floor at the world bottom so geometry stays finite; the
    // dotted drop line still draws to bottom.
    const startSurfaceY = startSurface?.yMid ?? levelRows * 16
    const floorRowEff   = startSurface?.floorRow ?? levelRows

    // Effective body — derived from floor row. For a 2-tall sprite,
    // body occupies rowTopEff..rowBotEff just above the floor. For a
    // 1-tall goomba, only rowBotEff matters.
    const rowBotEff = floorRowEff - 1
    const rowTopEff = this.tall ? rowBotEff - 1 : rowBotEff
    const topY      = rowTopEff * 16
    const bottomY   = floorRowEff * 16

    // Always scan both sides. Non-turning koopas ($04/$07/$0C) spawn facing
    // LEFT, but wall collision bounces them rightward (`CODE_01928E` flips
    // direction regardless of prop bit 1). If the left boundary is a wall
    // they walk the full right corridor before reaching a ledge or exit.
    const left  = this.scanBoundary(-1, sprCol, startSurface, path, solidH, solidV, levelCols, levelRows)
    const right = this.scanBoundary(+1, sprCol, startSurface, path, solidH, solidV, levelCols, levelRows)

    // Which side does the koopa actually fall off?
    //   Turning koopas ($05/$06): bounce at walls AND ledges → perpetual patrol → null.
    //   Non-turning ($04/$07/$0C): bounce at walls, fall at ledges.
    //     Spawn facing LEFT, so left boundary is reached first:
    //       left=fallLedge → falls left.
    //       left=wall      → bounces right → right=fallLedge → falls right.
    //       otherwise      → oscillates between walls or exits off-screen → null.
    const fallSide: 'left' | 'right' | null = (() => {
      if (this.turnsAtLedges) return null
      if (left.kind === 'fallLedge') return 'left'
      if (left.kind === 'wall' && right.kind === 'fallLedge') return 'right'
      return null
    })()

    // Spawn drop — if the sprite's initial body bottom is above the
    // effective floor, the sprite falls before it starts walking. The
    // overlay uses this to draw a dotted vertical line from spawn down
    // to the patrol row.
    const spawnDropFromY = spawnBodyBottomY < startSurfaceY ? spawnBodyBottomY : undefined

    return {
      leftX:  left.x,
      rightX: right.x,
      topY,
      bottomY,
      leftKind:  left.kind,
      rightKind: right.kind,
      solidLeft:  left.kind  === 'wall' || left.kind  === 'turnLedge',
      solidRight: right.kind === 'wall' || right.kind === 'turnLedge',
      fallSide,
      spawnDropFromY,
    }
  }

  /**
   * Scan one side of the patrol corridor and return the first obstacle's
   * x plus a classification. `dir` is -1 (leftward) or +1 (rightward).
   * `x` is the pixel x of the corridor boundary — `(c+1)*16` for left,
   * `c*16` for right. For `levelEdge` the scan reached the world
   * boundary without finding an obstacle and x is `0` or `levelCols*16`.
   *
   * Surface continuity is decided by `path.nextSurface`, which matches
   * the previous column's exit edge against each candidate's arrival
   * edge in column `c`. This connects two adjacent slope tiles along
   * the SAME continuous polyline drawn by "Show surfaces" — at slope
   * corners where two slopes share a column, the matching tile is the
   * one whose edge value continues the surface, not the one whose mid
   * happens to be closer.
   *
   * Wall check is an AABB sweep across the column transition: a solid
   * tile in column `c` blocks if it lies in the union of body rows at
   * the previous surface Y and the new surface Y. This catches the
   * "diagonal wall" case where a steep up-slope shifts the koopa's
   * body rows by 1 between adjacent columns and a wall block sits at
   * the destination row.
   *
   * Fallback (no `path`): row-granular search using `solidV` over a
   * ±DEFAULT_EDGE_TOLERANCE / 16 = ±1 row window — equivalent to the
   * old algorithm's window when slope geometry isn't available, but
   * driven by surface-Y delta rather than fixed row offsets.
   */
  private scanBoundary(
    dir:           -1 | 1,
    sprCol:        number,
    startSurface:  SurfaceEntry | null,
    path:          SurfacePath | null,
    solidH:        SolidH,
    solidV:        SolidV,
    levelCols:     number,
    levelRows:     number,
  ): { x: number; kind: BoundaryKind } {
    if (!startSurface) {
      return { x: dir > 0 ? levelCols * BODY_W : 0, kind: 'levelEdge' }
    }
    let prev: SurfaceEntry = startSurface

    const start = dir > 0 ? sprCol + 1 : sprCol - 1
    const end   = dir > 0 ? levelCols  : -1
    for (let c = start; dir > 0 ? c < end : c > end; c += dir) {
      // Edge-matched surface lookup: walking right uses the previous
      // cell's right edge as the arrival reference; walking left uses
      // its left edge.
      const prevExitY = dir > 0 ? prev.yRight : prev.yLeft
      const next = path
        ? path.nextSurface(c, prevExitY, dir)
        : findNextRowGranular(c, prev.floorRow, solidV, levelRows)

      // Wall check FIRST. A column that is solid top-to-bottom (a level-
      // bounding wall) has no floor surface — `nextSurface` returns null —
      // but the koopa still bounces off it. Wall classification must be
      // independent of surface continuity at the destination column. Use
      // `prev`'s body rows as the probe range when `next` is unknown.
      const rowBotPrev = prev.floorRow - 1
      const rowBotNext = (next ?? prev).floorRow - 1
      const rowTopPrev = this.tall ? rowBotPrev - 1 : rowBotPrev
      const rowTopNext = this.tall ? rowBotNext - 1 : rowBotNext
      const rTop = Math.max(0, Math.min(rowTopPrev, rowTopNext))
      const rBot = Math.min(levelRows - 1, Math.max(rowBotPrev, rowBotNext))
      for (let r = rTop; r <= rBot; r++) {
        if (solidH(c, r)) {
          return { x: dir > 0 ? c * BODY_W : (c + 1) * BODY_W, kind: 'wall' }
        }
      }

      // No wall at this column. If there's also no continuous surface, the
      // koopa walks off the edge (fallLedge / turnLedge depending on prop bit 1).
      if (next === null) {
        const kind: BoundaryKind = this.turnsAtLedges ? 'turnLedge' : 'fallLedge'
        return { x: dir > 0 ? c * BODY_W : (c + 1) * BODY_W, kind }
      }

      prev = next
    }
    return { x: dir > 0 ? levelCols * BODY_W : 0, kind: 'levelEdge' }
  }
}

/**
 * Row-granular fallback for the no-`getL1` case: find the first row at
 * column `c` whose `solidV` is true and whose row is within ±1 of the
 * previous floor row (matches the surface-path tolerance of 16 px).
 * Returns a synthesized flat-cell SurfaceEntry, or null on miss.
 */
function findNextRowGranular(
  c:        number,
  prevRow:  number,
  solidV:   SolidV,
  levelRows: number,
): SurfaceEntry | null {
  for (const r of [prevRow - 1, prevRow, prevRow + 1]) {
    if (r < 0 || r >= levelRows) continue
    if (solidV(c, r)) {
      const y = r * 16
      return { yLeft: y, yRight: y, yMid: y, floorRow: r }
    }
  }
  return null
}
