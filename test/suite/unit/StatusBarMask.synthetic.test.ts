import { describe, expect, it } from 'vitest'
import {
  maskStatusBar,
  statusBarRows,
  STATUS_BAR_HEIGHT,
} from '../../../tools/scripts/statusBarMask'
import * as D from '../../../tools/scripts/capture_decode'

// A 4 x 64 capture whose only opaque row is `row`, against our drawing of
// nothing. Returns differing pixels with the shared mask applied (or not).
function differ(row: number, rows: number | null): number {
  const W = 4
  const H = 64
  const base = new Uint8ClampedArray(W * H * 4)
  const opaque = new Uint8Array(W * H)
  const px = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) px.set([255, 0, 255, 255], i * 4) // the sentinel: clear
  for (let x = 0; x < W; x++) px.set([8, 8, 8, 255], (row * W + x) * 4)
  const skip = new Uint8Array(W * H)
  if (rows !== null) maskStatusBar(skip, W, H, rows)
  const pic = { x: 0, y: 0, w: W, h: H, px, sentinel: [255, 0, 255], skip }
  return D.refDiff(base, opaque, W, H, pic as never, 0).differ
}

describe('status bar mask (#880)', () => {
  it('falls back to lines 0..36 and takes a recorded line over the constant', () => {
    expect(STATUS_BAR_HEIGHT).toBe(36)
    expect(statusBarRows()).toBe(STATUS_BAR_HEIGHT + 1)
    expect(statusBarRows(null)).toBe(STATUS_BAR_HEIGHT + 1)
    expect(statusBarRows(-1)).toBe(STATUS_BAR_HEIGHT + 1) // no interrupt seen: constant
    expect(statusBarRows(45)).toBe(46) // Morton/Roy: the capture's own line wins
    expect(statusBarRows(30)).toBe(31) // a recorded line below the constant narrows it
    expect(statusBarRows(0)).toBe(1) // line 0 is a real recorded line, not "none"
  })

  it('irqLine 0 masks exactly line 0', () => {
    expect(differ(0, statusBarRows(0))).toBe(0)
    expect(differ(1, statusBarRows(0))).toBe(4)
  })

  it('unmasked, planted bar pixels on lines 0 and 36 go red; masked they stay green', () => {
    for (const row of [0, 20, 36]) {
      expect(differ(row, null)).toBe(4)
      expect(differ(row, statusBarRows())).toBe(0)
    }
  })

  // Literal 36/37/45/46 are the independent oracle: they fail if the
  // exported constant is mutated.
  it('is not too wide: line 37 still goes red by default; with irqLine 45 line 45 is masked and 46 is red', () => {
    expect(differ(36, statusBarRows())).toBe(0)
    expect(differ(37, statusBarRows())).toBe(4)
    expect(differ(45, statusBarRows())).toBe(4) // outside a normal room's bar
    expect(differ(45, statusBarRows(45))).toBe(0)
    expect(differ(46, statusBarRows(45))).toBe(4)
  })

  it('goes red when its constant is wrong (planted 35 and 38 fail the boundary)', () => {
    const boundaryHolds = (rows: number) => differ(36, rows) === 0 && differ(37, rows) === 4
    expect(boundaryHolds(statusBarRows())).toBe(true)
    expect(boundaryHolds(36)).toBe(false) // one row short: line 36 leaks
    expect(boundaryHolds(38)).toBe(false) // one row long: line 37 hidden
  })
})
