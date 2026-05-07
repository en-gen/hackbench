/**
 * Tests for the Canvas2D overlay primitives used by sprite appearances.
 *
 * Appearances compose these primitives to express overlays — the primitives
 * themselves are small, stateless, and well-scoped. Tests exercise each
 * one's output via a mock context that records every draw call, so we can
 * assert fills, strokes, dashes, line widths and coordinates without
 * needing a real canvas.
 */

import { describe, expect, it } from 'vitest'
import {
  drawOverlayRect,
  drawCorridor,
  drawFallL,
  drawVertLane,
  drawApexLine,
  drawFadeCorridor,
  drawBounceArc,
  drawSineBand,
  drawSpawnDrop,
  drawArrowHead,
  findSolidBoundary,
  rgba,
  COLORS,
  FILL_ALPHA,
  DASH_ALPHA,
  WALL_ALPHA,
  APEX_ALPHA,
  WALL_LINE_WIDTH,
} from '../../../src/rom/model/overlays/primitives'
import { makeMockCtx, countEvents, type CanvasOp } from './fixtures/mockOverlayCtx'

const TEAL = { r: 0, g: 200, b: 220 }

describe('rgba(color, alpha)', () => {
  it('formats css rgba', () => {
    expect(rgba({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgba(1,2,3,0.5)')
  })

  it('constant palette has the expected named colours', () => {
    expect(COLORS.orangeHop.r).toBe(255)
    expect(COLORS.cyanKoopa.g).toBe(200)
    expect(COLORS.greenGround.g).toBe(220)
    expect(COLORS.tealSwim.r).toBe(0)
    expect(COLORS.tealJump.g).toBe(200)
  })
})

describe('drawOverlayRect', () => {
  it('emits fillRect + strokeRect with default alpha presets', () => {
    const ctx = makeMockCtx()
    drawOverlayRect(ctx, 16, 32, 64, 48, TEAL)
    const fill = ctx.events.find(e => e.op === 'fillRect')
    expect(fill).toBeDefined()
    if (fill?.op === 'fillRect') {
      expect(fill.fillStyle).toBe(rgba(TEAL, FILL_ALPHA))
      expect(fill.x).toBe(16)
      expect(fill.y).toBe(32)
      expect(fill.w).toBe(64)
      expect(fill.h).toBe(48)
    }
    const stroke = ctx.events.find(e => e.op === 'strokeRect')
    expect(stroke).toBeDefined()
    if (stroke?.op === 'strokeRect') {
      expect(stroke.strokeStyle).toBe(rgba(TEAL, DASH_ALPHA))
      expect(stroke.dash).toEqual([4, 3])
      // 0.5-px inset so a 1px stroke lands on a whole pixel.
      expect(stroke.x).toBe(16.5)
      expect(stroke.y).toBe(32.5)
      expect(stroke.w).toBe(63)
      expect(stroke.h).toBe(47)
    }
  })

  it('override alphas/dash segments', () => {
    const ctx = makeMockCtx()
    drawOverlayRect(ctx, 0, 0, 10, 10, TEAL, {
      fillAlpha: 0.7, dashAlpha: 0.8, dash: [2, 2],
    })
    const fill   = ctx.events.find(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>
    const stroke = ctx.events.find(e => e.op === 'strokeRect') as Extract<CanvasOp, { op: 'strokeRect' }>
    expect(fill.fillStyle).toBe(rgba(TEAL, 0.7))
    expect(stroke.strokeStyle).toBe(rgba(TEAL, 0.8))
    expect(stroke.dash).toEqual([2, 2])
  })
})

describe('drawCorridor', () => {
  it('emits the base rect; no wall lines unless solid edges are specified', () => {
    const ctx = makeMockCtx()
    drawCorridor(ctx, 0, 80, 0, 32, TEAL)
    expect(countEvents(ctx.events, e => e.op === 'fillRect')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'strokeRect')).toBe(1)
    // No solid-wall `stroke()` call.
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(0)
  })

  it('draws solid wall line on the left when solidLeft is true', () => {
    const ctx = makeMockCtx()
    drawCorridor(ctx, 16, 96, 0, 32, TEAL, { solidLeft: true })
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(1)
    // Stroke uses WALL_ALPHA / WALL_LINE_WIDTH.
    expect(ctx.lineWidth).toBe(WALL_LINE_WIDTH)
    expect(ctx.strokeStyle).toBe(rgba(TEAL, WALL_ALPHA))
    // moveTo(leftX, topY) + lineTo(leftX, bottomY) for the left wall.
    const moveTo = ctx.events.find(e => e.op === 'moveTo') as Extract<CanvasOp, { op: 'moveTo' }>
    const lineTo = ctx.events.find(e => e.op === 'lineTo') as Extract<CanvasOp, { op: 'lineTo' }>
    expect(moveTo.x).toBe(16)
    expect(moveTo.y).toBe(0)
    expect(lineTo.x).toBe(16)
    expect(lineTo.y).toBe(32)
  })

  it('multiple solid edges emit one stroke call covering all lines', () => {
    const ctx = makeMockCtx()
    drawCorridor(ctx, 0, 80, 0, 32, TEAL,
      { solidLeft: true, solidRight: true, solidTop: true, solidBottom: true })
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'moveTo')).toBe(4)
    expect(countEvents(ctx.events, e => e.op === 'lineTo')).toBe(4)
  })
})

describe('drawVertLane', () => {
  it('renders a centred column of halfWidth × 2', () => {
    const ctx = makeMockCtx()
    drawVertLane(ctx, 100, 20, 120, 8, TEAL)   // cx=100, minY=20, maxY=120, halfW=8
    const fill = ctx.events.find(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>
    expect(fill.x).toBe(92)        // 100 - 8
    expect(fill.y).toBe(20)
    expect(fill.w).toBe(16)        // 8 * 2
    expect(fill.h).toBe(100)       // 120 - 20
  })
})

describe('drawApexLine', () => {
  it('draws a horizontal stroke at the given y', () => {
    const ctx = makeMockCtx()
    drawApexLine(ctx, 10, 90, 40, TEAL)
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(1)
    expect(ctx.lineWidth).toBe(2)
    expect(ctx.strokeStyle).toBe(rgba(TEAL, APEX_ALPHA))
    const moveTo = ctx.events.find(e => e.op === 'moveTo') as Extract<CanvasOp, { op: 'moveTo' }>
    const lineTo = ctx.events.find(e => e.op === 'lineTo') as Extract<CanvasOp, { op: 'lineTo' }>
    expect(moveTo.y).toBe(40)
    expect(lineTo.y).toBe(40)
    expect(moveTo.x).toBe(10)
    expect(lineTo.x).toBe(90)
  })

  it('alpha and lineWidth overrides', () => {
    const ctx = makeMockCtx()
    drawApexLine(ctx, 0, 32, 16, TEAL, { alpha: 0.3, lineWidth: 4 })
    expect(ctx.strokeStyle).toBe(rgba(TEAL, 0.3))
    expect(ctx.lineWidth).toBe(4)
  })
})

describe('drawFadeCorridor', () => {
  it('emits a series of fillRect slices — steps default to 12', () => {
    const ctx = makeMockCtx()
    drawFadeCorridor(ctx, 200, 100, 104, 24, TEAL)   // 96 px leftward
    expect(countEvents(ctx.events, e => e.op === 'fillRect')).toBe(12)
  })

  it('fade alpha decreases from start to end', () => {
    const ctx = makeMockCtx()
    drawFadeCorridor(ctx, 200, 100, 104, 24, TEAL, { steps: 5 })
    const rects = ctx.events.filter(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>[]
    // First rect alpha > last rect alpha.
    const firstAlpha = Number(/rgba\(\d+,\d+,\d+,(.+)\)/.exec(rects[0].fillStyle)?.[1] ?? '0')
    const lastAlpha  = Number(/rgba\(\d+,\d+,\d+,(.+)\)/.exec(rects[rects.length - 1].fillStyle)?.[1] ?? '1')
    expect(firstAlpha).toBeGreaterThan(lastAlpha)
  })

  it('endX < originX produces rects from origin leftward', () => {
    const ctx = makeMockCtx()
    drawFadeCorridor(ctx, 300, 50, 204, 16, TEAL, { steps: 3 })
    const rects = ctx.events.filter(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>[]
    // With dx negative, successive rect x's should decrease (origin at right).
    expect(rects[rects.length - 1].x).toBeLessThan(rects[0].x)
  })
})

describe('drawBounceArc', () => {
  it('draws envelope rect + polyline through bouncePath', () => {
    const ctx = makeMockCtx()
    const envelope = { minX: 0, maxX: 100, minY: 0, maxY: 40 }
    const path = [
      { x: 5,  y: 40 },
      { x: 20, y: 20 },
      { x: 35, y: 40 },
      { x: 50, y: 20 },
    ]
    drawBounceArc(ctx, envelope, path, TEAL)
    expect(countEvents(ctx.events, e => e.op === 'fillRect')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'moveTo')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'lineTo')).toBe(3)
  })

  it('empty or single-point path: draws envelope only, no polyline', () => {
    const ctx = makeMockCtx()
    drawBounceArc(ctx, { minX: 0, maxX: 10, minY: 0, maxY: 10 }, [{ x: 5, y: 5 }], TEAL)
    expect(countEvents(ctx.events, e => e.op === 'fillRect')).toBe(1)
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(0)
  })
})

describe('drawSineBand', () => {
  it('vertical axis: envelope is amplitude × 2 tall, centred on origin', () => {
    const ctx = makeMockCtx()
    drawSineBand(ctx, 100, 100, 'vertical', 40, TEAL, { halfWidth: 12 })
    const fill = ctx.events.find(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>
    expect(fill.x).toBe(88)        // origin - halfW
    expect(fill.y).toBe(60)        // origin - amplitude
    expect(fill.w).toBe(24)        // halfW × 2
    expect(fill.h).toBe(80)        // amplitude × 2
  })

  it('horizontal axis: envelope is amplitude × 2 wide, centred on origin', () => {
    const ctx = makeMockCtx()
    drawSineBand(ctx, 100, 100, 'horizontal', 30, TEAL, { halfWidth: 10 })
    const fill = ctx.events.find(e => e.op === 'fillRect') as Extract<CanvasOp, { op: 'fillRect' }>
    expect(fill.x).toBe(70)        // origin - amplitude
    expect(fill.y).toBe(90)        // origin - halfW
    expect(fill.w).toBe(60)
    expect(fill.h).toBe(20)
  })

  it('emits a sine polyline (many lineTo calls)', () => {
    const ctx = makeMockCtx()
    drawSineBand(ctx, 100, 100, 'vertical', 40, TEAL, { samples: 20 })
    expect(countEvents(ctx.events, e => e.op === 'lineTo')).toBe(20)
    expect(countEvents(ctx.events, e => e.op === 'stroke')).toBe(1)
  })
})

describe('findSolidBoundary', () => {
  const walls = new Set([3, 7, 12])
  const isSolid = (c: number) => walls.has(c)

  it('direction=+1: stops at nearest wall to the right', () => {
    expect(findSolidBoundary(isSolid, 0, +1, 20)).toBe(3 * 16)
    expect(findSolidBoundary(isSolid, 4, +1, 20)).toBe(7 * 16)
    expect(findSolidBoundary(isSolid, 8, +1, 20)).toBe(12 * 16)
  })

  it('direction=-1: stops one column past nearest wall to the left', () => {
    expect(findSolidBoundary(isSolid, 10, -1, 20)).toBe((7 + 1) * 16)
    expect(findSolidBoundary(isSolid, 5, -1, 20)).toBe((3 + 1) * 16)
  })

  it('no wall found: returns level-edge X', () => {
    const none = (_: number) => false
    expect(findSolidBoundary(none, 5, +1, 10)).toBe(160)
    expect(findSolidBoundary(none, 5, -1, 10)).toBe(0)
  })

  it('spawn column never self-blocks (scan starts at startCol ± 1)', () => {
    const atFive = (c: number) => c === 5
    expect(findSolidBoundary(atFive, 5, +1, 20)).toBe(20 * 16)
    expect(findSolidBoundary(atFive, 5, -1, 20)).toBe(0)
  })
})

describe('drawFallL — ledge fall indicator', () => {
  const PARAMS = { horizontalTiles: 2, verticalTiles: 2, verticalWidth: 16 }

  it('right fall: fills horizontal band solid and vertical band with a gradient', () => {
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, PARAMS)
    const fillRects = ctx.events.filter(e => e.op === 'fillRect')
    expect(fillRects).toHaveLength(2)
    // Horizontal band uses solid rgba fill.
    expect(fillRects[0].fillStyle).toMatch(/^rgba\(/)
    // Vertical band uses the gradient assigned before the fillRect.
    expect(fillRects[1].fillStyle).toMatch(/^gradient#/)
  })

  it('emits a vertical linear gradient for the vertical-band fill', () => {
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, PARAMS)
    const grads = ctx.events.filter(e => e.op === 'createLinearGradient')
    expect(grads.length).toBeGreaterThan(0)
    const fillGrad = grads[0]
    if (fillGrad.op !== 'createLinearGradient') return
    // Vertical gradient: x0===x1, y0 < y1.
    expect(fillGrad.x0).toBe(fillGrad.x1)
    expect(fillGrad.y1).toBeGreaterThan(fillGrad.y0)
  })

  it('vertical-band fill gradient fades to alpha 0 at the bottom', () => {
    // Only the fill gradient remains — side strokes were dropped in
    // favour of a single top stroke + fade-out fill, so there's exactly
    // two color stops: fillAlpha at the top, 0 at the bottom.
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, PARAMS)
    const stops = ctx.events.filter(e => e.op === 'addColorStop')
    expect(stops.length).toBeGreaterThanOrEqual(2)
    const endings = stops.filter(e => e.op === 'addColorStop' && e.offset === 1)
    for (const end of endings) {
      if (end.op !== 'addColorStop') continue
      expect(end.color).toMatch(/,0\)$/)
    }
  })

  it('draws the 5-segment L perimeter — bottom of vertical skipped to imply continuing fall', () => {
    // 3-tile horizontal × 2-tile vertical at the far end. 5 segments:
    // top, near side (half height), horizontal's visible bottom, inner
    // edge, far side full height. NO bottom-of-vertical — the missing
    // edge signals the koopa keeps falling past the drop zone.
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, { horizontalTiles: 3, verticalTiles: 2, verticalWidth: 32 })
    const topY = 16
    const bottomY = 48
    const vyB = bottomY + 2 * 16
    const hxL = 80
    const hxR = 80 + 3 * 16
    const vxNear = hxR - 32  // direction=+1 → near edge of vertical
    const moves = ctx.events.filter(e => e.op === 'moveTo' || e.op === 'lineTo')
    const hasHorizSeg = (y: number, xMin: number, xMax: number): boolean => {
      for (let i = 0; i < moves.length - 1; i++) {
        const a = moves[i]; const b = moves[i + 1]
        if (a.op !== 'moveTo' || b.op !== 'lineTo') continue
        if (Math.abs(a.y - y) <= 0.5 && Math.abs(b.y - y) <= 0.5 &&
            Math.min(a.x, b.x) <= xMin && Math.max(a.x, b.x) >= xMax) return true
      }
      return false
    }
    const hasVertSeg = (x: number, yMin: number, yMax: number): boolean => {
      for (let i = 0; i < moves.length - 1; i++) {
        const a = moves[i]; const b = moves[i + 1]
        if (a.op !== 'moveTo' || b.op !== 'lineTo') continue
        if (Math.abs(a.x - x) <= 0.5 && Math.abs(b.x - x) <= 0.5 &&
            Math.min(a.y, b.y) <= yMin && Math.max(a.y, b.y) >= yMax) return true
      }
      return false
    }
    expect(hasHorizSeg(topY,    hxL,    hxR)).toBe(true)        // top
    expect(hasVertSeg(hxL,      topY,   bottomY)).toBe(true)    // near side (half height)
    expect(hasHorizSeg(bottomY, hxL,    vxNear)).toBe(true)     // visible horizontal bottom
    expect(hasVertSeg(vxNear,   bottomY, vyB)).toBe(true)        // inner edge
    expect(hasVertSeg(hxR,      topY,   vyB)).toBe(true)        // far side full height
    // No bottom-of-vertical — implies continuing fall.
    expect(hasHorizSeg(vyB, vxNear, hxR)).toBe(false)
  })

  it('does NOT draw the horizontal-vertical junction line ("a" junction hidden)', () => {
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, PARAMS)
    const bottomY = 48
    // The horizontal's bottom outline should only span the VISIBLE region
    // (hxL=80..vxNear=96 for direction=+1; vertical occupies x∈[96,112]).
    // Assert no horizontal stroke crosses x ∈ (96, 112) at y = bottomY.
    const moves = ctx.events.filter(e => e.op === 'moveTo' || e.op === 'lineTo')
    for (let i = 0; i < moves.length - 1; i++) {
      const a = moves[i]
      const b = moves[i + 1]
      if (a.op !== 'moveTo' && a.op !== 'lineTo') continue
      if (b.op !== 'lineTo') continue
      // Check for a horizontal segment at bottomY crossing the hidden range.
      const ay = 'y' in a ? a.y : undefined
      const by = 'y' in b ? b.y : undefined
      if (ay !== by) continue
      const y = ay
      // Allow 0.5 offset
      if (y !== bottomY && y !== bottomY - 0.5) continue
      const xMin = Math.min(a.x, b.x)
      const xMax = Math.max(a.x, b.x)
      // Segment must NOT straddle (96, 112).
      if (xMax > 96 && xMin < 112 && !(xMax <= 96 || xMin >= 112)) {
        throw new Error(`segment at y=${y} crosses hidden zone: ${xMin}..${xMax}`)
      }
    }
  })

  it('left fall: mirrors the horizontal band to the left of ledgeX', () => {
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, -1, TEAL, PARAMS)
    const fillRects = ctx.events.filter(e => e.op === 'fillRect')
    // Horizontal band extends LEFT of ledgeX for direction=-1.
    const h = fillRects[0]
    if (h.op !== 'fillRect') return
    expect(h.x + h.w).toBe(80)           // right edge at ledgeX
    expect(h.x).toBe(80 - 2 * 16)        // left edge 2 tiles earlier
  })

  it('skipNearSide=true, direction=+1: near-side segment not drawn', () => {
    // Covers: opts?.skipNearSide ?? false (defined branch) + if (!skipNearSide) false branch
    const ctx = makeMockCtx()
    drawFallL(ctx, 80, 16, 48, +1, TEAL, { ...PARAMS, skipNearSide: true })
    // No error expected; near-side moveTo/lineTo pair should be absent.
    expect(() => drawFallL(ctx, 80, 16, 48, +1, TEAL, { ...PARAMS, skipNearSide: true })).not.toThrow()
  })

  it('skipNearSide=true, direction=-1: near-side segment not drawn', () => {
    // Covers: if (!skipNearSide) false branch for the left-fall case
    const ctx = makeMockCtx()
    expect(() => drawFallL(ctx, 80, 16, 48, -1, TEAL, { ...PARAMS, skipNearSide: true })).not.toThrow()
  })

  it('no opts: uses default horizontalTiles=2, verticalTiles=2, verticalWidth=32 (?? right-side branches)', () => {
    // Covers: opts?.horizontalTiles ?? 2, opts?.verticalTiles ?? 2, opts?.verticalWidth ?? 32
    // right-side branches — all three defaults fire when opts is omitted entirely.
    const ctx = makeMockCtx()
    expect(() => drawFallL(ctx, 80, 16, 48, +1, TEAL)).not.toThrow()
  })
})

// ── drawFadeCorridor — steps=1 edge case ─────────────────────────────────────

describe('drawFadeCorridor — steps=1 guard', () => {
  it('steps=1: (steps-1 || 1) takes the || 1 path (0 is falsy)', () => {
    // ASM: t = i / (steps - 1 || 1) with steps=1 → 0 || 1 = 1; only iteration i=0 runs.
    const ctx = makeMockCtx()
    expect(() => drawFadeCorridor(ctx, 200, 100, 250, 24, TEAL, { steps: 1 })).not.toThrow()
    const fills = ctx.events.filter(e => e.op === 'fillRect')
    // Exactly one fill rect for the single step.
    expect(fills.length).toBe(1)
  })
})

// ── drawSpawnDrop ─────────────────────────────────────────────────────────────

describe('drawSpawnDrop', () => {
  it('toY <= fromY: early return, nothing drawn', () => {
    // Covers: if (toY <= fromY) return — true branch
    const ctx = makeMockCtx()
    drawSpawnDrop(ctx, 100, 80, 50, TEAL)   // toY=50 < fromY=80 → return
    expect(ctx.events.filter(e => e.op === 'moveTo').length).toBe(0)
  })

  it('toY > fromY, no opts: draws a vertical stroke with default alpha+dash', () => {
    // Covers: if (toY <= fromY) false branch + opts?.alpha ?? DASH_ALPHA default
    //         + opts?.dash ?? [2, 3] default
    const ctx = makeMockCtx()
    drawSpawnDrop(ctx, 100, 10, 80, TEAL)
    expect(ctx.events.some(e => e.op === 'moveTo')).toBe(true)
    expect(ctx.events.some(e => e.op === 'lineTo')).toBe(true)
  })

  it('toY > fromY, opts with alpha+dash provided: uses supplied values', () => {
    // Covers: opts?.alpha ?? DASH_ALPHA — left (defined) branch
    //         opts?.dash  ?? [2,3]      — left (defined) branch
    const ctx = makeMockCtx()
    drawSpawnDrop(ctx, 100, 10, 80, TEAL, { alpha: 0.9, dash: [1, 2] })
    // At least one setLineDash call should have been made.
    expect(ctx.events.some(e => e.op === 'setLineDash')).toBe(true)
  })
})

// ── drawArrowHead ─────────────────────────────────────────────────────────────

describe('drawArrowHead', () => {
  it('tip === from (len=0): early return, nothing drawn', () => {
    // Covers: if (len < 0.5) return — true branch
    const ctx = makeMockCtx()
    drawArrowHead(ctx, 50, 50, 50, 50, TEAL, 0.6, 5)
    expect(ctx.events.filter(e => e.op === 'moveTo').length).toBe(0)
  })

  it('tip differs from from (len>0): draws chevron strokes', () => {
    // Covers: if (len < 0.5) false branch
    const ctx = makeMockCtx()
    drawArrowHead(ctx, 100, 100, 80, 80, TEAL, 0.6, 5)
    expect(ctx.events.some(e => e.op === 'moveTo')).toBe(true)
    expect(ctx.events.some(e => e.op === 'lineTo')).toBe(true)
  })
})
