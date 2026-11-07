/**
 * Play's view side: the frame is chosen by time, and Layer 2 is drawn at the run's offset with the rows that
 * scroll in taken from the wrapped strip. Synthetic planes, no ROM.
 */
import { describe, expect, it } from 'vitest'
import {
  decodeStrips,
  FRAME_MS,
  frameAt,
  shiftPlane,
  type Motion,
} from '../../../theia/extension/src/browser/map-motion-play'

const W = 2
const H = 6
const EXTRA = 2

/** A plane whose row r is filled with r + 1 (alpha 255), over the screen's rows then the strip's. */
const rows = (from: number, count: number): Uint8ClampedArray => {
  const a = new Uint8ClampedArray(W * 4 * count)
  for (let r = 0; r < count; r++)
    for (let x = 0; x < W; x++) a.set([from + r + 1, 0, 0, 255], (r * W + x) * 4)
  return a
}
const rowValues = (p: Uint8ClampedArray | null) =>
  Array.from({ length: H }, (_, r) => (p ? p[r * W * 4]! : -1))

describe('shiftPlane', () => {
  const base = rows(0, H)
  const extra = rows(H, EXTRA)

  it('offset 0 is the plane as it was', () => {
    expect(rowValues(shiftPlane(base, extra, W, H, EXTRA, 0))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a positive offset moves Layer 2 down; the rows that enter come from the wrapped strip', () => {
    // Row r shows what was at r - 2: the top two rows are the strip's (7, 8), then rows 1..4.
    expect(rowValues(shiftPlane(base, extra, W, H, EXTRA, 2))).toEqual([7, 8, 1, 2, 3, 4])
  })

  it('a negative offset moves it up and wraps through the strip', () => {
    expect(rowValues(shiftPlane(base, extra, W, H, EXTRA, -3))).toEqual([4, 5, 6, 7, 8, 1])
  })

  it('an offset of a whole period is the plane as it was', () => {
    expect(rowValues(shiftPlane(base, extra, W, H, EXTRA, H + EXTRA))).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('a plane nothing drew in stays blank, and one drawn only in the strip shows it', () => {
    expect(shiftPlane(null, null, W, H, EXTRA, 3)).toBeNull()
    const only = shiftPlane(null, extra, W, H, EXTRA, 2)
    expect(rowValues(only)).toEqual([7, 8, 0, 0, 0, 0])
  })
})

describe('frameAt', () => {
  it('advances 60 a second by time, however often it is asked', () => {
    expect(frameAt(0, 100)).toBe(0)
    expect(frameAt(FRAME_MS * 0.9, 100)).toBe(0)
    expect(frameAt(FRAME_MS * 1.1, 100)).toBe(1)
    expect(frameAt(1001, 100)).toBe(60)
  })

  it('loops back to the load state', () => {
    expect(frameAt(FRAME_MS * 100.5, 100)).toBe(0)
    expect(frameAt(FRAME_MS * 250.5, 100)).toBe(50)
  })

  it('a run of no frames stays at 0', () => {
    expect(frameAt(5000, 0)).toBe(0)
  })
})

describe('decodeStrips', () => {
  const b64 = (v: number) => Buffer.from(Uint8Array.of(v, 0, 0, 255)).toString('base64')
  const motion = (strips: Motion['strips']) => ({ strips }) as Motion

  it('keeps the low and high planes apart and passes a screen with nothing as blank planes', () => {
    const [a, b] = decodeStrips(motion([{ low: b64(1), high: b64(2) }, null]))
    expect([a!.low![0], a!.high![0]]).toEqual([1, 2])
    expect(b).toEqual({ low: null, high: null })
    const [c] = decodeStrips(motion([{ low: null, high: b64(9) }]))
    expect([c!.low, c!.high![0]]).toEqual([null, 9])
  })
})
