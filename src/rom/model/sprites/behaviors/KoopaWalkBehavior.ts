import {
  MovementBehavior,
  type BehaviorMeta,
  type HasGround,
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
 *   - Walls:   `CODE_01928E` (bank_01.asm:2613) — acts-like `$11..$6D`.
 *              Supplied by `solidH`.
 *   - Floors:  `CODE_01933B` (bank_01.asm:2705) — classifies anything
 *              with acts-like >= `$11` (including slopes `$6E..$D7`) as
 *              standable ground. Supplied by `hasGround`. Using `solidV`
 *              here would wrongly treat slopes as ledges because `solidV`
 *              is the narrower hard-solid range.
 *
 * Priority-decorative tiles pass through in all three predicates
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
  /** True when the left/right boundary is a wall tile (legacy flag, still used by overlay). */
  leftIsWall:  boolean
  rightIsWall: boolean
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
    case 0x04: return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }  // prop $40
    case 0x05: return { turnsAtLedges: true,  tall: true,  walkSpeed: SLOW }  // prop $42
    case 0x06: return { turnsAtLedges: true,  tall: true,  walkSpeed: SLOW }  // prop $43
    case 0x07: return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }  // prop $45
    case 0x0C: return { turnsAtLedges: false, tall: true,  walkSpeed: SLOW }  // prop $5C
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
    _solidV: SolidV,
    levelCols: number,
    levelRows: number,
    hasGround?: HasGround,
  ): PatrolRange {
    const sprCol = Math.floor(ax / 16)
    const floor  = hasGround ?? _solidV

    // Spawn rows — the sprite's initial placement in the level data.
    const rowBotSpawn   = Math.floor(ay / 16)
    const floorRowSpawn = rowBotSpawn + 1

    // Scan DOWN from the spawn's floor row to find the first row at the
    // spawn column that reads as walkable ground. Sprites placed in air
    // fall to the first ground tile and patrol from there; the overlay
    // should reflect that landing position, not the spawn row.
    let floorRowEff = floorRowSpawn
    while (floorRowEff < levelRows && !floor(sprCol, floorRowEff)) {
      floorRowEff++
    }
    // If no ground found within the level, the sprite falls offscreen —
    // cap the effective floor at the last row so downstream geometry
    // stays finite. The overlay's dotted drop line still extends to the
    // bottom, signalling the fall-to-nowhere case.
    if (floorRowEff >= levelRows) floorRowEff = levelRows

    // Effective body — where the koopa stands AFTER landing. For a
    // 2-tall sprite, body occupies rowTopEff..rowBotEff just above the
    // ground row. For a 1-tall goomba, only rowBotEff matters.
    const rowBotEff = floorRowEff - 1
    const rowTopEff = this.tall ? rowBotEff - 1 : rowBotEff
    const topY      = rowTopEff * 16
    const bottomY   = floorRowEff * 16

    const isWall = (c: number): boolean => {
      for (let r = Math.max(0, rowTopEff); r <= Math.min(levelRows - 1, rowBotEff); r++) {
        if (solidH(c, r)) return true
      }
      return false
    }
    // Ledge = floor ENDS. Uses `hasGround` (actsLike $11+, incl. slopes)
    // rather than `solidV`'s narrower range so slopes don't register as
    // ledges. Tolerance of +1 row below the effective floor catches
    // priority-decorative grass overlays with solid dirt one row down.
    const hasFloor = (c: number): boolean => {
      if (floorRowEff >= levelRows) return false
      if (floor(c, floorRowEff)) return true
      if (floorRowEff + 1 >= levelRows) return false
      return floor(c, floorRowEff + 1)
    }

    // Patrol scan direction(s):
    //   - `turnsAtLedges=false` koopas ($04/$07/$0C) walk left and fall
    //     off the first ledge — they never bounce back right, so the
    //     overlay doesn't visualise a right boundary. Right side clamps
    //     to the sprite's right edge.
    //   - `turnsAtLedges=true` koopas ($05 red, $06 blue) flip direction
    //     at walls AND at ledges (via `SpriteInAir` at bank_01.asm:1718),
    //     so they actually patrol between BOTH boundaries. Scan right too
    //     and draw a solid line on whichever side the koopa turns around.
    const left = this.scanBoundary(-1, sprCol, isWall, hasFloor, levelCols)
    const right = this.turnsAtLedges
      ? this.scanBoundary(+1, sprCol, isWall, hasFloor, levelCols)
      : { x: (sprCol + 1) * BODY_W, kind: 'levelEdge' as BoundaryKind }

    // L-fall only fires for non-turning koopas (turnsAtLedges=false),
    // and only on the LEFT — they never reach the right side.
    const fallSide: 'left' | 'right' | null =
      !this.turnsAtLedges && left.kind === 'fallLedge' ? 'left' : null

    // Spawn drop — if the sprite's initial body bottom is above the
    // effective floor, the sprite falls before it starts walking. The
    // overlay uses this to draw a dotted vertical line from spawn down
    // to the patrol row.
    const spawnBodyBottomY = (rowBotSpawn + 1) * 16
    const spawnDropFromY = spawnBodyBottomY < bottomY ? spawnBodyBottomY : undefined

    return {
      leftX:  left.x,
      rightX: right.x,
      topY,
      bottomY,
      leftKind:  left.kind,
      rightKind: right.kind,
      leftIsWall:  left.kind === 'wall',
      rightIsWall: right.kind === 'wall',
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
   */
  private scanBoundary(
    dir:       -1 | 1,
    sprCol:    number,
    isWall:    (c: number) => boolean,
    hasFloor:  (c: number) => boolean,
    levelCols: number,
  ): { x: number; kind: BoundaryKind } {
    const start = dir > 0 ? sprCol + 1 : sprCol - 1
    const end   = dir > 0 ? levelCols  : -1
    for (let c = start; dir > 0 ? c < end : c > end; c += dir) {
      if (isWall(c)) {
        return { x: dir > 0 ? c * BODY_W : (c + 1) * BODY_W, kind: 'wall' }
      }
      if (!hasFloor(c)) {
        const kind: BoundaryKind = this.turnsAtLedges ? 'turnLedge' : 'fallLedge'
        return { x: dir > 0 ? c * BODY_W : (c + 1) * BODY_W, kind }
      }
    }
    return { x: dir > 0 ? levelCols * BODY_W : 0, kind: 'levelEdge' }
  }
}
