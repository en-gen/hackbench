import {
  MovementBehavior,
  type BehaviorMeta,
  type SolidH,
  type SolidV,
} from '../MovementBehavior'
import { applyGravity, signed8, simulateUntilStable, unsigned8, type Rect } from './simulate'

/**
 * $09 Green Para-Koopa (bouncing) — GreenParaKoopa handler at
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
 *   - No hop countdown — unlike HopFlame, bounces every frame when on ground.
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

export const BOUNCE_TALL_VY  = -80   // $B0 signed — worst-case apex (misc160E=0)
export const BOUNCE_SHORT_VY = -48   // $D0 signed — short bounce (misc160E≠0)
export const BOUNCE_XSPEED   = 0x08  // Spr0to13SpeedX index 0 (not ASL'd)
const GRAVITY     = 3
const GRAVITY_MAX = 0x40
const DEC_Y_PER   = 1
const BODY_W = 16
const BODY_H = 16

export class BouncingKoopaBehavior extends MovementBehavior {
  readonly kind = 'bouncing_koopa'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  simulateArc(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
  ): BouncingEnvelope {
    const right = simulateCycle(spawnX, spawnY, 0, solidH, solidV, levelCols, levelRows)
    const left  = simulateCycle(spawnX, spawnY, 1, solidH, solidV, levelCols, levelRows)
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
  ): { x: number; y: number }[] {
    const r = simulateCycle(spawnX, spawnY, 0, solidH, solidV, levelCols, levelRows)
    const l = simulateCycle(spawnX, spawnY, 1, solidH, solidV, levelCols, levelRows)
    return [...l.path, ...r.path]
  }
}

// ── Simulation internals ────────────────────────────────────────────────────

export interface BouncingState {
  x: number; y: number
  sx: number; sy: number
  vx: number; vy: number
  dir: number
  ground: boolean
  /** SpriteMisc160E — seeded from spawn-Y bit 4. Drives tall vs short bounce. */
  misc160E: number
  blocked: 'left' | 'right' | null
}

/** Test-only state factory. Mirrors the `SimState` used by simulateCycle. */
export function makeFreshState(init: {
  x: number; y: number
  ground: boolean
  misc160E: number
  dir?: number
  vx?: number
  vy?: number
}): BouncingState {
  return {
    x: init.x, y: init.y,
    sx: 0, sy: 0,
    vx: init.vx ?? 0, vy: init.vy ?? 0,
    dir: init.dir ?? 0,
    ground: init.ground,
    misc160E: init.misc160E,
    blocked: null,
  }
}

/** Test-only wrapper around one simulation frame. */
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
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
): CycleResult {
  // Snap ground like HopFlame does.
  const startCol = Math.floor((spawnX + 8) / 16)
  let groundRow = Math.floor((spawnY + BODY_H) / 16)
  for (let r = groundRow; r < levelRows; r++) {
    if (solidV(startCol, r)) { groundRow = r; break }
  }
  const restingY = groundRow * 16 - BODY_H

  const s: BouncingState = {
    x: spawnX, y: restingY,
    sx: 0, sy: 0,
    vx: 0, vy: 0,
    dir: initialDir,
    ground: true,
    misc160E: 0,     // worst case: tall bounce
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
    if (s.x          < rect.minX) rect.minX = s.x
    if (s.x + BODY_W > rect.maxX) rect.maxX = s.x + BODY_W
    if (s.y          < rect.minY) rect.minY = s.y
    // maxY capped via envelope clamp in simulateArc.
    if (s.ground && !wasGround) path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })
    if (!s.ground && wasGround) path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })
    wasGround = s.ground
  }, { stableFrames: 256, maxFrames: 4096 })

  return { rect, groundY: restingY, path }
}

function stepFrame(
  s: BouncingState,
  solidH: SolidH,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
): void {
  // 1. SubUpdateSprPos — apply speed, then gravity.
  applyXSpeed(s, solidH, levelCols)
  applyYSpeed(s, solidV, levelRows)
  s.vy = applyGravity(s.vy, GRAVITY, GRAVITY_MAX)

  // 2. DEC.B SpriteYSpeed,X
  s.vy = signed8(s.vy - DEC_Y_PER)

  // 3. Spr0to13SpeedX: ±$08 (no ASL for $09).
  s.vx = s.dir === 0 ? +BOUNCE_XSPEED : -BOUNCE_XSPEED

  // 4. IsOnGround + immediate relaunch.
  if (s.ground) {
    s.vx = 0     // STZ SpriteXSpeed,X
    // SetSomeYSpeed__: pick launch vy based on misc160E.
    s.vy = s.misc160E === 0 ? BOUNCE_TALL_VY : BOUNCE_SHORT_VY
    s.ground = false
  }

  // 5. FlipIfTouchingObj — wall in direction of motion flips dir.
  if (s.blocked === (s.dir === 0 ? 'right' : 'left')) {
    s.dir = s.dir === 0 ? 1 : 0
    s.vx = -s.vx
    s.blocked = null
  }
}

function applyXSpeed(s: BouncingState, solidH: SolidH, levelCols: number): void {
  s.blocked = null
  if (s.vx === 0) return
  const totalSub = s.vx * 16
  const newSx    = s.sx + totalSub
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
    let hit = false
    for (let r = rowTop; r <= rowBot; r++) {
      if (col < 0 || col >= levelCols) { hit = true; break }
      if (solidH(col, r)) { hit = true; break }
    }
    if (hit) { s.blocked = stepX > 0 ? 'right' : 'left'; return }
    s.x = nextX
    remaining--
  }
}

function applyYSpeed(s: BouncingState, solidV: SolidV, levelRows: number): void {
  if (s.vy === 0) { s.ground = sittingOnFloor(s, solidV, levelRows); return }
  const totalSub = s.vy * 16
  const newSy    = s.sy + totalSub
  const wholeDelta = Math.floor(newSy / 256)
  s.sy = unsigned8(newSy)

  const stepY = s.vy > 0 ? +1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextY = s.y + stepY
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
        s.y = row * 16 - BODY_H
        s.vy = 0; s.sy = 0; s.ground = true
      } else {
        s.y = (row + 1) * 16
        s.vy = 0; s.sy = 0
      }
      return
    }
    s.y = nextY
    remaining--
  }
  s.ground = sittingOnFloor(s, solidV, levelRows)
}

function sittingOnFloor(s: BouncingState, solidV: SolidV, levelRows: number): boolean {
  const row = Math.floor((s.y + BODY_H) / 16)
  if (row >= levelRows) return false
  const colL = Math.floor(s.x / 16)
  const colR = Math.floor((s.x + BODY_W - 1) / 16)
  for (let c = colL; c <= colR; c++) {
    if (solidV(c, row)) return true
  }
  return false
}
