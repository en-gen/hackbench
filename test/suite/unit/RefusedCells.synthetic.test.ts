/**
 * Refused Layer 1 objects as map cells (#816): each refusal is joined to the
 * parsed object it came from and lands on that object's anchor cell, with a
 * plain-words reason. Synthetic cart and objects, no ROM, runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { expandMapOwned, SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import { refusedCellsOf, WHY_UNPORTED } from '../../../src/rom/model/RefusedCells'
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

const GATE = /^Its drawing code /

describe('refusedCellsOf (#816)', () => {
  it('marks the anchor cell of an unported object, on screen 1, with the plain reason', () => {
    // Index 1 is the refused one, so an index shifted by one lands on the wrong object.
    const objects = [obj(2, 3, 4), obj(1, 19, 7), obj(2, 5, 6)]
    const rom = cart(UNPORTED)
    const { refusals } = expand(rom, objects, null)
    expect(refusals.map(r => r.objectIndex)).toEqual([1])
    expect(refusedCellsOf(refusals, objects)).toEqual([
      {
        x: 19,
        y: 7,
        objectIndex: 1,
        objectType: 'type 1',
        handler: UNPORTED,
        reasons: [WHY_UNPORTED],
      },
    ])
    expect(WHY_UNPORTED).toBe('HackBench cannot draw this object type yet.')
  })

  it('an empty dispatch entry is the same unported reason', () => {
    const objects = [obj(1, 2, 3)]
    const { refusals } = expand(cart(0), objects, null)
    expect(refusedCellsOf(refusals, objects)).toMatchObject([{ x: 2, y: 3, handler: 0, reasons: [WHY_UNPORTED] }]) // prettier-ignore
  })

  it('an extended object is named as extended and found by its own index', () => {
    const objects = [obj(2, 1, 1), obj(5, 7, 9, 'extended')]
    const rom = cart(FILL)
    rom.writeAt(ADDR_EXTENDED_DISPATCH + 5 * 3, [0xf0, 0xff, 0x0d])
    const { refusals } = expand(rom, objects, null)
    expect(refusedCellsOf(refusals, objects)).toEqual([
      { x: 7, y: 9, objectIndex: 1, objectType: 'extended type 5', handler: UNPORTED, reasons: [WHY_UNPORTED] }, // prettier-ignore
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
    expect(cells.map(c => [c.x, c.y, c.reasons.length])).toEqual([
      [3, 3, 1],
      [8, 2, 1],
    ])
    for (const c of cells) expect(c.reasons[0]).toMatch(GATE)
  })

  it('no refusals gives no cells, and a refusal with no such object is dropped, not guessed', () => {
    expect(refusedCellsOf([], [obj(1, 0, 0)])).toEqual([])
    expect(refusedCellsOf([{ objectIndex: 5, handler: 1, reason: 'x' }], [obj(1, 0, 0)])).toEqual([]) // prettier-ignore
  })
})

describe('one cell per object (#816)', () => {
  const sink = () => ({ unverified: [] as string[], primitives: [], draw: () => false })

  it('an object refused twice (vertical pipe, handle_0DB49E) is one cell carrying the gate reason', () => {
    const objects = [obj(1, 3, 4)]
    const { refusals } = expand(cart(0x0db49e), objects, sink())
    expect(refusals.length).toBe(2)
    const cells = refusedCellsOf(refusals, objects)
    expect(cells.map(c => c.objectIndex)).toEqual([0])
    expect(cells[0]!.reasons).toHaveLength(2)
    expect(cells[0]!.reasons.every(r => GATE.test(r))).toBe(true)
    expect(new Set(cells[0]!.reasons).size).toBe(2)
    expect(cells[0]!.reasons[0]).toContain('$0DB4B1')
    expect(cells[0]!.reasons[1]).toContain('$0DB4D2')
  })

  it('a bare gate line without a ROM still reads as the gate reason', () => {
    expect(refusedCellsOf([gate()], [obj(1, 3, 4)])[0]!.reasons[0]).toMatch(GATE)
  })

  it('an anchor off the strip keeps its own x,y, never clamped (#1004)', () => {
    // Negative and past-the-end on both axes: a clamp would turn each into 0 or the last row/column.
    const objects = [obj(1, -2, 5), obj(1, 90, 5), obj(1, 4, -3), obj(1, 4, 400), obj(1, -1, -1)]
    const rs = objects.map((_, i) => ({ objectIndex: i, handler: 1, reason: 'x' }))
    expect(refusedCellsOf(rs, objects).map(c => [c.x, c.y])).toEqual([
      [-2, 5],
      [90, 5],
      [4, -3],
      [4, 400],
      [-1, -1],
    ])
  })
})

// The count badge (#1005) is reasons.length, so each issue on an object must survive as its own line.
const unp = (n = 0) => ({ objectIndex: n, handler: 1, reason: 'no handler' })
const gate = (at = 0x0db4a0, found = 0x00, n = 0) => ({
  objectIndex: n,
  handler: 2,
  reason: formatRefusedLine(0x0db49e, at, 0x20, found),
})

describe('every distinct issue is kept (#1005)', () => {
  const o = [obj(1, 3, 4)]
  const reasonsOf = (rs: Parameters<typeof refusedCellsOf>[0]) => refusedCellsOf(rs, o)[0]!.reasons

  it('one issue gives one reason', () => {
    expect(reasonsOf([unp()])).toEqual([WHY_UNPORTED])
    expect(reasonsOf([gate()])).toHaveLength(1)
  })

  it('a gate and an unported issue give two, gate first whichever came first', () => {
    for (const rs of [
      [unp(), gate()],
      [gate(), unp()],
    ]) {
      const r = reasonsOf(rs)
      expect(r).toHaveLength(2)
      expect(r[0]).toMatch(GATE)
      expect(r[1]).toBe(WHY_UNPORTED)
    }
  })

  it('three or more are all kept, the two gate lines told apart by their detail, in refusal order', () => {
    const r = reasonsOf([unp(), gate(0x0db4a0, 0x00), gate(0x0db4b2, 0x1f)])
    expect(r).toHaveLength(3)
    expect(r[0]).toContain('$0DB4A0')
    expect(r[1]).toContain('$0DB4B2')
    expect(r[2]).toBe(WHY_UNPORTED)
    expect(new Set(r).size).toBe(3)
  })

  it('the handler comes from the first gate refusal, whichever refusal came first', () => {
    for (const rs of [
      [unp(), gate()],
      [gate(), unp()],
    ])
      expect(refusedCellsOf(rs, o)[0]!.handler).toBe(2)
    expect(refusedCellsOf([unp()], o)[0]!.handler).toBe(1)
  })

  it('identical refusals do not inflate the count', () => {
    expect(reasonsOf([unp(), unp(), gate(), gate(), unp()])).toHaveLength(2)
  })

  it('reasons are per object, not pooled across objects', () => {
    const two = [obj(1, 1, 1), obj(1, 2, 2)]
    const c = refusedCellsOf([gate(0x0db4a0, 0, 0), unp(0), unp(1)], two)
    expect(c.map(x => x.reasons.length)).toEqual([2, 1])
  })
})
