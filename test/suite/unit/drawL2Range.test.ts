/**
 * drawL2Range — "Show L2 BG range" overlay renderer (sibling of drawL3Range).
 *
 * Locks the canvas operations the overlay emits. Scroll-range derivation is
 * tested separately in L2ScrollRange.test.ts.
 */

import { describe, expect, it } from 'vitest'
import { drawL2Range, type L2RangeDrawCtx } from '../../../src/webview/mapEditor/overlays/drawL2Range'
import { L2ObjectStream, L2Preset } from '../../../src/rom/model/L2Layer'
import type { SmwMap } from '../../../src/rom/model/SmwMap'
import type { L2ScrollRange } from '../../../src/rom/L2Loader'

interface RectOp { x: number; y: number; w: number; h: number }
interface CtxRecorder extends L2RangeDrawCtx {
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
    save()    { ctx.saved++ },
    restore() { ctx.restored++ },
    beginPath() {},
    rect(x, y, w, h) { rects.push({ x, y, w, h }) },
    moveTo() {},
    lineTo() {},
    fill()   { ctx.fills++ },
    stroke() { ctx.strokes++ },
    fillText(text, x, y) { labels.push({ text, x, y }) },
    strokeText() {},
  }
  return ctx
}

function makeMap(range: L2ScrollRange | null): SmwMap {
  const grid: (number | null)[][] = []
  const l1Tiles = new Map()
  const l2 = range === null ? null : new L2ObjectStream(grid, l1Tiles, 0xC0, range)
  return { l2 } as unknown as SmwMap
}

describe('drawL2Range', () => {
  it('emits rect + fill + stroke + label for fixed kind without cmd', () => {
    const range: L2ScrollRange = {
      kind: 'fixed', xMin: 0, xMax: 256 * 11, yMin: 50, yMax: 200,
    }
    const ctx = makeCtx()
    drawL2Range(ctx, makeMap(range))

    expect(ctx.rects).toEqual([{ x: 0, y: 50, w: 256 * 11, h: 150 }])
    expect(ctx.fills).toBe(1)
    expect(ctx.strokes).toBe(1)
    expect(ctx.labels).toHaveLength(1)
    expect(ctx.labels[0]!.text).toBe('L2 range')
    expect(ctx.saved).toBe(1)
    expect(ctx.restored).toBe(1)
  })

  it('annotates the label with the L1 cmd byte when present', () => {
    const range: L2ScrollRange = {
      kind: 'fixed', xMin: 0, xMax: 2048, yMin: 64, yMax: 128, layer1ScrollCmd: 0x0E,
    }
    const ctx = makeCtx()
    drawL2Range(ctx, makeMap(range))
    expect(ctx.labels[0]!.text).toBe('L2 range (L1 cmd $0E)')
  })

  it('renders nothing when scrollRange.kind === "none"', () => {
    const range: L2ScrollRange = { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 }
    const ctx = makeCtx()
    drawL2Range(ctx, makeMap(range))
    expect(ctx.rects).toHaveLength(0)
  })

  it('renders nothing when map.l2 is null', () => {
    const ctx = makeCtx()
    drawL2Range(ctx, makeMap(null))
    expect(ctx.rects).toHaveLength(0)
  })

  it('renders nothing for preset-BG L2 (only object-stream supported)', () => {
    const ctx = makeCtx()
    const presetGrid: (number | null)[][] = [[0]]
    const bgTiles = new Map()
    const l2 = new L2Preset(0, presetGrid, bgTiles)
    const map = { l2 } as unknown as SmwMap
    drawL2Range(ctx, map)
    expect(ctx.rects).toHaveLength(0)
  })

  it('renders nothing when the rect has zero or negative area', () => {
    const range: L2ScrollRange = { kind: 'fixed', xMin: 100, xMax: 100, yMin: 0, yMax: 100 }
    const ctx = makeCtx()
    drawL2Range(ctx, makeMap(range))
    expect(ctx.rects).toHaveLength(0)
  })
})
