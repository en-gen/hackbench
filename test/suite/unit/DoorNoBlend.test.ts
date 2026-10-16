/**
 * Screen-door and hover-lifted sprite pixels never take part in colour math (D60 B, D62 call 2 B, #936):
 * the sprite keeps its own colour where a tile covers it, whatever the covering layer's CGADSUB bit says.
 * Synthetic planes (CI has no ROM); the vanilla no-op check is in DoorNoBlend.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { composeScreen, type ScreenInput } from '../../../src/rom/model/ColorMath'

const W = 8
const H = 4
const SPRITE = [200, 10, 20]
const TILE = [90, 120, 60]
const SUB = [64, 32, 48]
const FIXED = [8, 16, 24] as const
// Add, half add, subtract, half subtract, each with layer 1 (bit 0) in the table.
const MODES = [0x01, 0x41, 0x81, 0xc1]

/** Columns 0-3 hold a sprite under a layer 1 tile; columns 4-7 hold the tile alone. Sub screen: opaque layer 2. */
function input(cgadsub: number, lift?: number): ScreenInput {
  const n = W * H
  const [sprites, l1, l2] = [0, 1, 2].map(() => new Uint8ClampedArray(n * 4))
  const doors = new Uint32Array(n)
  for (let p = 0; p < n; p++) {
    const [x, y] = [p % W, Math.floor(p / W)]
    l1.set([...TILE, 255], p * 4)
    l2.set([...SUB, 255], p * 4)
    if (x < 4) {
      sprites!.set([...SPRITE, 255], p * 4)
      doors[p] = (1 << 1) | ((x + y) & 1)
    }
  }
  return {
    width: W,
    height: H,
    planes: { sprites2: sprites, l1High: l1, l2Low: l2 },
    lists: { main: ['sprites2', 'l1High'], sub: ['l2Low'] },
    math: { cgadsub, fixed: FIXED },
    doors,
    lift,
  }
}
const px = (o: Uint8ClampedArray, p: number) => Array.from(o.subarray(p * 4, p * 4 + 4))
const SPRITE_PIXELS = Array.from({ length: W * H }, (_, p) => p).filter(p => p % W < 4)
const TILE_PIXELS = Array.from({ length: W * H }, (_, p) => p).filter(p => p % W >= 4)

describe('door pixels do not blend (D60 B, #936)', () => {
  for (const mode of MODES) {
    it(`cgadsub ${mode.toString(16)}: every door pixel, both parities, equals the output with colour math off`, () => {
      const [on, off] = [composeScreen(input(mode)), composeScreen(input(0))]
      const parities = new Set(SPRITE_PIXELS.map(p => ((p % W) + Math.floor(p / W)) & 1))
      expect(parities.size).toBe(2)
      for (const p of SPRITE_PIXELS) expect(px(on, p), `pixel ${p}`).toEqual(px(off, p))
    })
    it(`cgadsub ${mode.toString(16)}: pixels outside the door still blend`, () => {
      const [on, off] = [composeScreen(input(mode)), composeScreen(input(0))]
      for (const p of TILE_PIXELS) expect(px(on, p), `pixel ${p}`).not.toEqual(px(off, p))
    })
  }
  it('plain add outside the door is the 5-bit sum of the tile and the sub pixel, as before', () => {
    const on = composeScreen(input(0x01))
    const want = TILE.map((v, c) => {
      const s = Math.min((v >> 3) + (SUB[c]! >> 3), 31)
      return (s << 3) | (s >> 2)
    })
    expect(px(on, 4)).toEqual([...want, 255])
  })
})

describe('hover-lifted pixels do not blend (D62 call 2 B, #936)', () => {
  for (const mode of MODES) {
    it(`cgadsub ${mode.toString(16)}: every lifted pixel equals the output with colour math off, the sprite colour`, () => {
      const [on, off] = [composeScreen(input(mode, 1)), composeScreen(input(0, 1))]
      for (const p of SPRITE_PIXELS) {
        expect(px(on, p), `pixel ${p}`).toEqual(px(off, p))
        expect(px(on, p)).toEqual([...SPRITE, 255])
      }
      for (const p of TILE_PIXELS) expect(px(on, p)).not.toEqual(px(off, p))
    })
  }
})
