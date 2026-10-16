/**
 * Which entrance a map's initial camera is read from (#860). The game uses the primary entrance
 * (DATA_05F000.. by map) when the overworld or a primary-entrance screen exit enters the map, and a
 * secondary entrance's row (DATA_05FA00 by entrance index) only when UseSecondaryExit is set
 * (bank_05.asm:7111-7162 vs 7300-7337). Synthetic ROM, hand-written expected values; no corpus.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { chooseEntrance, readInitialLayer1YPos } from '../../../src/rom/L3Loader'
import { readInitialLayer2YPos } from '../../../src/rom/L2Loader'
import type { MapEntrances } from '../../../src/rom/SmwRom'

const D708 = 0x05d708 // L1 Y by index, hand-written below
const D70C = 0x05d70c // L2 Y by index
const L1_Y = [0x10, 0x60, 0xc0, 0x30]
const L2_Y = [0x08, 0x28, 0x48, 0x68]

function rom(size = 0x400000): RomFile {
  const r = new RomFile('mock.smc', Buffer.alloc(size, 0))
  r.writeAt(D708, L1_Y)
  r.writeAt(D70C, L2_Y)
  return r
}
const via = (o: Partial<MapEntrances>): MapEntrances => ({ overworld: false, primary: false, secondary: [], ...o }) // prettier-ignore
/** FA00 byte: L1 index in bits 5:4, L2 index in bits 7:6. */
const fa = (l1: number, l2: number) => (l2 << 6) | (l1 << 4)

describe('chooseEntrance', () => {
  const cases: [string, MapEntrances | undefined, number | null][] = [
    ['unavailable graph: fail closed to the primary entrance', undefined, null],
    ['overworld alone', via({ overworld: true }), null],
    ['overworld wins over a secondary', via({ overworld: true, secondary: [0x1c3] }), null],
    [
      'a primary-entrance exit wins over a secondary',
      via({ primary: true, secondary: [0x105] }),
      null,
    ],
    ['overworld and exit and secondary', via({ overworld: true, primary: true, secondary: [0x10] }), null], // prettier-ignore
    ['secondary only: the lowest index', via({ secondary: [0x1be, 0x1c3] }), 0x1be],
    ['secondary only, unsorted: still the lowest', via({ secondary: [0x1c3, 0x1be] }), 0x1be],
    ['secondary only, single', via({ secondary: [0x000] }), 0x000],
    ['entered by nothing (filler such as $100): primary', via({}), null],
  ]
  for (const [name, v, want] of cases) it(name, () => expect(chooseEntrance(v)).toBe(want))
})

describe('the initial camera follows the chosen entrance', () => {
  const MAP = 0x105
  function world(): RomFile {
    const r = rom()
    r.writeAt(0x05f400 + MAP, [(2 << 2) | 1]) // primary: L1 index 2, L2 index 1
    r.writeAt(0x05f800 + 0x1c3, [0x05]) // a secondary that targets $105 (bit 8 of the index is the flag)
    r.writeAt(0x05fa00 + 0x1c3, [fa(1, 3)]) // its own L1 index 1, L2 index 3
    r.writeAt(0x05fa00 + 0x1be, [fa(3, 0)])
    return r
  }
  const both = (r: RomFile, v: MapEntrances | undefined) => [
    readInitialLayer1YPos(r, MAP, false, v),
    readInitialLayer2YPos(r, MAP, false, v),
  ]
  const MAIN = [L1_Y[2], L2_Y[1]]

  it('an overworld-entered map with a secondary also aimed at it draws from the primary entrance', () => {
    expect(both(world(), via({ overworld: true, secondary: [0x1c3] }))).toEqual(MAIN)
  })
  it('a map a primary-entrance exit enters draws from the primary entrance', () => {
    expect(both(world(), via({ primary: true, secondary: [0x1c3] }))).toEqual(MAIN)
  })
  it('a secondary-only map draws from its lowest secondary entrance', () => {
    expect(both(world(), via({ secondary: [0x1be, 0x1c3] }))).toEqual([L1_Y[3], L2_Y[0]])
    expect(both(world(), via({ secondary: [0x1c3] }))).toEqual([L1_Y[1], L2_Y[3]])
  })
  it('an unreachable map, and an unavailable exit graph, draw from the primary entrance', () => {
    expect(both(world(), via({}))).toEqual(MAIN)
    // The F800 table still names $1C3 for $105; the stock formula must not be applied without the graph.
    expect(both(world(), undefined)).toEqual(MAIN)
  })
  it('a secondary row cut off by the end of the ROM is not read as zero: primary entrance', () => {
    // FA00 + $1FF is past the end; a phantom byte 0 would pick L1_Y[0] / L2_Y[0].
    // FA00 + $1FF is file offset $2FBFF; $2FC00 holds it (the control).
    const control = rom(0x2fc00)
    control.writeAt(0x05fa00 + 0x1ff, [fa(1, 1)])
    expect(both(control, via({ secondary: [0x1ff] }))).toEqual([L1_Y[1], L2_Y[1]])
    for (const size of [0x2f800, 0x2f900, 0x2f9ff, 0x2fbff]) {
      const r = rom(size)
      r.writeAt(0x05f400 + MAP, [(2 << 2) | 1])
      const got = both(r, via({ secondary: [0x1ff] }))
      expect(got, `size ${size.toString(16)}`).toEqual(MAIN)
    }
  })
  it('reads FA00 for every entrance index 0..$1FF, whatever DATA_05FC00 holds', () => {
    for (let e = 0; e < 0x200; e++) {
      const r = rom()
      r.writeAt(0x05f400 + MAP, [0x00])
      r.writeAt(0x05fa00 + e, [fa(e & 3, (e >> 2) & 3)])
      r.writeAt(0x05fc00 + e, [e & 0xff]) // screen and X index: never the target or the camera
      const v = via({ secondary: [e] })
      expect(readInitialLayer1YPos(r, MAP, false, v), `e=${e}`).toBe(L1_Y[e & 3])
      expect(readInitialLayer2YPos(r, MAP, false, v), `e=${e}`).toBe(L2_Y[(e >> 2) & 3])
    }
  })
})
