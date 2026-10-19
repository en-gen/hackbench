/**
 * Refused Layer 1 objects as map cells (#816): each refusal is joined to the
 * parsed object it came from and lands on that object's anchor cell, with a
 * plain-words reason. Synthetic cart and objects, no ROM, runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { expandMapOwned, SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import {
  refusedBounds,
  refusedCellsOf as cellsOf,
  WHY_UNPORTED,
  WHY_GATE,
} from '../../../src/rom/model/RefusedCells'
import { formatRefusedLine } from '../../../src/rom/objectHandlers/interpretedGate'
import { ADDR_EXTENDED_DISPATCH } from '../../../src/rom/objectHandlers/romData'

const DISPATCHER = 0x0da500
const UNPORTED = 0x0dfff0
const FILL = 0x0df066

function cart(handler: number): RomFile {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
  rom.writeAt(0x0da41e, long(DISPATCHER))
  rom.writeAt(DISPATCHER + 10, [...long(handler), ...long(FILL)])
  return rom
}

const obj = (n: number, x: number, y: number, type: 'standard' | 'extended' = 'standard') =>
  ({
    type,
    screen: x >> 4,
    x,
    y,
    objectNumber: n,
    settings: 0x11,
    newScreen: false,
    highCoord: false,
    raw: [0, 0, 0x11],
    objectType: n,
    param: 0x11,
  }) as LevelObject

const expand = (
  rom: RomFile,
  objects: LevelObject[],
  sink: Parameters<typeof expandMapOwned>[8],
  vertical = false,
) =>
  // prettier-ignore
  expandMapOwned(objects, 2, rom, 0, vertical, undefined, undefined, SWITCH_FLAGS_UNCLEARED, sink)

const BIG = { cols: 999, rows: 999, gutter: 0 }
/** `cellsOf` with bounds too wide to clamp anything: the tests that are not about placement. */
const refusedCellsOf = (r: Parameters<typeof cellsOf>[0], o: LevelObject[]) => cellsOf(r, o, BIG)

describe('refusedCellsOf (#816)', () => {
  it('marks the anchor cell of an unported object, on screen 1, with the plain reason', () => {
    // Index 1 is the refused one, so an index shifted by one lands on the wrong object.
    const objects = [obj(2, 3, 4), obj(1, 19, 7), obj(2, 5, 6)]
    const rom = cart(UNPORTED)
    const { refusals } = expand(rom, objects, null)
    expect(refusals.map(r => r.objectIndex)).toEqual([1])
    expect(refusedCellsOf(refusals, objects)).toEqual([
      { x: 19, y: 7, objectIndex: 1, objectType: 'type 1', handler: UNPORTED, why: WHY_UNPORTED },
    ])
    expect(WHY_UNPORTED).toBe('HackBench cannot draw this object type yet.')
  })

  it('an empty dispatch entry is the same unported reason', () => {
    const objects = [obj(1, 2, 3)]
    const { refusals } = expand(cart(0), objects, null)
    expect(refusedCellsOf(refusals, objects)).toMatchObject([{ x: 2, y: 3, handler: 0, why: WHY_UNPORTED }]) // prettier-ignore
  })

  it('an extended object is named as extended and found by its own index', () => {
    const objects = [obj(2, 1, 1), obj(5, 7, 9, 'extended')]
    const rom = cart(FILL)
    rom.writeAt(ADDR_EXTENDED_DISPATCH + 5 * 3, [0xf0, 0xff, 0x0d])
    const { refusals } = expand(rom, objects, null)
    expect(refusedCellsOf(refusals, objects)).toEqual([
      { x: 7, y: 9, objectIndex: 1, objectType: 'extended type 5', handler: UNPORTED, why: WHY_UNPORTED }, // prettier-ignore
    ])
  })

  it('a vertical level keeps the parser row, which already counts the screens above', () => {
    const objects = [obj(1, 20, 21)]
    const { refusals } = expand(cart(UNPORTED), objects, null, true)
    expect(refusedCellsOf(refusals, objects)).toMatchObject([{ x: 20, y: 21 }])
  })

  it('an opcode-gate refusal gets the unreadable-code reason', () => {
    const objects = [obj(1, 3, 3), obj(1, 8, 2)]
    const sink = { unverified: [] as string[], primitives: [], draw: () => false }
    const { refusals } = expand(cart(FILL), objects, sink)
    const cells = refusedCellsOf(refusals, objects)
    expect(cells.map(c => [c.x, c.y, c.why])).toEqual([
      [3, 3, WHY_GATE],
      [8, 2, WHY_GATE],
    ])
    expect(WHY_GATE).toBe(
      "This object's drawing code could not be read safely, so it was not drawn.",
    )
  })

  it('no refusals gives no cells, and a refusal with no such object is dropped, not guessed', () => {
    expect(refusedCellsOf([], [obj(1, 0, 0)])).toEqual([])
    expect(refusedCellsOf([{ objectIndex: 5, handler: 1, reason: 'x' }], [obj(1, 0, 0)])).toEqual([]) // prettier-ignore
  })
})

describe('one cell per object (#816)', () => {
  const sink = () => ({ unverified: [] as string[], primitives: [], draw: () => false })

  it('an object refused twice (vertical pipe, handle_0DB49E) is one cell, with the gate reason', () => {
    const objects = [obj(1, 3, 4)]
    const { refusals } = expand(cart(0x0db49e), objects, sink())
    expect(refusals.length).toBe(2)
    const cells = refusedCellsOf(refusals, objects)
    expect(cells.map(c => c.objectIndex)).toEqual([0])
    expect(cells[0]!.why).toBe(WHY_GATE)
  })

  it('a gate refusal replaces an earlier unported one for the same object, and the order is irrelevant', () => {
    const o = [obj(1, 3, 4)]
    const unp = { objectIndex: 0, handler: 1, reason: 'no handler' }
    const gate = {
      objectIndex: 0,
      handler: 2,
      reason: formatRefusedLine(0x0db49e, 0x0db4a0, 0x20, 0x00),
    }
    for (const rs of [
      [unp, gate],
      [gate, unp],
    ]) {
      const c = refusedCellsOf(rs, o)
      expect(c).toHaveLength(1)
      expect(c[0]!.why).toBe(WHY_GATE)
    }
  })

  const place = (objects: LevelObject[], vertical: boolean) =>
    cellsOf(
      objects.map((_, i) => ({ objectIndex: i, handler: 1, reason: 'x' })),
      objects,
      refusedBounds(vertical, 3),
    ).map(c => [c.x, c.y])

  it('bounds follow the orientation and the screen count, with the gutter on horizontal maps only', () => {
    expect(refusedBounds(false, 3)).toEqual({ cols: 48, rows: 27, gutter: 8 })
    expect(refusedBounds(true, 3)).toEqual({ cols: 32, rows: 48, gutter: 0 })
  })

  it('a horizontal map keeps an anchor in its gutter at the data position (D48 part 2, #1004)', () => {
    // Eight tiles each side of 48 columns: -8 and 55 are the outermost gutter tiles.
    expect(place([obj(1, -8, 5), obj(1, -1, 5), obj(1, 48, 5), obj(1, 55, 5)], false)).toEqual([
      [-8, 5],
      [-1, 5],
      [48, 5],
      [55, 5],
    ])
  })

  it('beyond the gutter, or above or below a horizontal map, the anchor is pulled onto the map edge', () => {
    expect(
      place([obj(1, -9, 5), obj(1, 56, 5), obj(1, 3, -1), obj(1, 3, 27), obj(1, -40, 99)], false),
    ).toEqual([
      // prettier-ignore
      [0, 5],
      [47, 5],
      [3, 0],
      [3, 26],
      [0, 26],
    ])
  })

  it('a vertical map has no gutter: any anchor off the strip is pulled onto it', () => {
    expect(
      place([obj(1, -1, 5), obj(1, 32, 5), obj(1, 3, -2), obj(1, 3, 48), obj(1, 20, 9)], true),
    ).toEqual([
      // prettier-ignore
      [0, 5],
      [31, 5],
      [3, 0],
      [3, 47],
      [20, 9],
    ])
  })
})
