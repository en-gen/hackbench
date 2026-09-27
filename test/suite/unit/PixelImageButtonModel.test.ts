/**
 * Pure placement math for pixel-image-button.tsx, tested without a DOM. The
 * component itself is covered through the Map16 switch toggles in map16-view.spec.cjs.
 */
import { describe, it, expect, vi } from 'vitest'
import { placeInFrame } from '../../../theia/extension/src/browser/pixel-image-button-model'

const FRAME = { width: 16, height: 16 }

describe('placeInFrame', () => {
  const IMG = { width: 4, height: 6 } // slack: x=12, y=10

  it.each([
    ['start', 'start', { x: 0, y: 0 }],
    ['start', 'center', { x: 0, y: 5 }],
    ['start', 'end', { x: 0, y: 10 }],
    ['center', 'start', { x: 6, y: 0 }],
    ['center', 'center', { x: 6, y: 5 }],
    ['center', 'end', { x: 6, y: 10 }],
    ['end', 'start', { x: 12, y: 0 }],
    ['end', 'center', { x: 12, y: 5 }],
    ['end', 'end', { x: 12, y: 10 }],
  ] as const)('align x=%s y=%s -> %o', (x, y, expected) => {
    expect(placeInFrame(IMG, FRAME, { x, y })).toEqual(expected)
  })

  it('centers by default, flooring an odd slack', () => {
    expect(placeInFrame({ width: 13, height: 9 }, FRAME)).toEqual({ x: 1, y: 3 })
  })

  it('ignores align, and does not warn, when the image exactly fills the frame', () => {
    const warn = vi.fn()
    for (const x of ['start', 'center', 'end'] as const)
      for (const y of ['start', 'center', 'end'] as const)
        expect(placeInFrame(FRAME, FRAME, { x, y }, warn)).toEqual({ x: 0, y: 0 })
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['start', { width: 20, height: 24 }, { x: 0, y: 0 }],
    ['end', { width: 20, height: 24 }, { x: -4, y: -8 }],
    ['center', { width: 20, height: 8 }, { x: -2, y: 4 }],
  ] as const)('an oversize image aligned %s warns once and clips at %o', (a, img, expected) => {
    const warn = vi.fn()
    expect(placeInFrame(img, FRAME, { x: a, y: a }, warn)).toEqual(expected)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain(`${img.width}x${img.height}`)
    expect(warn.mock.calls[0]![0]).toContain('16x16')
  })
})
