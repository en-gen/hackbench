import {
  MovementBehavior,
  type BehaviorMeta,
  type SolidH,
  type SolidV,
} from '../MovementBehavior'
import { applyGravity, signed8, simulateUntilStable, unsigned8, type Rect } from './simulate'

/**
 * $1D Hopping Flame movement simulator — a direct port of the
 * `HoppingFlame` handler at bank_01.asm:2187.
 *
 * Per-frame loop (pre-handler decrement → handler → post-handler):
 *
 *   1. Pre-handler (bank_01.asm:157-159): decrement `SpriteMisc1540` if > 0.
 *
 *   2. Handler:
 *      a. `SubUpdateSprPos` (bank_01.asm:2322) applies current (X, Y) speed
 *         to position using `SubSprYPosNoGrvty` — Y speed is scaled × 16 and
 *         added to an 8-bit sub-pixel accumulator with carry into the main
 *         pixel position. Gravity (DATA_019030[0] = $03) is added to Y speed.
 *         (Also applies X speed via `SubSprXPosNoGrvty`.) Collision with L1
 *         tiles at the moved position sets `SpriteBlockedDirs` bits 0..3.
 *      b. `DEC.B SpriteYSpeed,X` (line 2193) — subtract 1 from Y speed,
 *         partially cancelling gravity (net +2/frame).
 *      c. `CODE_018DBB` (line 1999) sets X speed from facing:
 *            right (dir=0) → +$08,  left (dir=1) → -$08
 *      d. `ASL.B SpriteXSpeed,X` (line 2195) doubles it → ±$10 sub-px/frame
 *         (= ±1 px/frame since 1 px = 16 sub-px).
 *      e. `IsOnGround` check (`SpriteBlockedDirs & $04`):
 *           NOT on ground → fall through to FlipIfTouchingObj.
 *           ON GROUND:
 *             - `STZ.B SpriteXSpeed,X` — zero X speed (sprite sits still).
 *             - `SetSomeYSpeed__` — set Y speed to $00 (or $18 on slope).
 *             - Load SpriteMisc1540:
 *                 = 0 → roll new random countdown in $20..$3F.
 *                 = 1 → `CODE_018F50` launches upward with random
 *                       Y speed in $D0..$DF (-48..-33 signed sub-px/frame),
 *                       and (1/4 chance) faces Mario.
 *                 other → no-op this frame.
 *      f. `FlipIfTouchingObj` (line 2369): if moving direction is blocked
 *         (`(SpriteMisc157C + 1) & SpriteBlockedDirs & $03` ≠ 0), flip
 *         direction and negate X speed.
 *
 *   Horizontal solidity rule (CODE_01928E, bank_01.asm:2613): the collision
 *   scanner treats a tile as solid if `actsLike & $FF` is in `$11..$6D`.
 *   Decorative tiles (priority-1 forest columns, backdrop tubes, etc.) sit
 *   outside that range — they render in front of sprites but do not block
 *   motion. `isActsLikeHorizSolid` implements this check.
 *
 * The simulator returns the bounding rect of every position the sprite
 * visits over a full on-ground + hop cycle. The overlay uses this rect
 * directly — derived from spawn (x, y) and the L1 acts-like grid — so the
 * moment the sprite is repositioned (future editing) the overlay updates
 * without touching renderer code.
 */

export interface HopFlameBounds {
  /** Left edge of the reachable area, in level pixels. */
  readonly minX: number
  /** Right edge (exclusive of the wall tile) of the reachable area. */
  readonly maxX: number
  /** Top edge (lowest Y) — apex of the worst-case hop. */
  readonly minY: number
  /** Bottom edge — the sprite's resting row. */
  readonly maxY: number
  /** Resting Y pixel — top of the ground tile minus body height. */
  readonly groundY: number
}

/** One arc's worth of sampled (x, y) positions for overlay rendering. */
export type BouncePath = readonly { x: number; y: number }[]

/**
 * `SpriteBehavior` for sprite $1D. Carries standard metadata (via meta) and
 * exposes `simulateBounds` (envelope for overlay) plus `computeBouncePath`
 * (sampled apex positions for the visible arc polyline).
 */
export class HopFlameBehavior extends MovementBehavior {
  readonly kind = 'hop_flame'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * Simulate the HoppingFlame handler from spawn position until the
   * reachable bounds have clearly stabilised (several hop cycles in each
   * initial direction), then return the enclosing rect.
   */
  simulateBounds(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
  ): HopFlameBounds {
    // Run the sim twice — once facing right, once facing left — and union
    // the visited rects. The random countdown / launch speed vary in-game,
    // so use worst-case values to bound the reachable zone:
    //   - countdown: always 1 frame (fastest cycle, maximum hops per unit time)
    //   - launch speed: $D0 = -48 (fastest, highest apex)
    // These choices give the maximum-extent envelope rather than a single
    // random walk.
    const right = simulateCycle(spawnX, spawnY, /*dir*/ 0, solidH, solidV, levelCols, levelRows)
    const left  = simulateCycle(spawnX, spawnY, /*dir*/ 1, solidH, solidV, levelCols, levelRows)
    const groundY = Math.max(right.groundY, left.groundY)
    return {
      minX: Math.min(right.rect.minX, left.rect.minX),
      maxX: Math.max(right.rect.maxX, left.rect.maxX),
      minY: Math.min(right.rect.minY, left.rect.minY),
      // Bug-4 fix: the envelope's bottom edge is the resting row, not the
      // lowest point of any simulation frame. Airborne frames below ground
      // (caused by tunnelling through a too-small sub-pixel step) must not
      // bleed past the resting Y — clamp here so the overlay never reaches
      // below the ground tile.
      maxY: groundY + BODY_H,
      groundY,
    }
  }

  /**
   * Sample the bounce path for one hop cycle in each initial direction.
   * Returns an ordered list of points (ground → apex → next-ground) suitable
   * for drawing a polyline envelope of the visible hop arcs.
   */
  computeBouncePath(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
  ): BouncePath {
    const right = simulateCycle(spawnX, spawnY, /*dir*/ 0, solidH, solidV, levelCols, levelRows)
    const left  = simulateCycle(spawnX, spawnY, /*dir*/ 1, solidH, solidV, levelCols, levelRows)
    // Concatenate both paths so the overlay traces both initial directions.
    return [...left.path, ...right.path]
  }
}

// ── Per-frame simulation ────────────────────────────────────────────────────

const GRAVITY      = 3              // DATA_019030[0]
const GRAVITY_MAX  = 0x40           // DATA_01902E[0] — terminal velocity
const DEC_Y_PER    = 1              // `DEC.B SpriteYSpeed,X` in handler
const X_WALK_SPEED = 0x10           // CODE_018DBB ±$08 then ASL → ±$10
const LAUNCH_SPEED = -48            // $D0 (worst-case / maximum apex)

/** Sprite clipping box relative to spawn origin (sprite is 16×16 at y..y+15). */
const BODY_W = 16
const BODY_H = 16

interface SimState {
  /** Whole-pixel X/Y position (SpriteXPos/YPos). */
  x:     number
  y:     number
  /** 8-bit sub-pixel accumulators (SpriteX/YPosSpx). */
  sx:    number
  sy:    number
  /** Signed 8-bit X/Y speeds (SpriteX/YSpeed). */
  vx:    number
  vy:    number
  /** Facing direction: 0 = right, 1 = left. */
  dir:   number
  /** SpriteMisc1540 hop countdown. */
  ctr:   number
  /** true while the sprite is standing on a solid floor. */
  ground: boolean
  /** Which side (if any) a collision blocked us on this frame — matches the
   *  `SpriteBlockedDirs & $03` bits read by `FlipIfTouchingObj`. */
  blocked: 'left' | 'right' | null
}

interface CycleResult {
  rect:    Rect
  groundY: number
  path:    { x: number; y: number }[]
}

/**
 * Simulate the HoppingFlame handler for long enough to exhaust the
 * flame's reachable range. Terminates once several hops have elapsed with
 * the bounds growing by less than 1 px (i.e. direction change from wall
 * bounces has begun to cycle back over the same ground).
 */
function simulateCycle(
  spawnX:     number,
  spawnY:     number,
  initialDir: number,
  solidH:     SolidH,
  solidV:     SolidV,
  levelCols:  number,
  levelRows:  number,
): CycleResult {
  // Snap ground to the first solid row at or below the spawn — the sprite
  // starts on that row even if it was placed a few pixels in the air.
  const startCol = Math.floor((spawnX + 8) / 16)
  let groundRow = Math.floor((spawnY + BODY_H) / 16)
  for (let r = groundRow; r < levelRows; r++) {
    if (solidV(startCol, r)) { groundRow = r; break }
  }
  const restingY = groundRow * 16 - BODY_H   // body sits exactly on top

  const s: SimState = {
    x: spawnX, y: restingY,
    sx: 0, sy: 0,
    vx: 0, vy: 0,
    dir: initialDir,
    ctr: 0,        // fresh-spawn value — on-ground check rolls a countdown
    ground: true,
    blocked: null,
  }
  const rect: Rect = {
    minX: spawnX, maxX: spawnX + BODY_W,
    minY: restingY, maxY: restingY + BODY_H,
  }
  const path: { x: number; y: number }[] = []
  let wasGround = true

  simulateUntilStable(rect, () => {
    stepFrame(s, solidH, solidV, levelCols, levelRows)
    // Track bounds.
    if (s.x          < rect.minX) rect.minX = s.x
    if (s.x + BODY_W > rect.maxX) rect.maxX = s.x + BODY_W
    if (s.y          < rect.minY) rect.minY = s.y
    // NOTE: not expanding rect.maxY here — the envelope bottom is clamped
    // to resting Y by simulateBounds. Per-frame maxY extension would pull
    // the envelope below ground when vy carries us past resting Y before
    // applyYSpeed's collision clamp lands.

    // Path sample: record at every ground-contact transition and at the
    // apex of each hop (where vy crosses zero going from negative to
    // positive). This produces a compact arc polyline.
    if (s.ground && !wasGround) {
      path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })   // landing
    }
    if (!s.ground && wasGround) {
      path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })   // launch
    }
    wasGround = s.ground
  }, { stableFrames: 256, maxFrames: 4096 })

  return { rect, groundY: restingY, path }
}

/**
 * One frame of the handler, in order:
 *   pre-decrement → SubUpdateSprPos → DEC Y speed → set X speed → ASL X →
 *   on-ground branch → FlipIfTouchingObj.
 */
function stepFrame(
  s:          SimState,
  solidH:     SolidH,
  solidV:     SolidV,
  levelCols:  number,
  levelRows:  number,
): void {
  // 1. Pre-handler decrement (bank_01.asm:157-159). 1540 only decrements
  //    when non-zero, so once it hits 0 it stays there until on-ground
  //    code sets a new random.
  if (s.ctr > 0) s.ctr--

  // 2a. SubUpdateSprPos — apply speed to position, then gravity.
  applyXSpeed(s, solidH, levelCols)
  applyYSpeed(s, solidV, levelRows)
  s.vy = applyGravity(s.vy, GRAVITY, GRAVITY_MAX)

  // 2b. DEC.B SpriteYSpeed,X.
  s.vy = signed8(s.vy - DEC_Y_PER)

  // 2c / 2d. CODE_018DBB: X speed = ±$08 then ASL → ±$10.
  s.vx = s.dir === 0 ? +X_WALK_SPEED : -X_WALK_SPEED

  // 2e. IsOnGround check + on-ground handling.
  if (s.ground) {
    s.vx = 0                            // STZ.B SpriteXSpeed,X
    s.vy = 0                            // SetSomeYSpeed__ (flat ground: $00)
    if (s.ctr === 0) {
      // CODE_018F38 — roll new countdown. Use 2 for the shortest valid
      // cycle: next frame's pre-decrement brings ctr to 1, the on-ground
      // block sees ctr==1, and CODE_018F50 launches. Anything ≥ 2 gives
      // the same reachable envelope, just with more idle frames between
      // hops, which only extends sim time without changing bounds.
      s.ctr = 2
    } else if (s.ctr === 1) {
      // CODE_018F50 — launch! (Worst-case launch speed $D0 = -48.)
      s.vy = signed8(LAUNCH_SPEED)
      s.ground = false
      // The 1/4 chance of FaceMario is skipped — the simulator runs both
      // initial directions separately and unions the results.
    }
  }

  // 2f. FlipIfTouchingObj — if the wall in the direction-of-motion blocked us.
  if (s.blocked === (s.dir === 0 ? 'right' : 'left')) {
    s.dir = s.dir === 0 ? 1 : 0
    s.vx = -s.vx
    s.blocked = null
  }
}

/** Apply X speed to SpriteXPosSpx + SpriteXPos, resolving horizontal collision. */
function applyXSpeed(s: SimState, solidH: SolidH, levelCols: number): void {
  s.blocked = null
  if (s.vx === 0) return

  // Accumulate sub-pixels. Handler: ASL×4 on signed 8-bit speed → low 4 bits
  // of (speed * 16) appear as a signed 8-bit contribution to the sub-pixel
  // accumulator; high bits go directly into the whole-pixel delta.
  // Using full signed arithmetic gives the same end-of-frame position.
  const totalSub = s.vx * 16        // signed; for ±$10 that's ±256 per frame
  const newSx    = s.sx + totalSub
  const wholeDelta = Math.floor(newSx / 256)
  s.sx = unsigned8(newSx)

  const stepX = s.vx > 0 ? +1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextX = s.x + stepX
    // Check solidity at each row the body spans, on the leading edge.
    const leadingX = stepX > 0 ? nextX + BODY_W - 1 : nextX
    const col = Math.floor(leadingX / 16)
    const rowTop = Math.floor(s.y / 16)
    const rowBot = Math.floor((s.y + BODY_H - 1) / 16)
    let hit = false
    for (let r = rowTop; r <= rowBot; r++) {
      if (col < 0 || col >= levelCols) { hit = true; break }
      if (solidH(col, r)) { hit = true; break }
    }
    if (hit) {
      s.blocked = stepX > 0 ? 'right' : 'left'
      return
    }
    s.x = nextX
    remaining--
  }
}

/** Apply Y speed to SpriteYPosSpx + SpriteYPos, resolving vertical collision. */
function applyYSpeed(s: SimState, solidV: SolidV, levelRows: number): void {
  if (s.vy === 0) {
    // Still need to re-check ground state — a moving floor could have left us.
    s.ground = isSittingOnFloor(s, solidV, levelRows)
    return
  }
  const totalSub = s.vy * 16
  const newSy    = s.sy + totalSub
  const wholeDelta = Math.floor(newSy / 256)
  s.sy = unsigned8(newSy)

  const stepY = s.vy > 0 ? +1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextY = s.y + stepY
    // Leading edge row depends on direction: falling checks bottom, rising checks top.
    const leadingY = stepY > 0 ? nextY + BODY_H - 1 : nextY
    const row = Math.floor(leadingY / 16)
    const colL = Math.floor(s.x / 16)
    const colR = Math.floor((s.x + BODY_W - 1) / 16)
    let hit = false
    for (let c = colL; c <= colR; c++) {
      if (row < 0 || row >= levelRows) { hit = true; break }
      if (solidV(c, row)) { hit = true; break }
    }
    if (hit) {
      if (stepY > 0) {
        // Landed. Stop at the top of the blocking row.
        s.y = (row * 16) - BODY_H
        s.vy = 0
        s.sy = 0
        s.ground = true
      } else {
        // Hit ceiling — stop vertical motion, stay in air.
        s.y = (row + 1) * 16
        s.vy = 0
        s.sy = 0
      }
      return
    }
    s.y = nextY
    remaining--
  }
  s.ground = isSittingOnFloor(s, solidV, levelRows)
}

function isSittingOnFloor(s: SimState, solidV: SolidV, levelRows: number): boolean {
  const row = Math.floor((s.y + BODY_H) / 16)
  if (row >= levelRows) return false
  const colL = Math.floor(s.x / 16)
  const colR = Math.floor((s.x + BODY_W - 1) / 16)
  for (let c = colL; c <= colR; c++) {
    if (solidV(c, row)) return true
  }
  return false
}

/** Re-export solidityFromL1 so existing HopFlameAppearance keeps compiling. */
export { solidityFromL1, type SolidH, type SolidV } from '../MovementBehavior'
