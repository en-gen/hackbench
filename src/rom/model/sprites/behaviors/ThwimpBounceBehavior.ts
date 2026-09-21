/**
 * $27 Thwimp movement simulator - a direct port of the `Thwimp` handler at
 * bank_01.asm:6464–6510.
 *
 * Per-frame loop:
 *
 *   1. `SubSprXPosNoGrvty` (bank_01.asm:6464): apply vx to X position using
 *      a 16× sub-pixel accumulator. No horizontal collision flip - Thwimp
 *      clips at walls without reversing direction.
 *
 *   2. `SubSprYPosNoGrvty` (bank_01.asm:6465): apply vy to Y position using
 *      the same 16× accumulator. Floor contact (IsOnGround) terminates the
 *      hop; ceiling contact sets vy = $10 (small downward push).
 *
 *   3. Dual gravity (bank_01.asm:6467–6479):
 *        vy < 0  → ascending:   vy += GRAV_UP   (= 3)
 *        vy ≥ 0  → descending:  vy += GRAV_DOWN (= 5), clamped at $40
 *        vy ≥ $40 → terminal:   vy = $40 (no further addition)
 *
 *   4. On landing: bounce counter `SpriteTableC2` is incremented and its
 *      new parity selects direction (odd → right $10, even → left $F0).
 *      The simulator runs both first-hop directions independently and
 *      concatenates the two arc paths.
 */

import { MovementBehavior, type BehaviorMeta, type SolidV } from '../MovementBehavior'
import { applyGravity, signed8, unsigned8 } from './simulate'

// ASM: bank_01.asm:6493–6502 - direction constants
const VY_LAUNCH = signed8(0xa0) // -96 sub-px/frame
const VX_MAG = 0x10 //  16 sub-px/frame (≈ 1 px/frame net)
// ASM: bank_01.asm:6467 - CODE_01AFC3: ascending gravity
const GRAV_UP = 3
// ASM: bank_01.asm:6473 - descending gravity
const GRAV_DOWN = 5
// ASM: bank_01.asm:6476 - CODE_01AFC8: terminal-velocity clamp
const VY_TERMINAL = 0x40 // 64
// ASM: bank_01.asm:6482 - IsTouchingCeiling → LDA #$10
const VY_CEIL_HIT = 0x10 // 16

const BODY_W = 16
const BODY_H = 16

/** Ordered (x, y) body-centre positions sampled every frame, in level pixels. */
export type ThwimpBouncePath = readonly { x: number; y: number }[]

/**
 * `SpriteBehavior` for sprite $27. Exposes `computeBouncePath` - the
 * first-hop arc launched from the resting row nearest to `(spawnX, spawnY)`.
 *
 * Only the first hop is shown. Thwimp bounces back to approximately the same
 * ground position each cycle, so one arc conveys the full patrol extent.
 *
 * First-hop direction (bank_01.asm:6493–6502): INC SpriteTableC2 (0→1, odd).
 * LSR A shifts bit 0 into carry; BCC is NOT taken (carry set), so LDA #$F0
 * executes → vx = $F0 = −16 = leftward.
 */
export class ThwimpBounceBehavior extends MovementBehavior {
  readonly kind = 'thwimp_bounce'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  computeBouncePath(
    spawnX: number,
    spawnY: number,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
  ): ThwimpBouncePath {
    const restingY = snapToGround(spawnX, spawnY, solidV, levelRows)
    // ASM: bank_01.asm:6499 - first hop: C2 0→1 (odd) → vx = $F0 (−16, leftward)
    return traceHop(spawnX, restingY, -VX_MAG, solidV, levelCols, levelRows)
  }
}

// ── ground snap ──────────────────────────────────────────────────────────────

/** Find the highest solid row at or below the sprite bottom, return restingY. */
function snapToGround(spawnX: number, spawnY: number, solidV: SolidV, levelRows: number): number {
  const startRow = Math.floor((spawnY + BODY_H) / 16)
  const midCol = Math.floor((spawnX + BODY_W / 2) / 16)
  for (let r = startRow; r < levelRows; r++) {
    if (solidV(midCol, r)) return r * 16 - BODY_H
  }
  return levelRows * 16 - BODY_H // no floor found - fall to level bottom
}

// ── single-hop simulation ────────────────────────────────────────────────────

interface HopState {
  x: number
  y: number
  sx: number
  sy: number // 8-bit sub-pixel accumulators
  vx: number
  vy: number // signed speeds
}

/**
 * Simulate a single hop from `(startX, startY)` with horizontal speed `vx`
 * and the fixed Thwimp launch Y speed. Returns a dense array of body-bottom
 * centre positions `{ x: x + 8, y: y + 16 }` sampled every frame until the
 * sprite lands (or the 512-frame guard fires).
 */
function traceHop(
  startX: number,
  startY: number,
  vx: number,
  solidV: SolidV,
  levelCols: number,
  levelRows: number,
): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = []
  const s: HopState = {
    x: startX,
    y: startY,
    sx: 0,
    sy: 0,
    vx,
    vy: VY_LAUNCH,
  }

  for (let frame = 0; frame < 512; frame++) {
    moveX(s, levelCols)
    const landed = moveY(s, solidV, levelRows)

    // ASM: bank_01.asm:6467–6479 - dual gravity applied after position update
    if (!landed) {
      s.vy =
        s.vy < 0
          ? applyGravity(s.vy, GRAV_UP, VY_TERMINAL)
          : applyGravity(s.vy, GRAV_DOWN, VY_TERMINAL)
    }

    path.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H })
    if (landed) break
  }

  return path
}

// ── sub-pixel position updates ───────────────────────────────────────────────

/**
 * Apply X speed using a 16× sub-pixel accumulator (mirrors SubSprXPosNoGrvty).
 * Clips at level edges; no direction flip on wall contact.
 */
function moveX(s: HopState, levelCols: number): void {
  const totalSub = s.vx * 16
  const newSx = s.sx + totalSub
  const wholeDelta = Math.floor(newSx / 256)
  s.sx = unsigned8(newSx)
  if (wholeDelta === 0) return

  const stepX = wholeDelta > 0 ? 1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextX = s.x + stepX
    if (nextX < 0 || nextX + BODY_W > levelCols * 16) break // level edge
    s.x = nextX
    remaining--
  }
}

/**
 * Apply Y speed using a 16× sub-pixel accumulator (mirrors SubSprYPosNoGrvty).
 * On floor contact: snap to floor top, zero speeds, return true (landed).
 * On ceiling contact: snap to ceiling bottom, set vy = VY_CEIL_HIT, return false.
 */
function moveY(s: HopState, solidV: SolidV, levelRows: number): boolean {
  if (s.vy === 0) return checkGround(s, solidV, levelRows)

  const totalSub = s.vy * 16
  const newSy = s.sy + totalSub
  const wholeDelta = Math.floor(newSy / 256)
  s.sy = unsigned8(newSy)

  if (wholeDelta === 0) {
    // No whole-pixel movement this frame; still check ground if falling.
    return s.vy > 0 ? checkGround(s, solidV, levelRows) : false
  }

  const stepY = wholeDelta > 0 ? 1 : -1
  let remaining = Math.abs(wholeDelta)
  while (remaining > 0) {
    const nextY = s.y + stepY
    const leadingY = stepY > 0 ? nextY + BODY_H - 1 : nextY
    const row = Math.floor(leadingY / 16)
    const colL = Math.floor(s.x / 16)
    const colR = Math.floor((s.x + BODY_W - 1) / 16)
    let hit = false
    for (let c = colL; c <= colR; c++) {
      if (row < 0 || row >= levelRows) {
        hit = true
        break
      }
      if (solidV(c, row)) {
        hit = true
        break
      }
    }
    if (hit) {
      if (stepY > 0) {
        // ASM: bank_01.asm:6487 - IsOnGround → land
        s.y = row * 16 - BODY_H
        s.vy = 0
        s.sy = 0
        return true
      } else {
        // ASM: bank_01.asm:6480–6485 - IsTouchingCeiling → vy = $10
        s.y = (row + 1) * 16
        s.vy = VY_CEIL_HIT
        s.sy = 0
        return false
      }
    }
    s.y = nextY
    remaining--
  }

  return checkGround(s, solidV, levelRows)
}

/** Check whether the sprite bottom is flush with a solid row (vy = 0 edge case). */
function checkGround(s: HopState, solidV: SolidV, levelRows: number): boolean {
  const row = Math.floor((s.y + BODY_H) / 16)
  if (row >= levelRows) return false
  const colL = Math.floor(s.x / 16)
  const colR = Math.floor((s.x + BODY_W - 1) / 16)
  for (let c = colL; c <= colR; c++) {
    if (solidV(c, row)) {
      s.y = row * 16 - BODY_H
      s.vy = 0
      s.sy = 0
      return true
    }
  }
  return false
}
