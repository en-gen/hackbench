/** overworldHalves splits the composed overworld into its two halves (#431); no ROM needed. */
import { describe, it, expect } from 'vitest'
import { overworldHalves } from '../../../theia/extension/src/browser/map16-pixels'

/** RGBA where red = x and green = y, so any swap, offset or stride error shows. */
function grid(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([x, y, 7, 255], (y * w + x) * 4)
  return px
}

describe('overworldHalves', () => {
  it('returns the left half first and the right half second, row by row', () => {
    const [left, right] = overworldHalves(grid(8, 3), 8, 3)!
    expect(left).toHaveLength(4 * 3 * 4)
    for (let y = 0; y < 3; y++)
      for (let x = 0; x < 4; x++) {
        expect([...left.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]).toEqual([x, y, 7, 255])
        expect([...right.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)]).toEqual([
          x + 4,
          y,
          7,
          255,
        ])
      }
  })

  it('refuses an odd width', () => {
    expect(overworldHalves(grid(7, 2), 7, 2)).toBeNull()
  })
})
