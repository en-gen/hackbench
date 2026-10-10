/**
 * The expander's refusal channel (#301): an object that draws nothing says so,
 * with its index, handler and reason. Synthetic cart, no ROM, runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { expandMapOwned, SWITCH_FLAGS_UNCLEARED, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import { foldRefusals } from '../../../src/rom/model/L1Model'
import { refusalsReason } from '../../../tools/scripts/capture_gate'

const DISPATCHER = 0x0da500
const UNPORTED = 0x0dfff0
const FILL = 0x0df066
const JMP = 0x4c

/** Tileset 0's dispatcher routes standard object 1 to `handler`, object 2 to the fill handler. */
function cart(handler: number): RomFile {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
  rom.writeAt(0x0da41e, long(DISPATCHER))
  rom.writeAt(DISPATCHER + 10, [...long(handler), ...long(FILL)])
  return rom
}

const obj = (n: number, x: number, settings = 0x11): LevelObject =>
  ({
    type: 'standard',
    screen: 0,
    x,
    y: 2,
    objectNumber: n,
    settings,
    newScreen: false,
    highCoord: false,
    raw: [0, 0, settings],
    objectType: n,
    param: settings,
  }) as LevelObject

const run = (rom: RomFile, objects: LevelObject[], sink: Parameters<typeof expandMapOwned>[8]) =>
  expandMapOwned(objects, 1, rom, 0, false, undefined, undefined, SWITCH_FLAGS_UNCLEARED, sink)

describe('expandMapOwned refusals (#301)', () => {
  it('an object whose handler has no port is refused, not silently blank', () => {
    const r = run(cart(UNPORTED), [obj(1, 3)], null)
    expect(r.refusals).toEqual([
      { objectIndex: 0, handler: UNPORTED, reason: expect.stringContaining('$0DFFF0') },
    ])
    expect(r.refusals[0].reason).toMatch(/^No port for the handler/)
    // Best effort: the grid is still the full-size empty grid, not absent.
    expect(r.grid.length).toBe(27)
    expect(r.grid.flat().every(t => t === TILE_EMPTY)).toBe(true)
  })

  it('a ported object beside it draws, and only the unported one is refused', () => {
    const rom = cart(UNPORTED)
    rom.writeAt(FILL + 1, [0x02])
    rom.writeAt(FILL + 2, [JMP, 0xce, 0xec]) // JMP $0DECCE, the rect core
    const r = run(rom, [obj(2, 6), obj(1, 3), obj(1, 9)], null)
    expect(r.refusals.map(x => x.objectIndex)).toEqual([1, 2])
  })

  it('a refusal a handler records through the sink is attributed to its own object, every time', () => {
    const rom = cart(FILL)
    const sink = { unverified: [] as string[], primitives: [], draw: () => false }
    // $0DF066 reads through a JMP at +2 that this zeroed cart does not hold.
    const r = run(rom, [obj(1, 3), obj(1, 8)], sink)
    expect(r.refusals.map(x => [x.objectIndex, x.handler])).toEqual([
      [0, FILL],
      [1, FILL],
    ])
    expect(r.refusals[0].reason).toMatch(/^Handler \$0DF066 refused/)
    // One line in the shared note list, though two objects were refused.
    expect(sink.unverified.filter(l => l.includes('refused'))).toHaveLength(1)
  })

  it('findings that are not refusals (the stock-path notes) do not become refusals', () => {
    const sink = { unverified: [] as string[], primitives: [], draw: () => false }
    const r = run(cart(UNPORTED), [], sink)
    expect(r.refusals).toEqual([])
  })

  it('foldRefusals names the object and does not repeat a reason already in the list', () => {
    const unverified = ['Handler $0DB571 refused: x.']
    foldRefusals(unverified, [
      { objectIndex: 4, handler: 0x0db571, reason: 'Handler $0DB571 refused: x.' },
      { objectIndex: 5, handler: 0x0dfff0, reason: 'No port for the handler at $0DFFF0.' },
    ])
    expect(unverified).toEqual([
      'Handler $0DB571 refused: x.',
      'Object 5: No port for the handler at $0DFFF0.',
    ])
  })

  it('the capture gate calls a map with a refusal unavailable, and one without ok', () => {
    expect(refusalsReason([])).toBeUndefined()
    const why = refusalsReason([{ objectIndex: 7, handler: 0x0dfff0, reason: 'No port.' }])
    expect(why).toContain('#7')
    expect(why).toContain('No port.')
  })
})
