/**
 * #894: the castle flames on the map view compose over Layer 2 and under Layer 1, follow the
 * sprite toggle, and take no part in the sprite hover/door logic. Synthetic pixels, no ROM.
 */
import { describe, expect, it } from 'vitest'
import { composeScreen, type SourceKey } from '../../../src/rom/model/ColorMath'
import {
  compositeSpriteScreen,
  flamePlanes,
  spriteDoors,
  spritePlanes,
  withFlameKeys,
} from '../../../theia/extension/src/browser/map-view-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

const G = { orientation: 'horizontal' as const, width: 4, height: 1 }
/** A 4 x 1 screen: flame green on pixels 1-2, drawn from a 2 px wide DTO at x 1. */
const dto = (fixedTo?: 'layer2'): MapSpriteDto => ({
  index: fixedTo ? -1 : 0,
  id: 0xe6,
  x: 1,
  y: 0,
  box: { x0: 1, y0: 0, x1: 3, y1: 1 },
  rgba: Buffer.from([0, 255, 0, 255, 0, 255, 0, 255]).toString('base64'),
  priority: Buffer.from([0, 0]).toString('base64'),
  status: 'drawn',
  ...(fixedTo ? { fixedTo } : {}),
})
const px = (c: [number, number, number, number][]) => new Uint8ClampedArray(c.flat())
const RED: [number, number, number, number] = [255, 0, 0, 255]
const BLUE: [number, number, number, number] = [0, 0, 255, 255]
const NONE: [number, number, number, number] = [0, 0, 0, 0]

describe('Layer 2 flame planes', () => {
  it('a flame pixel joins the plane of the Layer 2 pixel it covers (high where l2High is opaque)', () => {
    const l2High = px([NONE, NONE, RED, NONE])
    const p = flamePlanes({ ...G, sprites: [dto('layer2')] }, 0, l2High)
    expect([...p.spritesL2Low!]).toEqual([0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0])
    expect([...p.spritesL2High!]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 0, 0, 0, 0])
    expect(flamePlanes({ ...G, sprites: [dto('layer2')] }, 0, null).spritesL2High).toBeNull()
    expect(flamePlanes({ ...G, sprites: [dto()] }, 0, null)).toEqual({ spritesL2Low: null, spritesL2High: null }) // prettier-ignore
  })

  it('the ordinary sprite planes, canvas and doors leave them out', () => {
    const sp = { ...G, sprites: [dto('layer2')] }
    expect(spritePlanes(sp, 0)).toEqual({ sprites0: null, sprites1: null, sprites2: null, sprites3: null }) // prettier-ignore
    expect(compositeSpriteScreen(sp.sprites, 0, G)).toBeNull()
    expect(spriteDoors(sp, 0)).toBeNull()
  })

  it('withFlameKeys puts each flame plane right above its Layer 2 plane, only where sprites are listed', () => {
    const lists = { main: ['l2Low', 'l1Low', 'l2High', 'sprites2', 'l1High'] as SourceKey[], sub: ['l2Low', 'l1Low'] as SourceKey[] } // prettier-ignore
    expect(withFlameKeys(lists)).toEqual({
      main: ['l2Low', 'spritesL2Low', 'l1Low', 'l2High', 'spritesL2High', 'sprites2', 'l1High'],
      sub: ['l2Low', 'l1Low'],
    })
  })

  it('composed: over Layer 2, under Layer 1 (both of its priorities), gone when the planes are left out', () => {
    const l2Low = px([RED, RED, NONE, NONE])
    const l2High = px([NONE, NONE, RED, NONE])
    const l1Low = px([NONE, BLUE, NONE, NONE])
    const l1High = px([NONE, NONE, BLUE, NONE])
    const flames = flamePlanes({ ...G, sprites: [dto('layer2')] }, 0, l2High)
    const lists = withFlameKeys({ main: ['l2Low', 'l1Low', 'l2High', 'sprites2', 'l1High'] as SourceKey[], sub: [] }) // prettier-ignore
    const base = { width: 4, height: 1, lists, math: null }
    const out = (planes: Parameters<typeof composeScreen>[0]['planes']) => [...composeScreen({ ...base, planes })] // prettier-ignore
    const shown = out({ l2Low, l2High, l1Low, l1High, ...flames })
    const at = (x: number) => shown.slice(x * 4, x * 4 + 4)
    expect(at(0)).toEqual(RED) // Layer 2 alone
    expect(at(1)).toEqual(BLUE) // flame over l2Low, but l1Low is over the flame
    expect(at(2)).toEqual(BLUE) // flame over l2High, l1High over the flame
    const gone = out({ l2Low, l2High, l1Low, l1High })
    expect(gone.slice(4, 8)).toEqual(BLUE)
    // Without Layer 1 on pixels 1-2 the flame itself shows, over the red.
    const open = out({ l2Low, l2High, ...flames })
    expect(open.slice(4, 12)).toEqual([0, 255, 0, 255, 0, 255, 0, 255])
    expect(out({ l2Low, l2High }).slice(4, 8)).toEqual(RED)
  })

  // The seven castle maps ($01F $101 $10D $1CD $1D0 $1D4 $1FC), as their screen lists read: OBJ on the main screen, Layer 2 on the
  // sub screen only, CGADSUB 32 (math on the backdrop). Synthetic lists, no ROM.
  const CASTLE_MAIN = ['l3Low', 'sprites0', 'l3High', 'sprites1', 'l1Low', 'sprites2', 'l1High', 'sprites3'] as SourceKey[] // prettier-ignore
  const CASTLE_SUB = ['l2Low', 'l2High'] as SourceKey[]

  it('a split list (OBJ on main, Layer 2 on sub) lists the flame planes on main, under Layer 1', () => {
    const got = withFlameKeys({ main: CASTLE_MAIN, sub: CASTLE_SUB })
    expect(got.main).toEqual(['l3Low', 'sprites0', 'l3High', 'sprites1', 'spritesL2Low', 'spritesL2High', 'l1Low', 'sprites2', 'l1High', 'sprites3']) // prettier-ignore
    expect(got.sub).toEqual(CASTLE_SUB)
  })

  it('composed on the castle shape: over the sub screen Layer 2, under Layer 1 (both priorities)', () => {
    const l2Low = px([RED, RED, RED, NONE])
    const l1Low = px([NONE, BLUE, NONE, NONE])
    const l1High = px([NONE, NONE, NONE, BLUE])
    const flames = flamePlanes({ ...G, sprites: [dto('layer2')] }, 0, null)
    const lists = withFlameKeys({ main: CASTLE_MAIN, sub: CASTLE_SUB })
    const math = { cgadsub: 32, fixed: [0, 0, 0] as [number, number, number] }
    const out = (planes: Parameters<typeof composeScreen>[0]['planes']) => [...composeScreen({ width: 4, height: 1, lists, math, planes })] // prettier-ignore
    const shown = out({ l2Low, l1Low, l1High, ...flames })
    const at = (x: number) => shown.slice(x * 4, x * 4 + 4)
    expect(at(0)).toEqual(RED) // Layer 2 through the backdrop's math
    expect(at(1)).toEqual(BLUE) // flame over Layer 2, Layer 1 low over the flame
    expect(at(2)).toEqual([0, 255, 0, 255]) // flame pixel with no Layer 1: the flame, not Layer 2
    expect(out({ l2Low, l1Low, l1High }).slice(8, 12)).toEqual(RED) // without the planes: Layer 2
    // dto() covers pixels 1-2 only; pixel 3 has no flame and Layer 1 high
    expect(at(3)).toEqual(BLUE)
  })
})

describe('a placed sprite under a tile with a flame between (hover door)', () => {
  // OBJ.1 sits below the flame planes on the castle shape, Layer 1 low over both: the tile hides the
  // sprite, and the flame is not the sprite it hides. Pixel 0: sprite blue, flame red, tile gray.
  const GRAY: [number, number, number, number] = [200, 200, 200, 255]
  const run = (lift: number, flame = true) => {
    const lists = withFlameKeys({ main: ['sprites1', 'l1Low'] as SourceKey[], sub: ['l2Low'] as SourceKey[] }) // prettier-ignore
    const planes = {
      sprites1: px([BLUE]),
      spritesL2Low: flame ? px([RED]) : null,
      l1Low: px([GRAY]),
    }
    const doors = new Uint32Array([(1 << 1) | 0])
    return [...composeScreen({ width: 1, height: 1, planes, lists, math: null, doors, lift })]
  }
  it('lists the flame between the sprite and Layer 1', () => {
    expect(withFlameKeys({ main: ['sprites1', 'l1Low'] as SourceKey[], sub: ['l2Low'] as SourceKey[] }).main).toEqual(['sprites1', 'spritesL2Low', 'spritesL2High', 'l1Low']) // prettier-ignore
  })
  it('hovered, the sprite itself shows through the tile, not the flame colour', () => {
    expect(run(1)).toEqual(BLUE)
  })
  it('not hovered, the pixel is what it is without the flame plane at all (the flame is not the covered sprite)', () => {
    expect(run(0)).toEqual(run(0, false))
  })
})
