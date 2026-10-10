/**
 * The SNES color math stage (#562): synthetic pixels only, no ROM. Values are
 * written in 5-bit channels (`c5`) because that is the space the PPU adds in.
 */
import { describe, it, expect } from 'vitest'
import {
  composeScreen,
  effectiveCgadsub,
  type Rgb,
  type ScreenInput,
} from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'

const ex = (v: number) => (v << 3) | (v >> 2)
const c5 = (r: number, g: number, b: number): Rgb => [ex(r), ex(g), ex(b)]
const plane = (c: Rgb | null) => new Uint8ClampedArray(c ? [...c, 255] : [0, 0, 0, 0])
const BACK = c5(0, 0, 0)
const rgba = (c: Rgb) => [...c, 255]

/** One pixel: l1 on the main list, l2 on the sub list, unless a test says otherwise. */
function one(o: Partial<ScreenInput> & { l1?: Rgb | null; l2?: Rgb | null } = {}): number[] {
  const { l1 = c5(10, 10, 10), l2 = c5(4, 4, 4), ...rest } = o
  return [
    ...composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x01, fixed: BACK },
      lists: { main: ['l1Low'], sub: ['l2Low'] },
      planes: { l1Low: plane(l1), l2Low: plane(l2) },
      ...rest,
    }),
  ]
}

describe('composeScreen color math', () => {
  it('adds the sub pixel to a main layer that is in CGADSUB', () => {
    expect(one()).toEqual(rgba(c5(14, 14, 14)))
  })
  it('subtracts when bit 7 is set, clamping at 0', () => {
    expect(one({ l1: c5(10, 3, 10), math: { cgadsub: 0x81, fixed: BACK } })).toEqual(
      rgba(c5(6, 0, 6)),
    )
  })
  it('halves when bit 6 is set and there is a sub pixel', () => {
    expect(one({ math: { cgadsub: 0x41, fixed: BACK } })).toEqual(rgba(c5(7, 7, 7)))
  })
  // snes9x tileimpl.h:176-181 (MATHS1_2::Calc) and bsnes sfc/ppu-fast/line.cpp:111:
  // against the fixed color the half is NOT applied.
  it('skips the half against the fixed color (no sub pixel)', () => {
    const out = one({ l2: null, math: { cgadsub: 0x41, fixed: c5(4, 4, 4) } })
    expect(out).toEqual(rgba(c5(14, 14, 14))) // 10 + 4, not (10 + 4) >> 1
  })
  it('mode 11: subtract and half against a black fixed color leaves layer 1 unchanged', () => {
    expect(one({ l2: null, math: { cgadsub: 0xfb, fixed: BACK } })).toEqual(rgba(c5(10, 10, 10)))
  })
  it('a layer not in CGADSUB is untouched, byte for byte, not re-quantized', () => {
    const raw: Rgb = [81, 3, 250]
    expect(one({ l1: raw, math: { cgadsub: 0x02, fixed: c5(31, 31, 31) } })).toEqual(rgba(raw))
  })
  it('null math is the main pixel as is', () => {
    expect(one({ math: null })).toEqual(rgba(c5(10, 10, 10)))
  })
  it('the 5-bit round trip holds for all 32 values', () => {
    for (let v = 0; v < 32; v++) {
      expect(one({ l1: c5(v, v, v), l2: c5(0, 0, 0) })).toEqual(rgba(c5(v, v, v)))
    }
  })
})

// CODE_00922F clears CGRAM color 0 before every palette upload (bank_00.asm:2046-2049), so the
// main-screen backdrop is black; the back area color reaches the screen only as the fixed color
// (COLDATA, bank_00.asm:5867-5885), added through CGADSUB's backdrop bit.
describe('the backdrop is a black main-screen layer for CGADSUB (bit 5)', () => {
  const back = (l2: Rgb | null, fixed: Rgb, cgadsub = 0x24) => [
    ...composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub, fixed },
      lists: { main: ['l1Low'], sub: ['l2Low'] },
      planes: { l1Low: plane(null), l2Low: plane(l2) },
    }),
  ]
  const AREA = c5(5, 5, 5)
  it('a non-black back area leaves layer 2 unchanged under CGADSUB $24 (a hack)', () => {
    expect(back(c5(7, 8, 9), AREA)).toEqual(rgba(c5(7, 8, 9)))
    expect(back(c5(30, 2, 2), AREA)).toEqual(rgba(c5(30, 2, 2)))
  })
  it('main and sub both empty: transparent, so the back area layer shows', () => {
    expect(back(null, AREA)[3]).toBe(0)
    expect(back(null, BACK)[3]).toBe(0)
  })
  it('mode 0C style (CGADSUB $70): layer 2 shows halved, and the back area where nothing draws', () => {
    expect(back(c5(20, 10, 6), AREA, 0x70)).toEqual(rgba(c5(10, 5, 3)))
    expect(back(null, AREA, 0x70)[3]).toBe(0)
  })
  it('a sub pixel equal to the fixed color is a real pixel, not the empty back area', () => {
    expect(back(AREA, AREA)).toEqual(rgba(AREA)) // main empty, sub drew: opaque
  })
  it('a main layer pixel equal to the fixed color stays opaque', () => {
    const out = composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x02, fixed: AREA }, // layer 1 is not in CGADSUB: untouched
      lists: { main: ['l1Low'], sub: ['l2Low'] },
      planes: { l1Low: plane(AREA), l2Low: plane(null) },
    })
    expect([...out]).toEqual(rgba(AREA))
  })
  it('without the backdrop bit, an empty pixel is black, not the back area', () => {
    expect(back(null, AREA, 0x04)).toEqual(rgba(BACK))
    expect(back(null, AREA, 0xa0)).toEqual(rgba(BACK)) // black minus the fixed color
  })
})

// The hidden-tile screen door (HiddenTiles.ts) draws a tile at partial alpha. That dim is an editor
// affordance, not hardware: the math runs on the tile's color, and the dim blends over what is below.
describe('partial-alpha pixels (the hidden-tile screen door)', () => {
  const dim = (c: Rgb, a: number) => new Uint8ClampedArray([...c, a])
  const run = (l1: Uint8ClampedArray | null, l2: Uint8ClampedArray | null, cgadsub = 0x20) => [
    ...composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub, fixed: BACK },
      lists: { main: ['l1Low'], sub: ['l2Low'] },
      planes: { l1Low: l1, l2Low: l2 },
    }),
  ]
  const mix = (a: Rgb, b: Rgb, w: number) => a.map((v, k) => Math.round(v * w + b[k]! * (1 - w)))
  const W = 64 / 255

  it('a dim main pixel blends over the sub pixel under it, not at full color', () => {
    const l1 = c5(30, 2, 2)
    const l2 = c5(4, 20, 4)
    expect(run(dim(l1, 64), plane(l2))).toEqual([...mix(l1, l2, W), 255])
    expect(run(dim(l1, 64), plane(l2))).not.toEqual(rgba(l1))
  })
  it('a dim main pixel over nothing keeps its alpha, so the back area shows through', () => {
    expect(run(dim(c5(30, 2, 2), 64), null)).toEqual([...c5(30, 2, 2), 64])
  })
  it('a dim pixel in the same list blends over the plane beneath it', () => {
    const out = composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x20, fixed: BACK },
      lists: { main: ['l2Low', 'l1Low'], sub: [] },
      planes: { l1Low: dim(c5(30, 2, 2), 64), l2Low: plane(c5(4, 20, 4)) },
    })
    expect([...out]).toEqual([...mix(c5(30, 2, 2), c5(4, 20, 4), W), 255])
  })
  it('the topmost plane decides CGADSUB membership for a dim over an opaque plane in its list', () => {
    // Layer 3 is in CGADSUB ($24), layer 1 is not: layer 1 is on top, so no math adds layer 2.
    const l1 = c5(30, 2, 2)
    const l3 = c5(4, 20, 4)
    const out = composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x24, fixed: BACK },
      lists: { main: ['l3Low', 'l1Low'], sub: ['l2Low'] },
      planes: { l1Low: dim(l1, 64), l3Low: plane(l3), l2Low: plane(c5(9, 9, 9)) },
    })
    expect([...out]).toEqual([...mix(l1, l3, W), 255])
  })
  it('a dim sub-only pixel (mode 0E style) keeps its alpha', () => {
    const out = composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x24, fixed: BACK },
      lists: { main: ['l3Low'], sub: ['l1Low'] },
      planes: { l1Low: dim(c5(10, 20, 30), 64), l3Low: null },
    })
    expect([...out]).toEqual([...c5(10, 20, 30), 64])
  })
  it('with no math, a dim pixel over nothing keeps its alpha', () => {
    const out = composeScreen({
      width: 1,
      height: 1,
      math: null,
      lists: { main: ['l1Low'], sub: [] },
      planes: { l1Low: dim(c5(10, 20, 30), 64) },
    })
    expect([...out]).toEqual([...c5(10, 20, 30), 64])
  })
  it('the math runs on the tile color, not on the dimmed one', () => {
    const l1 = c5(10, 10, 10)
    const l2 = c5(4, 4, 4)
    // Layer 1 and the backdrop in CGADSUB: layer 1 adds layer 2 (14 per channel), the dim blends over layer 2 alone.
    expect(run(dim(l1, 64), plane(l2), 0x21)).toEqual([...mix(c5(14, 14, 14), l2, W), 255])
  })
})

describe('layer order and toggles', () => {
  const run = (planes: ScreenInput['planes']) => [
    ...composeScreen({
      width: 1,
      height: 1,
      math: null,
      lists: { main: ['l3Low', 'l1Low'], sub: [] },
      planes,
    }),
  ]
  it('the topmost opaque plane of the main list wins; a null plane drops out', () => {
    expect(run({ l1Low: plane(c5(1, 1, 1)), l3Low: plane(c5(2, 2, 2)) })).toEqual(rgba(c5(1, 1, 1)))
    expect(run({ l1Low: null, l3Low: plane(c5(2, 2, 2)) })).toEqual(rgba(c5(2, 2, 2)))
  })
  it('every plane hidden: transparent, right length, no throw', () => {
    const out = composeScreen({
      width: 3,
      height: 2,
      math: { cgadsub: 0x24, fixed: BACK },
      lists: screenPlanes(0x15, 0x02, true),
      planes: {},
    })
    expect(out.length).toBe(24)
    expect([...out].every(v => v === 0)).toBe(true)
  })
  it('mode 0E: layer 3 alone on main is added onto the sub screen, and off removes the add', () => {
    const lists = screenPlanes(0x04, 0x13, false)
    // $24 keeps BG3 here (the camera-locked case, #563), so bit 2 is in the mask.
    const at = (l3: Rgb | null) => [
      ...composeScreen({
        width: 1,
        height: 1,
        math: { cgadsub: 0x24, fixed: BACK },
        lists,
        planes: { l3Low: plane(l3), l1Low: plane(c5(10, 20, 30)) },
      }),
    ]
    expect(at(c5(12, 0, 5))).toEqual(rgba(c5(22, 20, 31)))
    expect(at(null)).toEqual(rgba(c5(10, 20, 30))) // black backdrop plus the sub screen
  })
  it('mode 02 ($009): layer 3 sits behind layer 1', () => {
    const out = composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x20, fixed: BACK },
      lists: screenPlanes(0x17, 0x00, false),
      planes: { l3Low: plane(c5(2, 2, 2)), l1Low: plane(c5(9, 9, 9)) },
    })
    expect([...out]).toEqual(rgba(c5(9, 9, 9)))
  })
})

describe('the sprite layer as a source (#564)', () => {
  const run = (sprite: Rgb | null) => [
    ...composeScreen({
      width: 1,
      height: 1,
      math: { cgadsub: 0x11, fixed: BACK }, // layer 1 and the OBJ bit in CGADSUB: sprites still take no part
      lists: { main: ['l1Low', 'sprites'], sub: ['l2Low'] },
      planes: { l1Low: plane(c5(10, 10, 10)), l2Low: plane(c5(4, 4, 4)), sprites: sprite ? plane(sprite) : null }, // prettier-ignore
    }),
  ]
  it('a sprite pixel covers layer 1 and takes no part in the math', () => {
    expect(run(c5(1, 2, 3))).toEqual(rgba(c5(1, 2, 3)))
  })
  it('with no sprite there the layer 1 pixel is added onto layer 2 as before', () => {
    expect(run(null)).toEqual(rgba(c5(14, 14, 14)))
  })
})

describe('layer 1 priority against sprites (#529)', () => {
  // The lists come from screenPlanes, so moving 'sprites' after l1High there turns the first case red.
  const run = (planes: ScreenInput['planes']) => [
    ...composeScreen({
      width: 1,
      height: 1,
      math: null,
      lists: screenPlanes(0x13, 0x00, false),
      planes,
    }),
  ]
  const sprite = plane(c5(1, 2, 3))
  it('an opaque l1High pixel draws over the sprite pixel under it', () => {
    expect(run({ sprites: sprite, l1High: plane(c5(9, 8, 7)) })).toEqual(rgba(c5(9, 8, 7)))
  })
  it('the same tile in the low plane draws behind the sprite', () => {
    expect(run({ sprites: sprite, l1Low: plane(c5(9, 8, 7)) })).toEqual(rgba(c5(1, 2, 3)))
  })
})

describe('effectiveCgadsub', () => {
  it('drops BG3 where CODE_009FB8 clears it, keeps it for the camera-locked byte', () => {
    expect(effectiveCgadsub(0x24, true)).toBe(0x20)
    expect(effectiveCgadsub(0x24, false)).toBe(0x24)
    expect(effectiveCgadsub(0xff, true)).toBe(0xfb)
  })
})
