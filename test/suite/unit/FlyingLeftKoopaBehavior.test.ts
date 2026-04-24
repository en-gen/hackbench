/**
 * ASM-derived tests for $08 Green Para-Koopa (horizontally flying variant)
 * — the GreenParaKoopa handler at bank_01.asm:1817 taking the $08 branch
 * at line 1835 (`CMP #$08; BEQ/BNE branch`).
 *
 * The $08 branch:
 *   - vx = Spr0to13SpeedX[dir] — always -$08 (left) because InitGrnBounceKoopa
 *     seeds direction from (Y low bit 4); the overlay uses the worst-case
 *     "flies left forever" semantics.
 *   - vy alternates $FC / +$04 based on SpriteMisc1570 bit 5 — i.e. vertical
 *     bob of ±4 sub-pixels (±0.25 px/frame). Flips every 32 frames.
 *   - `SubSprXPosNoGrvty` + `SubSprYPosNoGrvty` are applied, but `CODE_019140`
 *     (the full collision scanner) is NOT called, so `SpriteBlockedDirs` is
 *     never set. The sprite passes through walls.
 *   - No gravity, no on-ground branch, no direction flip — never turns.
 *
 * The overlay is the 5-6-tile fade-to-transparent corridor to the left of
 * spawn, indicating "this koopa flies left indefinitely; it passes through
 * intervening walls and despawns offscreen." A bounded 96-px fade is enough
 * to convey direction-of-travel without drawing the whole level width.
 *
 * Test tree:
 *   static constants match ASM expectations
 *     ├─ FLY_XSPEED = $F8 (signed -8)
 *     ├─ FLY_Y_BOB_LOW = $FC (signed -4)  / FLY_Y_BOB_HIGH = +$04
 *     └─ FADE_LENGTH_PX = 96 (6 tiles)
 *
 *   computeFadeCorridor
 *     ├─ originX/originY track spawn
 *     ├─ endX = spawnX - 96 regardless of level walls
 *     ├─ heightPx = 16 (single body) + 2*4 bob = 24 total?  (depends on impl)
 *     │   → assert heightPx ≥ 16 (body) and ≤ 32 (bob + margin)
 *     └─ direction is always leftwards (endX < originX)
 *
 *   computeFlightPosition(frame) — deterministic per-frame position
 *     ├─ frame 0 same as spawn (no movement yet)
 *     ├─ frame 100: X decreased by ~50 px (0.5 px/frame; off by sub-pixel carry)
 *     ├─ frame 1000: X decreased by ~500 px (linear drift)
 *     └─ Y bobs around spawnY within ±4 px window
 */

import { describe, expect, it } from 'vitest'
import {
  FlyingLeftKoopaBehavior,
  FLY_XSPEED,
  FLY_Y_BOB_LOW,
  FLY_Y_BOB_HIGH,
  FADE_LENGTH_PX,
  FADE_HEIGHT_PX,
} from '../../../src/rom/model/sprites/behaviors/FlyingLeftKoopaBehavior'

describe('FlyingLeftKoopaBehavior — ASM constants', () => {
  it('FLY_XSPEED matches Spr0to13SpeedX[1] = $F8 (signed -8)', () => {
    expect(FLY_XSPEED).toBe(-8)
  })

  it('FLY_Y_BOB_LOW = -4 (signed $FC)', () => {
    expect(FLY_Y_BOB_LOW).toBe(-4)
  })

  it('FLY_Y_BOB_HIGH = +4', () => {
    expect(FLY_Y_BOB_HIGH).toBe(+4)
  })

  it('FADE_LENGTH_PX = 96 (6 tiles)', () => {
    expect(FADE_LENGTH_PX).toBe(96)
  })

  it('FADE_HEIGHT_PX covers the body plus bob (16..32 px)', () => {
    expect(FADE_HEIGHT_PX).toBeGreaterThanOrEqual(16)
    expect(FADE_HEIGHT_PX).toBeLessThanOrEqual(32)
  })
})

describe('FlyingLeftKoopaBehavior — computeFadeCorridor', () => {
  it('originX/originY match spawn', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const corridor = beh.computeFadeCorridor(128, 64)
    expect(corridor.originX).toBe(128)
    expect(corridor.originY).toBe(64)
  })

  it('endX is 96 px to the left of spawn', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const corridor = beh.computeFadeCorridor(128, 64)
    expect(corridor.endX).toBe(128 - 96)
  })

  it('fade direction is always leftward (endX < originX)', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const c1 = beh.computeFadeCorridor(500, 100)
    expect(c1.endX).toBeLessThan(c1.originX)
    const c2 = beh.computeFadeCorridor(50, 50)
    expect(c2.endX).toBeLessThan(c2.originX)
  })

  it('fade length is independent of spawn position (no wall-stop)', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const c1 = beh.computeFadeCorridor(100, 50)
    const c2 = beh.computeFadeCorridor(5000, 50)
    expect(c1.originX - c1.endX).toBe(96)
    expect(c2.originX - c2.endX).toBe(96)
  })

  it('exposes metadata', () => {
    const beh = new FlyingLeftKoopaBehavior()
    expect(beh.kind).toBe('flying_left_koopa')
  })
})

describe('FlyingLeftKoopaBehavior — computeFlightPosition', () => {
  it('frame 0 equals spawn', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const p = beh.computeFlightPosition(100, 100, 0)
    expect(p.x).toBe(100)
    expect(p.y).toBe(100)
  })

  it('frame 100: X decreased by ~50 px (0.5 px/frame from vx=-8 sub-px)', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const p = beh.computeFlightPosition(1000, 100, 100)
    // vx = -8 sub-px/frame; 100 frames × 8 = 800 sub-px = 50 px.
    expect(p.x).toBe(1000 - 50)
  })

  it('frame 1000: X decreased by ~500 px (linear drift, no wall-stop)', () => {
    const beh = new FlyingLeftKoopaBehavior()
    const p = beh.computeFlightPosition(5000, 100, 1000)
    expect(p.x).toBe(5000 - 500)
  })

  it('Y bobs within ±8 px of spawnY (never drifts monotonically)', () => {
    // Sub-pixel integration: vy=-4 × 16 = -64 sub-px/frame → 1 whole pixel
    // every 4 frames. 32 frames at vy=-4 → 8 pixels up; then 32 frames at
    // vy=+4 brings us back. So peak excursion is ≈ ±8 px.
    const beh = new FlyingLeftKoopaBehavior()
    for (let f = 0; f <= 128; f++) {
      const p = beh.computeFlightPosition(1000, 100, f)
      expect(Math.abs(p.y - 100)).toBeLessThanOrEqual(8)
    }
  })

  it('Y pattern is periodic — frame 64 equals frame 0', () => {
    // SpriteMisc1570 bit 5 flips every 32 frames (low bit 5 = bit position 5
    // in an incrementing counter) so a full up-down cycle takes 64 frames.
    const beh = new FlyingLeftKoopaBehavior()
    const y0  = beh.computeFlightPosition(1000, 100, 0).y
    const y64 = beh.computeFlightPosition(1000, 100, 64).y
    expect(y64).toBe(y0)
  })
})
