/**
 * The whole-sprite screen door of a revealed sprite (#1132) in ColorMath: every pixel of it is drawn at the door's
 * strength, tile or no tile, and the tile under a dim pixel keeps its own color math (D60 B, as for a sprite a tile
 * covers). Synthetic planes (CI has no ROM). Each claim has a control that moves it.
 */
import { describe, expect, it } from 'vitest'
import {
  composeScreen,
  doorFlips,
  WHOLE_DOOR,
  type ScreenInput,
  type SourceKey,
} from '../../../src/rom/model/ColorMath'
import { HIDDEN_TILE_DIM_ALPHA } from '../../../src/rom/render/HiddenTiles'

const [W, H] = [4, 2]
const N = W * H
const SPRITE = [200, 10, 20]
const TILE = [90, 120, 60]
const SUB = [64, 32, 48]
const FIXED = [8, 16, 24] as const
const ID = 5 | WHOLE_DOOR
const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const
const MODES = [0x00, 0x40, 0x80, 0xc0]
const parity = (p: number) => ((p % W) + Math.floor(p / W)) & 1
const px = (o: Uint8ClampedArray, p: number) => Array.from(o.subarray(p * 4, p * 4 + 4))

const plane = (rgb: number[], alpha = 255) => {
  const d = new Uint8ClampedArray(N * 4)
  for (let p = 0; p < N; p++) d.set([...rgb, alpha], p * 4)
  return d
}
const doors = (id = ID) => Uint32Array.from({ length: N }, (_, p) => (id << 1) | parity(p))
const FULL = new Map([[ID, false]])
const SWAPPED = new Map([[ID, true]])

/** A whole-door sprite over a tile on `key`, color math on the tile's layer; `sub` adds a sub screen. */
function over(key: SourceKey, cgadsub: number, sub: boolean, withSprite = true): ScreenInput {
  const subKey: SourceKey = key === 'l2Low' ? 'l2High' : 'l2Low'
  return {
    width: W,
    height: H,
    planes: {
      sprites2: withSprite ? plane(SPRITE) : null,
      [key]: plane(TILE),
      [subKey]: plane(SUB),
    },
    lists: { main: withSprite ? [key, 'sprites2'] : [key], sub: sub ? [subKey] : [] },
    math: { cgadsub, fixed: FIXED },
    doors: withSprite ? doors() : null,
    flips: FULL,
  }
}

describe('a whole-door sprite pixel over a tile (D60 B)', () => {
  const combos = (['l1', 'l2', 'l3'] as const).flatMap(l =>
    MODES.flatMap(m => [false, true].map(sub => ({ l, key: `${l}Low` as SourceKey, m, sub }))),
  )
  it.each(combos)(
    'layer $l mode $m sub $sub: the tile keeps its color math under the dim part',
    c => {
      const cgadsub = c.m | BIT[c.l]
      const alone = composeScreen(over(c.key, cgadsub, c.sub, false))
      const got = composeScreen(over(c.key, cgadsub, c.sub))
      expect(px(alone, 0)).not.toEqual([...TILE, 255]) // the control: the math really changes the tile
      for (let p = 0; p < N; p++) {
        const w = parity(p) === 0 ? 1 : HIDDEN_TILE_DIM_ALPHA
        const want = px(alone, p)
          .slice(0, 3)
          .map((v, k) => Math.round(v * (1 - w) + SPRITE[k]! * w))
        expect(px(got, p)).toEqual([...want, 255])
      }
    },
  )

  it('control: a layer outside CGADSUB leaves the tile part unmathed', () => {
    const got = composeScreen(over('l1Low', BIT.l2, false))
    const w = HIDDEN_TILE_DIM_ALPHA
    expect(px(got, 1)).toEqual([
      ...TILE.map((v, k) => Math.round(v * (1 - w) + SPRITE[k]! * w)),
      255,
    ])
  })
})

describe('what the whole door touches', () => {
  it('draws a Layer 2 flame plane (spritesL2) solid, whatever its door word says', () => {
    const i: ScreenInput = {
      width: W,
      height: H,
      planes: { spritesL2Low: plane(SPRITE), l1Low: plane(TILE) },
      lists: { main: ['l1Low', 'spritesL2Low'], sub: [] },
      math: null,
      doors: doors(),
      flips: FULL,
    }
    const out = composeScreen(i)
    for (let p = 0; p < N; p++) expect(px(out, p)).toEqual([...SPRITE, 255])
  })

  it('never dims a tile, only the sprite planes', () => {
    const i: ScreenInput = {
      width: W,
      height: H,
      planes: { l1Low: plane(TILE) },
      lists: { main: ['l1Low'], sub: [] },
      math: null,
      doors: doors(),
      flips: FULL,
    }
    const out = composeScreen(i)
    for (let p = 0; p < N; p++) expect(px(out, p)).toEqual([...TILE, 255])
  })

  it('swaps the squares with the door flip', () => {
    const base = (flips: Map<number, boolean>): ScreenInput => ({
      width: W,
      height: H,
      planes: { sprites2: plane(SPRITE) },
      lists: { main: ['sprites2'], sub: [] },
      math: null,
      doors: doors(),
      flips,
    })
    const [a, b] = [composeScreen(base(FULL)), composeScreen(base(SWAPPED))]
    const dim = Math.round(HIDDEN_TILE_DIM_ALPHA * 255)
    expect([px(a, 0)[3], px(a, 1)[3]]).toEqual([255, dim])
    expect([px(b, 0)[3], px(b, 1)[3]]).toEqual([dim, 255])
  })

  it('counts a whole door over every pixel for its swap, with no tile anywhere', () => {
    const count = (d: Uint32Array) =>
      doorFlips({
        width: W,
        height: H,
        planes: {},
        lists: { main: [], sub: [] },
        math: null,
        doors: d,
      })
    const mixed = (evenPixels: number) =>
      Uint32Array.from({ length: N }, (_, p) => (ID << 1) | (p < evenPixels ? 0 : 1))
    expect(count(mixed(6))!.get(ID)).toBe(true)
    expect(count(mixed(2))!.get(ID)).toBe(false)
    // Control: the same pixels with an ordinary door id, and no tile over them, count nothing.
    expect(count(Uint32Array.from({ length: N }, (_, p) => (5 << 1) | parity(p)))!.size).toBe(0)
  })
})
