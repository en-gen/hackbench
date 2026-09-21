/**
 * drawL3Range - "Show L3 BG range" overlay renderer.
 *
 * These tests lock the canvas operations the overlay emits. The scroll-range
 * derivation itself is tested in L3ScrollRange.test.ts; here we only assert
 * that drawL3Range translates a precomputed range into the right rect/fill/
 * stroke/label calls.
 */

import { describe, expect, it } from 'vitest'
import {
  drawL3Range,
  type L3RangeDrawCtx,
} from '../../../src/webview/mapEditor/overlays/drawL3Range'
import { L3TilemapLayer } from '../../../src/rom/model/L3Layer'
import type { SmwMap } from '../../../src/rom/model/SmwMap'
import type { L3ScrollRange } from '../../../src/rom/L3Loader'

interface RectOp {
  x: number
  y: number
  w: number
  h: number
}
interface CtxRecorder extends L3RangeDrawCtx {
  rects: RectOp[]
  fills: number
  strokes: number
  labels: { text: string; x: number; y: number }[]
  saved: number
  restored: number
}

function makeCtx(): CtxRecorder {
  const rects: RectOp[] = []
  const labels: { text: string; x: number; y: number }[] = []
  const ctx: CtxRecorder = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'miter' as CanvasLineJoin,
    font: '',
    rects,
    fills: 0,
    strokes: 0,
    labels,
    saved: 0,
    restored: 0,
    save() {
      ctx.saved++
    },
    restore() {
      ctx.restored++
    },
    beginPath() {},
    rect(x, y, w, h) {
      rects.push({ x, y, w, h })
    },
    moveTo() {},
    lineTo() {},
    fill() {
      ctx.fills++
    },
    stroke() {
      ctx.strokes++
    },
    fillText(text, x, y) {
      labels.push({ text, x, y })
    },
    // strokeText is the outline pass for tide labels; it doesn't add to the
    // visible-label list since fillText follows immediately on top.
    strokeText() {},
  }
  return ctx
}

/**
 * Build a minimal duck-typed SmwMap with the L3 layer carrying the given
 * scroll range. drawL3Range only touches `map.l3.scrollRange`.
 */
function makeMap(range: L3ScrollRange | null): SmwMap {
  const l3Chars: never[][] = []
  const tilemap = new Uint16Array(0)
  if (range === null) {
    return { l3: null } as unknown as SmwMap
  }
  const l3 = new L3TilemapLayer(tilemap, l3Chars as never, 0xd0, 0, 0, range)
  return { l3 } as unknown as SmwMap
}

describe('drawL3Range', () => {
  it('emits a rect + fill + stroke + label for a fixed-mode range', () => {
    const range: L3ScrollRange = {
      kind: 'fixed',
      xMin: 0,
      xMax: 256 * 11,
      yMin: 50,
      yMax: 200,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))

    expect(ctx.rects).toEqual([{ x: 0, y: 50, w: 256 * 11, h: 150 }])
    expect(ctx.fills).toBe(1)
    expect(ctx.strokes).toBe(1)
    expect(ctx.labels).toHaveLength(1)
    expect(ctx.labels[0]!.text).toContain('fixed')
    expect(ctx.saved).toBe(1)
    expect(ctx.restored).toBe(1)
  })

  it('emits L3 Max / L3 Min labels for tide kind (no rect-header label)', () => {
    const range: L3ScrollRange = {
      kind: 'tide',
      xMin: 0,
      xMax: 2048,
      yMin: -96,
      yMax: 144,
      yHighTide: -96,
      yLowTide: 144,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    const labelTexts = ctx.labels.map(l => l.text)
    expect(labelTexts).toContain('L3 Max')
    expect(labelTexts).toContain('L3 Min')
  })

  it('draws "L3 Max" / "L3 Min" reference lines + labels at the sweep extremes', () => {
    // The translucent rect alone is hard to read against the L3 plane drawn
    // at rest position; explicit reference lines with high-contrast labels
    // make both extremes visually unambiguous.
    const range: L3ScrollRange = {
      kind: 'tide',
      xMin: 0,
      xMax: 2048,
      yMin: 96,
      yMax: 216,
      yHighTide: 96,
      yLowTide: 208,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    const labelTexts = ctx.labels.map(l => l.text)
    expect(labelTexts).toContain('L3 Max')
    expect(labelTexts).toContain('L3 Min')
    // Labels sit near their respective sweep-extreme Y
    const high = ctx.labels.find(l => l.text === 'L3 Max')!
    const low = ctx.labels.find(l => l.text === 'L3 Min')!
    expect(Math.abs(high.y - 96)).toBeLessThan(8)
    expect(Math.abs(low.y - 208)).toBeLessThan(8)
  })

  it('omits the redundant rect-header label for tide kind', () => {
    // For tide kind, the per-line "L3 High Tide" / "L3 Low Tide" labels
    // already convey the kind - the rect header would be redundant.
    const range: L3ScrollRange = {
      kind: 'tide',
      xMin: 0,
      xMax: 2048,
      yMin: 96,
      yMax: 216,
      yHighTide: 96,
      yLowTide: 208,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    const labelTexts = ctx.labels.map(l => l.text)
    expect(labelTexts.some(t => t.startsWith('L3 range'))).toBe(false)
  })

  it('still labels the rect for non-tide kinds (fixed)', () => {
    // Fixed levels have only the rect - keep the kind label so the user
    // knows what they're looking at.
    const range: L3ScrollRange = {
      kind: 'fixed',
      xMin: 0,
      xMax: 2048,
      yMin: 64,
      yMax: 128,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    const labelTexts = ctx.labels.map(l => l.text)
    expect(labelTexts).toContain('L3 range - fixed')
    expect(labelTexts).not.toContain('L3 Max')
    expect(labelTexts).not.toContain('L3 Min')
  })

  it('uses a camera-tracked-specific label', () => {
    const range: L3ScrollRange = {
      kind: 'camera-tracked',
      xMin: 0,
      xMax: 2048,
      yMin: 64,
      yMax: 128,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    expect(ctx.labels[0]!.text).toContain('camera-tracked')
  })

  it('renders nothing when scrollRange.kind === "none"', () => {
    const range: L3ScrollRange = {
      kind: 'none',
      xMin: 0,
      xMax: 0,
      yMin: 0,
      yMax: 0,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    expect(ctx.rects).toHaveLength(0)
    expect(ctx.fills).toBe(0)
    expect(ctx.strokes).toBe(0)
    expect(ctx.labels).toHaveLength(0)
  })

  it('renders nothing when map.l3 is null', () => {
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(null))
    expect(ctx.rects).toHaveLength(0)
  })

  it('renders nothing when the rect has zero or negative area', () => {
    const range: L3ScrollRange = {
      kind: 'fixed',
      xMin: 100,
      xMax: 100,
      yMin: 0,
      yMax: 100,
    }
    const ctx = makeCtx()
    drawL3Range(ctx, makeMap(range))
    expect(ctx.rects).toHaveLength(0)
  })
})
