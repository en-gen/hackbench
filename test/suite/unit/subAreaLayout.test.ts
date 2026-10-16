/**
 * SPIKE (#946): the sub-area offset arithmetic and tile scan on built grids (no ROM),
 * and the chosen vanilla levels' layouts (describe.skipIf without the vanilla ROM).
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import {
  GAP_PX,
  buildSubAreaLayout,
  findEnterable,
  mapSizePx,
  placeSubAreas,
} from '../../../src/rom/subAreaLayout'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

const main = { w: 1024, h: 432 }
const sub = (
  kind: 'below' | 'above' | 'beside',
  ex: number,
  ey: number,
  lx: number,
  ly: number,
) => ({
  kind,
  exit: { x: ex, y: ey },
  landing: { x: lx, y: ly },
  w: 512,
  h: 432, // prettier-ignore
})

describe('placeSubAreas (synthetic)', () => {
  it('below: landing column under the exit column, one gap under the map', () => {
    expect(placeSubAreas(main, [sub('below', 400, 200, 100, 300)])).toEqual([
      { x: 300, y: 432 + GAP_PX, shifted: false },
    ])
  })
  it('above: sits one gap over the map by its own height', () => {
    expect(placeSubAreas(main, [sub('above', 400, 200, 100, 300)])).toEqual([
      { x: 300, y: -(432 + GAP_PX), shifted: false },
    ])
  })
  it('beside: landing row level with the exit row, one gap right of the map', () => {
    expect(placeSubAreas(main, [sub('beside', 400, 380, 24, 360)])).toEqual([
      { x: 1024 + GAP_PX, y: 20, shifted: false },
    ])
  })
  it('a second sub area on the same side is pushed out and flagged; the other side is not', () => {
    const r = placeSubAreas(main, [
      sub('below', 400, 200, 100, 300),
      sub('below', 400, 200, 100, 300),
      sub('above', 400, 200, 100, 300),
    ])
    expect(r.map(s => s.shifted)).toEqual([false, true, false])
    expect(r[1]).toEqual({ x: 300, y: 432 + GAP_PX + 432 + GAP_PX, shifted: true })
  })
  it('sizes: horizontal screens are 256 x 432 side by side, vertical ones 512 x 256 stacked', () => {
    expect(mapSizePx(false, 3)).toEqual({ w: 768, h: 432 })
    expect(mapSizePx(true, 3)).toEqual({ w: 512, h: 768 })
  })
})

describe('findEnterable (synthetic grid)', () => {
  const grid = (cells: Array<[number, number, number]>) => {
    const g = Array.from({ length: 27 }, () => new Array<number>(64).fill(0))
    for (const [x, y, t] of cells) g[y]![x] = t
    return g
  }
  it('a cap over a body is a down pipe: below, centred on the two-tile cap', () => {
    const f = findEnterable(
      grid([
        [20, 10, 0x137],
        [21, 10, 0x138],
        [20, 11, 0x135],
      ]),
      false,
      1,
    )
    expect(f).toMatchObject({ kind: 'below', at: { x: 20 * 16 + 16, y: 160 }, count: 1 })
  })
  it('a cap under a body is an up pipe: above', () => {
    expect(
      findEnterable(
        grid([
          [20, 10, 0x137],
          [20, 9, 0x135],
        ]),
        false,
        1,
      )?.kind,
    ).toBe('above')
  })
  it('a door and a side pipe are beside; two on one screen count 2', () => {
    const f = findEnterable(
      grid([
        [17, 5, 0x20],
        [30, 6, 0x13f],
      ]),
      false,
      1,
    )
    expect(f).toMatchObject({ kind: 'beside', count: 2, at: { x: 17 * 16 + 8, y: 96 } })
  })
  it('only the asked screen is scanned, and an empty screen finds nothing', () => {
    expect(findEnterable(grid([[17, 5, 0x20]]), false, 0)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('buildSubAreaLayout on the vanilla ROM', () => {
  let rom: SmwRom
  beforeAll(() => {
    rom = new SmwRom(freshRom(VANILLA))
  })
  const layout = (slot: number) => {
    const r = buildSubAreaLayout(rom, slot)
    if (!r.ok) throw new Error(r.reason)
    return r
  }
  const at = (slot: number, dest: number) => layout(slot).subAreas.find(s => s.slot === dest)!

  it('$00B: the pipe on screen 7 leads down to $0E1, landing column under the pipe', () => {
    expect(at(0x0b, 0xe1)).toMatchObject({ kind: 'below', basis: 'tile', fromScreen: 7, offsetX: 1864, offsetY: 464, exitPx: { x: 2000, y: 288 }, landingPx: { x: 136, y: 320 } }) // prettier-ignore
    const s = at(0x0b, 0xe1)
    expect(s.exitPx.x - s.landingPx.x).toBe(s.offsetX)
  })
  it('$00B: the second exit of the same pipe is pushed past the first and says so', () => {
    expect(at(0x0b, 0xe0).offsetY).toBe(464 + 432 + GAP_PX)
    expect(at(0x0b, 0xe0).notes.join()).toMatch(/Overlapped/)
  })
  it('$0BE: the up pipe on screen 3 puts $0D0 above the map', () => {
    expect(at(0xbe, 0xd0)).toMatchObject({ kind: 'above', basis: 'tile', offsetY: -(432 + GAP_PX), offsetX: -3256 }) // prettier-ignore
  })
  it('$107: the door on screen $0A puts $1EA beside the map, landing row level with the door', () => {
    expect(at(0x107, 0x1ea)).toMatchObject({ kind: 'beside', basis: 'tile', fromScreen: 0xa, offsetX: 2816 + GAP_PX, offsetY: 16 }) // prettier-ignore
    expect(at(0x107, 0x1ea).notes.join()).toMatch(/Also entered from \$1FB/)
  })
  it('$022: screen 0x13 has no pipe tile, so its three sub areas are placed by guess, and labelled', () => {
    const r = layout(0x22)
    expect(r.subAreas.length).toBe(3)
    for (const s of r.subAreas) expect(s.basis).toBe('heuristic')
  })
})
