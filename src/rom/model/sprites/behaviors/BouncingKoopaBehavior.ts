import type { GetL1Tile } from '../../OverlayContext'
import { MovementBehavior, type BehaviorMeta, type SolidH, type SolidV } from '../MovementBehavior'
import { spriteCollisionFromL1, type SpriteCollision } from '../SpriteCollision'
import { applyGravity, signed8, simulateUntilStable, unsigned8, type Rect } from './simulate'

/**
 * $09 Green Para-Koopa (bouncing) - GreenParaKoopa handler at
 * bank_01.asm:1817, taking the non-$08 branch at line 1835. Physics:
 *
 *   - SubUpdateSprPos applies vx/vy + gravity (+3/frame, clamp at $40)
 *   - DEC.B SpriteYSpeed,X subtracts 1 → net +2/frame gravity in air
 *   - CODE_018DBB (via Spr0to13SpeedX) sets vx from facing direction.
 *     Spr0to13SpeedX = db $08,$F8,$0C,$F4. $09 uses the fast indices 0/1:
 *       dir=0 (right) → vx=+$08
 *       dir=1 (left)  → vx=-$08
 *     These are NOT ASL-doubled (HopFlame is; this sprite's branch skips
 *     the ASL step that bank_01.asm:2195 applies to HopFlame).
 *   - IsOnGround: if true,
 *       - vx=0 (STZ)
 *       - vy=0 (SetSomeYSpeed__ flat-ground case)
 *       - ImmediateRelaunch: next frame SetSomeYSpeed__ picks vy from
 *         SpriteMisc160E:
 *           160E=0 → vy=$B0 (tall bounce, signed -80)
 *           160E≠0 → vy=$D0 (short bounce, signed -48)
 *         SpriteMisc160E is seeded at spawn from (SpriteYPosLow & $10),
 *         so the editor's overlay picks the worst-case tall bounce to
 *         bound the envelope.
 *   - FlipIfTouchingObj: blocked in direction-of-motion → flip dir,
 *     negate vx.
 *   - No hop countdown - unlike HopFlame, bounces every frame when on ground.
 *   - Prop $50 bit 1 = 0 → does NOT turn at ledges; falls off.
 *
 * The overlay draws the reachable envelope plus a polyline of bounce
 * peaks/landings. Both derive from a single simulation pass.
 */

export interface BouncingEnvelope {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
  readonly groundY: number
}

export const BOUNCE_TALL_VY = -80 // $B0 signed - bounceSeed=0   (tall)
export const BOUNCE_SHORT_VY = -48 // $D0 signed - bounceSeed=$10 (short)
export const BOUNCE_XSPEED = 0x08 // Spr0to13SpeedX index 0 (not ASL'd)
const GRAVITY = 3
const GRAVITY_MAX = 0x40
const DEC_Y_PER = 1
const BODY_W = 16
const BODY_H = 16

export type BounceMode = 'tall' | 'short'

/**
 * Derive the per-spawn bounce mode from a sprite's Y pixel position.
 * Mirrors `InitGrnBounceKoopa` bank_01.asm:840:
 *
 *     LDA SpriteYPosLow,X
 *     AND #$10
 *     STA SpriteMisc160E,X
 *
 * The branch at bank_01.asm:1857-1862 then dispatches: misc160E=0 → vy=$B0
 * (tall, ~100 px apex), misc160E=$10 → vy=$D0 (short, ~37 px apex).
 * Spawn rows alternate by parity - even rows tall, odd rows short.
 *
 * Position-derived, so this is a *display* property, not an editable config:
 * a sprite editor can show "bounce: short (Y bit 4 set)" but should not let
 * the user override it without moving the sprite.
 */
export function bounceModeFromSpawnY(spawnY: number): BounceMode {
  return (spawnY & 0x10) === 0 ? 'tall' : 'short'
}

export class BouncingKoopaBehavior extends MovementBehavior {
  readonly kind = 'bouncing_koopa'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /** Display helper - same value the simulator uses internally. */
  bounceModeAt(spawnY: number): BounceMode {
    return bounceModeFromSpawnY(spawnY)
  }

  simulateArc(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
    getL1?: GetL1Tile,
  ): BouncingEnvelope {
    const seed = bounceModeFromSpawnY(spawnY) === 'short' ? 0x10 : 0
    const right = simulateCycle(
      spawnX,
      spawnY,
      0,
      seed,
      solidH,
      solidV,
      levelCols,
      levelRows,
      getL1,
    )
    const left = simulateCycle(spawnX, spawnY, 1, seed, solidH, solidV, levelCols, levelRows, getL1)
    const groundY = Math.max(right.groundY, left.groundY)
    return {
      minX: Math.min(right.rect.minX, left.rect.minX),
      maxX: Math.max(right.rect.maxX, left.rect.maxX),
      minY: Math.min(right.rect.minY, left.rect.minY),
      // Clamp envelope bottom to resting row (same regression guard as
      // HopFlameBehavior: airborne sub-pixel frames shouldn't widen maxY
      // into the ground tile).
      maxY: groundY + BODY_H,
      groundY,
    }
  }

  computeBouncePath(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
    getL1?: GetL1Tile,
  ): { x: number; y: number }[] {
    const seed = bounceModeFromSpawnY(spawnY) === 'short' ? 0x10 : 0
    const r = simulateCycle(spawnX, spawnY, 0, seed, solidH, solidV, levelCols, levelRows, getL1)
    const l = simulateCycle(spawnX, spawnY, 1, seed, solidH, solidV, levelCols, levelRows, getL1)
    return [...l.path, ...r.path]
  }

  /**
   * Per-frame `(centerX, centerY)` polyline for the toward-Mario direction
   * only. Densely sampled - every simulated frame contributes a point -
   * so the renderer can stroke a smooth dashed arc through the trajectory
   * the koopa actually follows in-game.
   *
   * Direction comes from `SubHorizPos` semantics (bank_01.asm:847-850 →
   * `FaceMario` init for $09): the koopa walks TOWARD Mario's spawn X.
   *   - Mario to the LEFT  of sprite (spawnX > marioSpawnX) → dir=1 (left)
   *   - Mario to the RIGHT of sprite (spawnX <= marioSpawnX) → dir=0 (right)
   *
   * `marioSpawnX` defaults to 0 (level-edge fallback when the caller
   * hasn't parsed Mario's spawn) - for typical horizontal levels Mario
   * enters at the left, so this default still produces the correct
   * "face left" behavior for any sprite past column 0.
   */
  computeBouncePolyline(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
    marioSpawnX: number = 0,
    getL1?: GetL1Tile,
  ): { points: { x: number; y: number }[]; openEnd: boolean } {
    const seed = bounceModeFromSpawnY(spawnY) === 'short' ? 0x10 : 0
    const dir = spawnX > marioSpawnX ? 1 : 0
    return simulateCyclePolyline(
      spawnX,
      spawnY,
      dir,
      seed,
      solidH,
      solidV,
      levelCols,
      levelRows,
      getL1,
    )
  }
}

// ── Simulation internals ────────────────────────────────────────────────────

export interface BouncingState {
  x: number
  y: number
  sx: number
  sy: number
  vx: number
  vy: number
  dir: number
  ground: boolean
  /** SpriteMisc160E - seeded from spawn-Y bit 4. Drives tall vs short bounce. */
  misc160E: number
  blocked: 'left' | 'right' | null
  /**
   * True once the sprite has stepped past the level edge (off-grid X or
   * past the level bottom). Off-grid is not a wall - the sprite continues
   * moving - but the simulator uses this flag to terminate the polyline
   * sample loop, since the path becomes irrelevant once the koopa exits
   * the playfield.
   */
  offgrid: boolean
}

/** Test-only state factory. Mirrors the `SimState` used by simulateCycle. */
export function makeFreshState(init: {
  x: number
  y: number
  ground: boolean
  misc160E: number
  dir?: number
  vx?: number
  vy?: number
}): BouncingState {
  return {
    x: init.x,
    y: init.y,
    sx: 0,
    sy: 0,
    vx: init.vx ?? 0,
    vy: init.vy ?? 0,
    dir: init.dir ?? 0,
    ground: init.ground,
    misc160E: init.misc160E,
    blocked: null,
    offgrid: false,
  }
}

/** Test-only wrapper around one simulation frame (no slope correction). */
export function stepFrameForTest(
  s: BouncingState,
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
): void {
  stepFrame(s, solidH, solidV, levelCols, levelRows)
}

interface CycleResult {
  rect: Rect
  groundY: number
  path: { x: number; y: number }[]
}

function simulateCycle(
  spawnX: number,
  spawnY: number,
  initialDir: number,
  bounceSeed: 0 | 0x10,
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
  getL1?: GetL1Tile,
): CycleResult {
  const collision = getL1 ? spriteCollisionFromL1(getL1) : undefined
  const startCol = Math.floor((spawnX + 8) / 16)
  const startRow = Math.floor((spawnY + BODY_H) / 16)
  const groundRow = collision?.findFloorRowBelow(startCol, startRow, levelRows) ?? startRow
  const restingY =
    (collision?.surfaceYAt(spawnX + BODY_W / 2, groundRow) ?? groundRow * 16) - BODY_H

  const s: BouncingState = {
    x: spawnX,
    y: restingY,
    sx: 0,
    sy: 0,
    vx: 0,
    vy: 0,
    dir: initialDir,
    ground: true,
    misc160E: bounceSeed,
    blocked: null,
    offgrid: false,
  }
  const rect: Rect = {
    minX: spawnX,
    maxX: spawnX + BODY_W,
    minY: restingY,
    maxY: restingY + BODY_H,
  }
  const path: { x: number; y: number }[] = []
  let wasGround = true

  simulateUntilStable(
    rect,
    () => {
      stepFrame(s, solidH, solidV, levelCols, levelRows, getL1)
      if (s.x < rect.minX) rect.minX = s.x
      if (s.x + BODY_W > rect.maxX) rect.maxX = s.x + BODY_W
      if (s.y < rect.minY) rect.minY = s.y
      // maxY capped via envelope clamp in simulateArc.
      if (s.ground && !wasGround) path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })
      if (!s.ground && wasGround) path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })
      wasGround = s.ground
    },
    { stableFrames: 256, maxFrames: 4096 },
  )

  return { rect, groundY: restingY, path }
}

function stepFrame(
  s: BouncingState,
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
  getL1?: GetL1Tile,
): void {
  // 1. SubUpdateSprPos - apply speed, then gravity.
  applyXSpeed(s, solidH, levelCols)
  applyYSpeed(s, solidV, levelRows, getL1)
  s.vy = applyGravity(s.vy, GRAVITY, GRAVITY_MAX)

  // 2. DEC.B SpriteYSpeed,X
  s.vy = signed8(s.vy - DEC_Y_PER)

  // 3. Spr0to13SpeedX: ±$08 (no ASL for $09).
  s.vx = s.dir === 0 ? +BOUNCE_XSPEED : -BOUNCE_XSPEED

  // 4. IsOnGround + immediate relaunch.
  if (s.ground) {
    s.vx = 0 // STZ SpriteXSpeed,X
    // SetSomeYSpeed__: pick launch vy based on misc160E.
    s.vy = s.misc160E === 0 ? BOUNCE_TALL_VY : BOUNCE_SHORT_VY
    s.ground = false
  }

  // 5. FlipIfTouchingObj - wall in direction of motion flips dir.
  if (s.blocked === (s.dir === 0 ? 'right' : 'left')) {
    s.dir = s.dir === 0 ? 1 : 0
    s.vx = -s.vx
    s.blocked = null
  }
}

export function applyXSpeed(s: BouncingState, solidH: SolidH, levelCols: number): void {
  s.blocked = null
  if (s.vx === 0) return
  const totalSub = s.vx * 16
  const newSx = s.sx + totalSub
  const wholeDelta = Math.floor(newSx / 256)
  s.sx = unsigned8(newSx)

  const stepX = s.vx > 0 ? +1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextX = s.x + stepX
    const leadingX = stepX > 0 ? nextX + BODY_W - 1 : nextX
    const col = Math.floor(leadingX / 16)
    const rowTop = Math.floor(s.y / 16)
    const rowBot = Math.floor((s.y + BODY_H - 1) / 16)
    // Off-grid columns are NOT walls - sprites that walk off the level edge
    // continue moving (and eventually despawn). The simulator records the
    // off-grid transition so the polyline loop can stop sampling, but it
    // does NOT block or flip direction.
    if (col < 0 || col >= levelCols) {
      s.x = nextX
      s.offgrid = true
      return
    }
    let hit = false
    for (let r = rowTop; r <= rowBot; r++) {
      if (solidH(col, r)) {
        hit = true
        break
      }
    }
    if (hit) {
      s.blocked = stepX > 0 ? 'right' : 'left'
      return
    }
    s.x = nextX
    remaining--
  }
}

export function applyYSpeed(
  s: BouncingState,
  solidV: SolidV,
  levelRows: number,
  getL1?: GetL1Tile,
): void {
  const collision = getL1 ? spriteCollisionFromL1(getL1) : undefined
  if (s.vy === 0) {
    s.ground = sittingOnFloor(s, solidV, levelRows, collision)
    return
  }
  const totalSub = s.vy * 16
  const newSy = s.sy + totalSub
  const wholeDelta = Math.floor(newSy / 256)
  s.sy = unsigned8(newSy)

  const stepY = s.vy > 0 ? +1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextY = s.y + stepY
    const leadingY = stepY > 0 ? nextY + BODY_H - 1 : nextY
    const row = Math.floor(leadingY / 16)
    // Off-grid Y is NOT a floor or ceiling - sprites that fall past the
    // level bottom keep falling (and despawn). Set the offgrid flag and
    // continue moving so the polyline shows the sprite leaving the
    // playfield. The polyline simulator stops sampling once off-grid.
    if (row < 0 || row >= levelRows) {
      s.y = nextY
      s.offgrid = true
      return
    }
    const colL = Math.floor(s.x / 16)
    const colR = Math.floor((s.x + BODY_W - 1) / 16)
    let hit = false
    if (stepY > 0) {
      // Falling: any solidV (floor) tile blocks. Includes the slope range
      // ($6E-$D7) which has floor=true - `getSurfaceY` below snaps the
      // sprite to the per-pixel slope surface at its center X.
      for (let c = colL; c <= colR; c++) {
        if (solidV(c, row)) {
          hit = true
          break
        }
      }
    } else if (collision) {
      // Ascending: only `ceiling` tiles bonk the sprite. Slopes
      // ($6E-$D7) and the high-solid range ($D8+) have floor=true but
      // ceiling=false (per CODE_0192C9 Y=3, ROM ceiling range is
      // $11-$6D + the $C4-$C9 tileset window). Using solidV here would
      // mistakenly snap an ascending sprite DOWN below a rising slope,
      // dropping it into the void - the cause of the level $006
      // bouncing-Para-Goomba glitch.
      for (let c = colL; c <= colR; c++) {
        if (collision.ceilingV(c, row)) {
          hit = true
          break
        }
      }
    } else {
      // Legacy fallback when getL1 isn't supplied (synthetic test grids
      // without per-tile collision metadata): use solidV. Slopes are not
      // present in those fixtures so the misfire described above can't
      // trigger here.
      for (let c = colL; c <= colR; c++) {
        if (solidV(c, row)) {
          hit = true
          break
        }
      }
    }
    if (hit) {
      if (stepY > 0) {
        // Snap to slope surface at the sprite's center X so the bounce
        // arc touches the actual terrain profile instead of the flat tile top.
        const surfaceY = collision ? collision.surfaceYAt(s.x + BODY_W / 2, row) : row * 16
        s.y = surfaceY - BODY_H
        s.vy = 0
        s.sy = 0
        s.ground = true
      } else {
        s.y = (row + 1) * 16
        s.vy = 0
        s.sy = 0
      }
      return
    }
    s.y = nextY
    remaining--
  }
  s.ground = sittingOnFloor(s, solidV, levelRows, collision)
}

/**
 * Densely-sampled variant of simulateCycle: emits one body-center point
 * per simulated frame. Stops when the bounce cycle closes (sprite has
 * landed at least once and is back near the resting state) or when the
 * `maxFrames` guard fires. Suitable for rendering an arc polyline.
 *
 * Exported so sibling behaviors (e.g. WingedGoombaBehavior) can reuse the
 * same simulation loop with a different bounceSeed / vy pair.
 */
export function simulateCyclePolyline(
  spawnX: number,
  spawnY: number,
  initialDir: number,
  bounceSeed: 0 | 0x10,
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
  getL1?: GetL1Tile,
): { points: { x: number; y: number }[]; openEnd: boolean } {
  const collision = getL1 ? spriteCollisionFromL1(getL1) : undefined
  const startCol = Math.floor((spawnX + 8) / 16)
  const startRow = Math.floor((spawnY + BODY_H) / 16)
  const groundRow = collision?.findFloorRowBelow(startCol, startRow, levelRows) ?? startRow
  const restingY =
    (collision?.surfaceYAt(spawnX + BODY_W / 2, groundRow) ?? groundRow * 16) - BODY_H

  const s: BouncingState = {
    x: spawnX,
    y: restingY,
    sx: 0,
    sy: 0,
    vx: 0,
    vy: 0,
    dir: initialDir,
    ground: true,
    misc160E: bounceSeed,
    blocked: null,
    offgrid: false,
  }

  const points: { x: number; y: number }[] = []
  let landings = 0
  const MAX_FRAMES = 512 // one full bounce cycle is ~50 frames; bound for safety

  for (let frame = 0; frame < MAX_FRAMES; frame++) {
    stepFrame(s, solidH, solidV, levelCols, levelRows, getL1)
    points.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H / 2 })
    if (s.offgrid) return { points, openEnd: true }
    if (s.ground) {
      landings++
      if (landings >= 1) break // one full bounce cycle is enough - pattern repeats
    }
  }
  return { points, openEnd: false }
}

function sittingOnFloor(
  s: BouncingState,
  solidV: SolidV,
  levelRows: number,
  collision?: SpriteCollision,
): boolean {
  const row = Math.floor((s.y + BODY_H) / 16)
  if (row >= levelRows) return false
  const colL = Math.floor(s.x / 16)
  const colR = Math.floor((s.x + BODY_W - 1) / 16)
  for (let c = colL; c <= colR; c++) {
    if (solidV(c, row)) return true
  }
  // Slope-fallback for the rare case where solidV missed (e.g. the
  // floor predicate is being overridden). Filters priority cells the
  // same way solidV does - priority-1 decorations must never count as
  // ground.
  if (collision) {
    const centerX = s.x + BODY_W / 2
    const colC = Math.floor(centerX / 16)
    const slope = collision.slopeAt(colC, row)
    if (slope) {
      const pxInTile = Math.max(0, Math.min(15, Math.floor(centerX) - colC * 16))
      if (s.y + BODY_H >= row * 16 + (slope.heights[pxInTile]! & 0x0f)) return true
    }
  }
  return false
}
