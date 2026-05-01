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
 *
 * Overlay vocabulary: dashed swim centerline + dashed jump centerline,
 * with solid stub endcaps at the swim limits and the jump apex (matches
 * the koopa-walk and Cheep-Cheep patrols). Tests verify both axes are
 * stroked and that endcap stubs exist at the expected geometry.
 */

import { describe, it, expect } from 'vitest'
import { SwimJumpFishAppearance } from '../../../../src/rom/model/sprites/appearances/SwimJumpFishAppearance'
import { makeTestMapStore } from '../fixtures/stores'

interface Segment { x1: number; y1: number; x2: number; y2: number }

function makeMockCtx() {
  const segments: Segment[] = []
  let cursor: { x: number; y: number } | null = null

  const ctx = {
    save() {},
    restore() {},
    beginPath() { cursor = null },
    moveTo(x: number, y: number) { cursor = { x, y } },
    lineTo(x: number, y: number) {
      if (cursor !== null) segments.push({ x1: cursor.x, y1: cursor.y, x2: x, y2: y })
      cursor = { x, y }
    },
    stroke() {},
    setLineDash() {},
    fillRect() {},
    strokeRect() {},
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
  return { ctx, segments }
}

function makeApp() {
  return new SwimJumpFishAppearance([])
}

const isHoriz = (s: Segment) => s.y1 === s.y2 && s.x1 !== s.x2
const isVert  = (s: Segment) => s.x1 === s.x2 && s.y1 !== s.y2

describe('SwimJumpFishAppearance.renderOverlay — no-op when inactive', () => {
  it('does not stroke any segments when isActive=false', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, false, () => null, 100, 100, undefined, makeTestMapStore())
    expect(segments).toHaveLength(0)
  })
})

describe('SwimJumpFishAppearance.renderOverlay — geometry when active', () => {
  // Spawn at (x, y). Expected from FISH_BOUNDS:
  //   swimMinX < 0, swimMaxX ≥ 0 (fish reaches both sides of spawn)
  //   minY < 0 (jump apex above spawn row)
  // Overlay produces:
  //   - 1 horizontal dashed segment (swim centerline) at y = y+8.
  //   - 1 vertical dashed segment (jump centerline) at x = x+8.
  //   - 2 vertical endcap stubs at swim left/right.
  //   - 1 horizontal endcap stub at jump apex.

  it('strokes at least one horizontal and one vertical segment when active', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100, undefined, makeTestMapStore())
    expect(segments.some(isHoriz), 'expected a horizontal segment').toBe(true)
    expect(segments.some(isVert),  'expected a vertical segment').toBe(true)
  })

  it('swim centerline runs at y+8 (sprite midline)', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100, undefined, makeTestMapStore())
    const swimLine = segments.find(s => isHoriz(s) && Math.min(s.x1, s.x2) < 100 && Math.max(s.x1, s.x2) >= 100)
    expect(swimLine, 'expected a horizontal swim line spanning the spawn column').toBeDefined()
    expect(swimLine!.y1).toBe(208)
  })

  it('jump centerline rises from swim midline to apex (y < spawn)', () => {
    // Jump column is at the X where the fish enters jump state — XSpeed
    // is zeroed during the ascent, so the column hangs at this offset
    // (left of the spawn for the canonical ROM-derived path).
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100, undefined, makeTestMapStore())
    const jumpLine = segments.find(s => isVert(s) && Math.abs(s.y1 - s.y2) > 16)
    expect(jumpLine, 'expected a tall vertical jump line').toBeDefined()
    const topY = Math.min(jumpLine!.y1, jumpLine!.y2)
    expect(topY).toBeLessThan(200)              // apex above spawn row
    expect(jumpLine!.x1).toBeLessThanOrEqual(108) // jump column at or left of spawn center
  })

  it('endcap stubs exist at the swim limits (vertical) and apex (horizontal)', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 100, 200, true, () => null, 100, 100, undefined, makeTestMapStore())
    // Endcap stubs are 16 px long (2 × ENDCAP_HALF). Vertical stubs at the
    // swim limits straddle y=208; horizontal stub at the apex straddles x=108.
    const swimEndcaps = segments.filter(s => isVert(s) && Math.abs(s.y1 - s.y2) === 16)
    expect(swimEndcaps.length, 'expected two vertical endcap stubs at the swim limits').toBe(2)
    const apexStub = segments.find(s => isHoriz(s) && Math.abs(s.x1 - s.x2) === 16 && s.y1 < 200)
    expect(apexStub, 'expected one horizontal endcap stub at the jump apex').toBeDefined()
  })
})

describe('SwimJumpFishAppearance — FISH_BOUNDS structural invariants (via overlay geometry)', () => {
  it('overlay at x=0 produces segments with negative x (swimMinX < 0)', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 0, true, () => null, 100, 100, undefined, makeTestMapStore())
    const hasNegativeX = segments.some(s => Math.min(s.x1, s.x2) < 0)
    expect(hasNegativeX).toBe(true)
  })

  it('jump column always reaches above spawn: overlay at y=500 produces a segment with y < 500', () => {
    const app = makeApp()
    const { ctx, segments } = makeMockCtx()
    app.renderOverlay(ctx as never, 0, 500, true, () => null, 100, 100, undefined, makeTestMapStore())
    const hasAboveSpawn = segments.some(s => Math.min(s.y1, s.y2) < 500)
    expect(hasAboveSpawn).toBe(true)
  })
})

describe('SwimJumpFishAppearance — inherits StaticSpriteAppearance', () => {
  it('hitRect is 16×16 default when constructed with empty parts', () => {
    const app = makeApp()
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})
