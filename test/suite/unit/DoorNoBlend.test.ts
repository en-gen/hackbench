/**
 * Screen-door and hover-lifted sprite pixels: only the sprite part skips color math (D60 B, D62 call 2 B,
 * #936). The sprite keeps its own color where a tile covers it; the tile part of a dim door pixel still
 * takes the covering layer's CGADSUB bit. Synthetic planes (CI has no ROM); the vanilla no-op check is in
 * DoorNoBlend.corpus.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { composeScreen, type ScreenInput, type SourceKey } from '../../../src/rom/model/ColorMath'
import { doorPixelsUnderMath } from '../support/doorBlend'
import { hiddenPixelStrength } from '../../../src/rom/render/HiddenTiles'

const W = 8
const H = 4
const SPRITE = [200, 10, 20]
const TILE = [90, 120, 60]
const SUB = [64, 32, 48]
const FIXED = [8, 16, 24] as const
const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
// Add, half add, subtract, half subtract.
const MODES = [0x00, 0x40, 0x80, 0xc0]
const COVERS = (['l1', 'l2', 'l3'] as const).flatMap(l =>
  (['Low', 'High'] as const).map(p => ({ layer: l, key: `${l}${p}` as SourceKey })),
)
const COMBOS = COVERS.flatMap(c => MODES.map(m => ({ ...c, mode: m, cgadsub: m | BIT[c.layer] })))

/** Columns 0-3 hold a sprite under the covering tile; columns 4-7 hold the tile alone. */
function input(
  key: SourceKey,
  cgadsub: number,
  o: { sub: boolean; door: boolean; lift?: number },
): ScreenInput {
  const n = W * H
  const [sprites, tile, subPlane] = [0, 1, 2].map(() => new Uint8ClampedArray(n * 4))
  const doors = new Uint32Array(n)
  for (let p = 0; p < n; p++) {
    const [x, y] = [p % W, Math.floor(p / W)]
    tile.set([...TILE, 255], p * 4)
    subPlane.set([...SUB, 255], p * 4)
    if (x < 4) {
      sprites!.set([...SPRITE, 255], p * 4)
      doors[p] = (1 << 1) | ((x + y) & 1)
    }
  }
  return {
    width: W,
    height: H,
    planes: { sprites2: o.door ? sprites : null, [key]: tile, l2Low: subPlane },
    lists: { main: o.door ? ['sprites2', key] : [key], sub: o.sub ? ['l2Low'] : [] },
    math: { cgadsub, fixed: FIXED },
    doors: o.door ? doors : null,
    lift: o.lift,
  }
}
const px = (o: Uint8ClampedArray, p: number) => Array.from(o.subarray(p * 4, p * 4 + 4))
const ALL = Array.from({ length: W * H }, (_, p) => p)
const SPRITE_PIXELS = ALL.filter(p => p % W < 4)
const TILE_PIXELS = ALL.filter(p => p % W >= 4)
const parity = (p: number) => ((p % W) + Math.floor(p / W)) & 1
const mix = (under: number[], w: number) => [...under.map((v, c) => Math.round(v * (1 - w) + SPRITE[c]! * w)), 255] // prettier-ignore

describe.each([
  { sub: true, name: 'opaque sub screen' },
  { sub: false, name: 'empty sub screen (fixed color)' },
])('door and lifted pixels, $name (D60 B, D62 call 2 B, #936)', ({ sub }) => {
  it.each(COMBOS)(
    '$key cgadsub $cgadsub: dim pixel is the tile through color math at 3/4 plus the sprite at 1/4, bright is the sprite',
    ({ key, cgadsub }) => {
      const on = composeScreen(input(key, cgadsub, { sub, door: true }))
      // The tile alone through the same table: what the tile part of a door pixel still takes.
      const tileOnly = composeScreen(input(key, cgadsub, { sub, door: false }))
      expect(px(tileOnly, 0).slice(0, 3), 'color math must act on the tile').not.toEqual(TILE)
      expect(new Set(SPRITE_PIXELS.map(parity)).size).toBe(2)
      for (const p of SPRITE_PIXELS) {
        const w = hiddenPixelStrength(parity(p), 0)
        expect(px(on, p), `pixel ${p}`).toEqual(mix(px(tileOnly, p).slice(0, 3), w))
        if (w === 1) expect(px(on, p)).toEqual([...SPRITE, 255])
      }
      for (const p of TILE_PIXELS) expect(px(on, p), `pixel ${p}`).toEqual(px(tileOnly, p))
    },
  )
  it.each(COMBOS)(
    '$key cgadsub $cgadsub: a lifted pixel of either parity is the sprite color, unblended',
    ({ key, cgadsub }) => {
      const on = composeScreen(input(key, cgadsub, { sub, door: true, lift: 1 }))
      const tileOnly = composeScreen(input(key, cgadsub, { sub, door: false }))
      expect(new Set(SPRITE_PIXELS.map(parity)).size).toBe(2)
      for (const p of SPRITE_PIXELS) expect(px(on, p), `pixel ${p}`).toEqual([...SPRITE, 255])
      for (const p of TILE_PIXELS) expect(px(on, p)).toEqual(px(tileOnly, p))
    },
  )
})

describe('door pixel witness (#936 review)', () => {
  it('cgadsub 0x41, tile [90,120,60], sprite [200,10,20], sub [64,32,48]: the dim pixel is [106,58,42]', () => {
    const on = composeScreen(input('l1High', 0x41, { sub: true, door: true }))
    const dim = SPRITE_PIXELS.find(p => hiddenPixelStrength(parity(p), 0) !== 1)!
    expect(px(on, dim)).toEqual([106, 58, 42, 255])
  })
})

describe('the corpus predicate goes red on a planted defect (#936)', () => {
  const plant = (cgadsub: number, main: string[], covered = true) => {
    const planes: Record<string, Uint8ClampedArray> = {}
    for (const k of main) planes[k] = new Uint8ClampedArray([1, 2, 3, 255])
    if (!covered) planes[main[0]!] = new Uint8ClampedArray(4)
    return doorPixelsUnderMath(main, planes, new Uint32Array([3]), cgadsub)
  }
  it.each(['l1', 'l2', 'l3'])(
    'a door pixel under %s with its bit in CGADSUB is reported',
    layer => {
      const bit = { l1: 1, l2: 2, l3: 4 }[layer]!
      expect(plant(bit, ['sprites2', `${layer}High`])).toEqual({ doorPixels: 1, blended: 1 })
      expect(plant(0x20, ['sprites2', `${layer}High`])).toEqual({ doorPixels: 1, blended: 0 })
    },
  )
  it('a pixel with no placed sprite under the tile, or a flame plane only, is not a door pixel', () => {
    expect(plant(7, ['sprites2', 'l1High'], false)).toEqual({ doorPixels: 0, blended: 0 })
    expect(plant(7, ['spritesL2Low', 'l1High'])).toEqual({ doorPixels: 0, blended: 0 })
  })
})
