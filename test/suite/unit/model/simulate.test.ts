/**
 * simulate.test.ts - branch coverage for shared simulation primitives
 * (src/rom/model/sprites/behaviors/simulate.ts)
 *
 * Test tree:
 *   unionBodyBox
 *     - x < minX  → updates minX
 *     - x >= minX → no change to minX
 *     - x+w > maxX → updates maxX
 *     - x+w <= maxX → no change to maxX
 *     - y < minY → updates minY
 *     - y >= minY → no change to minY
 *     - y+h > maxY → updates maxY
 *     - y+h <= maxY → no change to maxY
 *   signed8
 *     - value < 128 → positive pass-through
 *     - value >= 128 → wraps to negative
 *   applyGravity
 *     - next <= terminal → returns next (gravity applied)
 *     - next > terminal → clamps to terminal
 *     - default gravity (3) and terminal (0x40) used when omitted
 *   simulateUntilStable
 *     - cont === false → early return from step
 *     - bounds grew → stable resets, convergence delayed
 *     - stable >= stableTarget → converges before maxFrames
 *     - loop exhaustion → returns maxFrames
 *     - options omitted → ?? defaults used (stableFrames=256, maxFrames=4096)
 */

import { describe, it, expect } from 'vitest'
import {
  unionBodyBox,
  signed8,
  unsigned8,
  applyGravity,
  simulateUntilStable,
  type Rect,
} from '../../../../src/rom/model/sprites/behaviors/simulate'

// ── unionBodyBox ──────────────────────────────────────────────────────────────

describe('unionBodyBox', () => {
  function makeRect(): Rect {
    return { minX: 10, maxX: 20, minY: 10, maxY: 20 }
  }

  it('x < minX → updates minX', () => {
    const r = makeRect()
    unionBodyBox(r, 5, 10, 4, 4)
    expect(r.minX).toBe(5)
  })

  it('x >= minX → minX unchanged', () => {
    const r = makeRect()
    unionBodyBox(r, 12, 10, 2, 2)
    expect(r.minX).toBe(10)
  })

  it('x+w > maxX → updates maxX', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 10, 15, 4)
    expect(r.maxX).toBe(25)
  })

  it('x+w <= maxX → maxX unchanged', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 10, 5, 4)
    expect(r.maxX).toBe(20)
  })

  it('y < minY → updates minY', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 3, 4, 4)
    expect(r.minY).toBe(3)
  })

  it('y >= minY → minY unchanged', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 12, 2, 2)
    expect(r.minY).toBe(10)
  })

  it('y+h > maxY → updates maxY', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 10, 4, 15)
    expect(r.maxY).toBe(25)
  })

  it('y+h <= maxY → maxY unchanged', () => {
    const r = makeRect()
    unionBodyBox(r, 10, 10, 4, 5)
    expect(r.maxY).toBe(20)
  })

  it('all four bounds expand simultaneously', () => {
    const r = makeRect()
    unionBodyBox(r, 0, 0, 100, 100)
    expect(r).toEqual({ minX: 0, maxX: 100, minY: 0, maxY: 100 })
  })
})

// ── signed8 ───────────────────────────────────────────────────────────────────

describe('signed8', () => {
  it('0 → 0', () => expect(signed8(0)).toBe(0))
  it('127 → 127 (below wrap threshold)', () => expect(signed8(127)).toBe(127))
  it('128 → -128 (exactly at wrap threshold)', () => expect(signed8(128)).toBe(-128))
  it('255 → -1', () => expect(signed8(255)).toBe(-1))
  it('256 → 0 (wraps back)', () => expect(signed8(256)).toBe(0))
  it('-1 → -1 (negative pass-through)', () => expect(signed8(-1)).toBe(-1))
  it('-128 → -128', () => expect(signed8(-128)).toBe(-128))
})

// ── unsigned8 ─────────────────────────────────────────────────────────────────

describe('unsigned8', () => {
  it('0 → 0', () => expect(unsigned8(0)).toBe(0))
  it('255 → 255', () => expect(unsigned8(255)).toBe(255))
  it('256 → 0', () => expect(unsigned8(256)).toBe(0))
  it('-1 → 255', () => expect(unsigned8(-1)).toBe(255))
})

// ── applyGravity ──────────────────────────────────────────────────────────────

describe('applyGravity', () => {
  it('next <= terminal → gravity applied normally', () => {
    expect(applyGravity(0, 3, 0x40)).toBe(3)
  })

  it('next > terminal → clamped to terminal', () => {
    expect(applyGravity(0x3f, 3, 0x40)).toBe(0x40)
  })

  it('already at terminal → stays at terminal', () => {
    expect(applyGravity(0x40, 3, 0x40)).toBe(0x40)
  })

  it('default gravity=3 and terminal=0x40 used when omitted', () => {
    // 60 + 3 = 63 ≤ 64
    expect(applyGravity(60)).toBe(63)
    // 62 + 3 = 65 > 64 → clamp
    expect(applyGravity(62)).toBe(0x40)
  })

  it('explicit gravity=1 used when provided', () => {
    expect(applyGravity(0, 1, 10)).toBe(1)
  })
})

// ── simulateUntilStable ───────────────────────────────────────────────────────

describe('simulateUntilStable', () => {
  function makeRect(): Rect {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  }

  it('step returns false → early return on that frame', () => {
    const bounds = makeRect()
    const frames = simulateUntilStable(
      bounds,
      frame => {
        if (frame === 2) return false
      },
      { stableFrames: 100, maxFrames: 1000 },
    )
    expect(frames).toBe(3)
  })

  it('bounds grow each frame → stable resets; stabilises when growth stops', () => {
    const bounds = makeRect()
    let callCount = 0
    // Grow for 5 frames then stop - should stabilise after stableFrames=3 more
    const frames = simulateUntilStable(
      bounds,
      frame => {
        callCount++
        if (frame < 5) bounds.maxX = frame + 1
      },
      { stableFrames: 3, maxFrames: 500 },
    )
    // After 5 growth frames, 3 stable frames needed → converges at frame 5+3=7, returns frame+1=8
    expect(frames).toBe(8)
    expect(callCount).toBe(8)
  })

  it('stable immediately from frame 0 → converges after stableTarget frames', () => {
    const bounds = makeRect()
    const frames = simulateUntilStable(
      bounds,
      () => {
        /* no mutations */
      },
      {
        stableFrames: 5,
        maxFrames: 1000,
      },
    )
    expect(frames).toBe(5)
  })

  it('maxFrames exhaustion → returns maxFrames', () => {
    const bounds = makeRect()
    let frame = 0
    const frames = simulateUntilStable(
      bounds,
      () => {
        // Always grow to prevent early convergence
        bounds.maxX = ++frame
      },
      { stableFrames: 1000, maxFrames: 10 },
    )
    expect(frames).toBe(10)
  })

  it('options omitted → ?? defaults used (stableFrames=256, maxFrames=4096)', () => {
    const bounds = makeRect()
    // No growth → will stabilise after 256 frames with default stableFrames
    const frames = simulateUntilStable(bounds, () => {
      /* no-op */
    })
    expect(frames).toBe(256)
  })

  it('stableFrames explicitly 0 → ?? default 256 NOT used; converges after 0 stable frames', () => {
    // stableFrames=0 means "stable as soon as we don't grow", but since ?? only
    // fires on undefined/null, 0 is used as-is → stable >= 0 is immediately true
    const bounds = makeRect()
    const frames = simulateUntilStable(
      bounds,
      () => {
        /* no growth */
      },
      {
        stableFrames: 0,
        maxFrames: 1000,
      },
    )
    // stable starts at 0, 0 >= 0 → returns immediately after frame 0 → frames=1
    expect(frames).toBe(1)
  })

  it('maxFrames=0 via options → ?? default not triggered; loop skipped → returns 0', () => {
    const bounds = makeRect()
    const frames = simulateUntilStable(bounds, () => false, {
      stableFrames: 256,
      maxFrames: 0,
    })
    expect(frames).toBe(0)
  })

  it('multiple bounds dimensions grow independently - all four ?? stable-reset sub-branches', () => {
    const bounds = makeRect()
    const frames = simulateUntilStable(
      bounds,
      frame => {
        // On frame 0 grow minX, frame 1 grow maxX, frame 2 grow minY, frame 3 grow maxY
        if (frame === 0) bounds.minX = -1
        if (frame === 1) bounds.maxX = 1
        if (frame === 2) bounds.minY = -1
        if (frame === 3) bounds.maxY = 1
      },
      { stableFrames: 2, maxFrames: 100 },
    )
    // 4 growth frames then 2 stable → converges at frame 4+2=6
    expect(frames).toBe(6)
  })
})
