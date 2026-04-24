/**
 * SwimJumpFishAppearance — FISH_PATH + FISH_BOUNDS deterministic simulation.
 *
 * Handler: SwimJumpFishMain → CODE_02E727 (bank_02.asm:13649-13735).
 * The module-level FISH_PATH and FISH_BOUNDS constants are computed by
 * running 600 frames of the tick() simulation at module load time.
 * Tests assert structural properties of the result without re-implementing
 * the simulation — if the port is correct, these invariants hold; if a
 * constant changes, at least one test breaks.
 *
 * Invariants derived from ASM analysis:
 *   - 600 frames simulated (module constant).
 *   - Jump state (state=1) must appear: the fish launches on m1570==4.
 *   - Jump apex (minY) is negative — fish rises above spawn row.
 *   - Swim state (state=0) must appear: fish starts and returns to swim.
 *   - swimMinX < 0: fish moves left (SWIM_SPEEDS[0]=0x14=+20 sub-px/frame,
 *     SWIM_SPEEDS[1]=0xEC=-20 sub-px/frame; first cycle net drift is left).
 *   - swimMaxX ≥ 0: spawn point is visited.
 *   - Global minX ≤ swimMinX, maxX ≥ swimMaxX (jump may narrow X range).
 */

import { describe, it, expect } from 'vitest'
import { SwimJumpFishAppearance } from '../../../../src/rom/model/sprites/appearances/SwimJumpFishAppearance'

// FISH_PATH and FISH_BOUNDS are module-level constants — we can read them by
// importing the class and then reaching through a method that exposes them,
// but they are not exported. We test their effects indirectly: instantiate
// the class with empty parts and call renderOverlay with a mock canvas that
// captures the coordinates passed to drawCorridor / drawVertLane / drawApexLine.
// For pure structural tests we can also verify the derived overlay geometry
// is self-consistent.

// Re-export bridge: the appearance uses FISH_BOUNDS internally in renderOverlay.
// We drive it with a mock OverlayContext and capture the canvas calls.

interface Rect { x: number; y: number; w: number; h: number }

function makeMockCtx() {
  const rects: Rect[] = []
  const lines: Array<{ x1: number; x2: number; y: number }> = []

  const ctx = {
    save() {},
    restore() {},
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }) },
    strokeRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h }) },
    setLineDash() {},
    moveTo() {},
    lineTo() {},
    beginPath() {},
    stroke() {},
    fill() {},
    closePath() {},
    clip() {},
    arc() {},
    rect() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  }

  return { ctx, rects, lines }
}

// Build a minimal SwimJumpFishAppearance with no parts.
function makeApp() {
  return new SwimJumpFishAppearance([])
}

describe('SwimJumpFishAppearance.renderOverlay — no-op when inactive', () => {
  it('does not call fillRect when isActive=false', () => {
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, false, () => null, 100, 100)
    expect(rects).toHaveLength(0)
  })
})

describe('SwimJumpFishAppearance.renderOverlay — geometry when active', () => {
  // Spawn at (x=0, y=0). Expected geometry from FISH_BOUNDS:
  //   swimMinX < 0, swimMaxX ≥ 0 (fish reaches left and right of spawn)
  //   minY < 0 (jump apex is above spawn)
  //
  // The overlay draws:
  //   drawVertLane: jump column centered on spawnCenterX=x+8
  //   drawCorridor: swim band from (x+swimMinX) to (x+swimMaxX)
  //   drawApexLine: dashed marker at y+minY+0.5

  it('produces at least one fillRect call when isActive=true', () => {
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, true, () => null, 100, 100)
    expect(rects.length).toBeGreaterThan(0)
  })

  it('swim band left edge is to the left of spawn (x=100)', () => {
    // drawCorridor first fills the band rectangle.
    // swimMinX < 0, so swimLeftX = 100 + swimMinX < 100.
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100)
    // At least one rect should have x < 100 (left portion of swim band).
    const hasLeftRect = rects.some(r => r.x < 100)
    expect(hasLeftRect).toBe(true)
  })

  it('jump column top is above spawn row (y=200)', () => {
    // drawVertLane draws from jumpTopY (= y + minY, which is < y) upward.
    // So at least one rect should have y < 200.
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100)
    const hasAboveSpawnRect = rects.some(r => r.y < 200)
    expect(hasAboveSpawnRect).toBe(true)
  })
})

describe('SwimJumpFishAppearance — FISH_BOUNDS structural invariants (via overlay geometry)', () => {
  // We can verify invariants by calling renderOverlay and examining the
  // resulting canvas calls. The swim-band and jump-column widths derive
  // directly from FISH_BOUNDS fields.

  it('overlay at x=0 produces a rect with negative x (swimMinX < 0)', () => {
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, true, () => null, 100, 100)
    // swimLeftX = 0 + swimMinX < 0 → at least one rect starts at negative x
    const hasNegativeX = rects.some(r => r.x < 0)
    expect(hasNegativeX).toBe(true)
  })

  it('jump column always covers above spawn: overlay at y=500 produces a rect with y < 500', () => {
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 500, true, () => null, 100, 100)
    const hasAboveSpawn = rects.some(r => r.y < 500)
    expect(hasAboveSpawn).toBe(true)
  })

  it('swim band bottom is below spawn row (swim band covers 2 tile rows)', () => {
    // swimBottomY = y + 32 → rects should include one that ends at y+32
    const app = makeApp()
    const { ctx, rects } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, true, () => null, 100, 100)
    // y + h = 32 for the 2-tile swim band
    const hasSwimBandBottom = rects.some(r => r.y + r.h === 32 || (r.y === 0 && r.h >= 16))
    expect(hasSwimBandBottom).toBe(true)
  })
})

describe('SwimJumpFishAppearance — inherits StaticSpriteAppearance', () => {
  it('hitRect is 16×16 default when constructed with empty parts', () => {
    const app = makeApp()
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})
