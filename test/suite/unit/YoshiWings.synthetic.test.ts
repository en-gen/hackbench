/**
 * YoshiWings (#1229) on a synthetic ROM: the spawn run finds the wings column by running the
 * dispatcher, not by assuming one, and the path gate and grid read refuse as they should.
 */
import { describe, it, expect } from 'vitest'
import {
  answersFor,
  layer1Grid,
  holdsWings,
  wingsColumns,
  WINGS_PATH,
  WINGS_TILE,
  type WingsSeams,
} from '../../../src/rom/YoshiWings'
import type { SmwRom } from '../../../src/rom/SmwRom'
import { RomFile } from '../../../src/rom/RomFile'
import { SYNTHETIC_VERTICAL_TABLE } from '../support/verticalTable'
import { buildSyntheticRom, SYNTHETIC_DISPATCHER } from '../support/syntheticSpriteRom'
import { pathDigestOf } from '../support/wingsTree'

// The synthetic spawn makes sprite 0 (content 3) and leaves C2 = 2 in one column; the real game's is $7E.
const seams = (rom: RomFile): WingsSeams => ({
  digests: [pathDigestOf(rom)],
  dispatcher: SYNTHETIC_DISPATCHER,
  sprite: 0,
  content: 3,
})
const columnsOf = (rom: RomFile, extra: Partial<WingsSeams> = {}): number[] | string => {
  const r = wingsColumns(rom, { ...seams(rom), ...extra })
  return 'columns' in r ? [...r.columns!].sort() : r.note
}

describe('wingsColumns runs the spawn once per column', () => {
  it.each([0, 1, 2, 3])('finds exactly column %i when the spawn leaves C2 = 2 there', c => {
    expect(columnsOf(buildSyntheticRom({ wingsColumn: c }))).toEqual([c])
  })

  it('finds none when the spawn never leaves C2 = 2', () => {
    expect(columnsOf(buildSyntheticRom())).toEqual([])
  })

  it('refuses, with the spawn reason, when the dispatcher is not a build it knows', () => {
    expect(columnsOf(buildSyntheticRom({ wingsColumn: 1, badSpawn: 'head' }))).toMatch(
      /spawn was refused: .*dispatcher is not a build/,
    )
  })

  it('refuses when the touch or animation code is not the recognized build', () => {
    const rom = buildSyntheticRom({ wingsColumn: 1 })
    const digests = [pathDigestOf(rom)]
    rom.writeAt(0x00c7fd, [0xea])
    expect(columnsOf(rom, { digests })).toMatch(/not stock/)
  })

  it('refuses when the number is not the wings sprite, even with C2 = 2', () => {
    const rom = buildSyntheticRom()
    expect(columnsOf(rom, { spawn: () => ({ number: 0x7d, c2: 2 }) })).toEqual([])
    expect(columnsOf(rom, { spawn: () => ({ number: 0, c2: 3 }) })).toEqual([])
  })
})

describe('holdsWings reads columns, not tiles alone', () => {
  const smw = { rom: buildSyntheticRom() } as unknown as SmwRom
  const holds = (x: number, id = WINGS_TILE, cols = new Set([1])) =>
    holdsWings(smw, 7, cols, {
      grid: () => [new Array<number>(x + 1).fill(0x25).map((v, i) => (i === x ? id : v))],
    })

  it.each(Array.from({ length: 24 }, (_, x) => x))('column %i', x => {
    expect(holds(x)).toBe(x % 4 === 1)
  })

  it('needs the tile: another item block in the wings column does not count', () => {
    expect(holds(5, 0x126)).toBe(false)
    expect(holds(5, 0x124)).toBe(false)
  })

  it('follows the set it is given', () => {
    expect(holds(6, WINGS_TILE, new Set([2]))).toBe(true)
    expect(holds(5, WINGS_TILE, new Set())).toBe(false)
  })

  it('reads a slot with no grid as holding none', () => {
    expect(holdsWings(smw, 8, new Set([1]), { grid: () => null })).toBe(false)
  })
})

describe('the path digest', () => {
  const edges = WINGS_PATH.flatMap(([a, n]) => [a, a + n - 1])
  const refuses = (rom: RomFile, digests: string[]) =>
    columnsOf(rom, { digests, spawn: () => ({ number: 0, c2: 1 }) })

  it.each(edges)('refuses a changed byte at the edge of a span ($%i)', at => {
    const rom = buildSyntheticRom()
    const digests = [pathDigestOf(rom)]
    expect(refuses(rom, digests)).toEqual([])
    rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
    expect(refuses(rom, digests)).toMatch(/not stock/)
  })

  // Reviewer's plants on the vanilla path, each a byte the earlier four spans missed: the animation
  // entry, its JSL operand, the call site, CODE_00D273, CODE_01F668 and the `AND #$30` of the rewrite.
  it.each([0x00c593, 0x00c596, 0x00c569, 0x00d273, 0x01f668, 0x0289ad])('a span covers $%i', at => {
    expect(WINGS_PATH.some(([a, n]) => at >= a && at < a + n)).toBe(true)
  })
})

describe('the answers are kept by the bytes, not by the object', () => {
  const copy = (r: RomFile, banks?: { objectCode: { bank: number } }) =>
    RomFile.fromBytes(r.filePath, Buffer.from(r.buffer), banks)

  it('one entry per distinct bytes: a copy shares it, a changed byte or other data banks do not', () => {
    const a = buildSyntheticRom()
    expect(answersFor(copy(a))).toBe(answersFor(a))
    const changed = copy(a)
    changed.writeAt(0x00c569, [0xea])
    expect(answersFor(changed)).not.toBe(answersFor(a))
    expect(answersFor(copy(a, { objectCode: { bank: 0x0d } }))).not.toBe(answersFor(a))
    expect(answersFor(copy(a, { objectCode: { bank: 0x0e } }))).not.toBe(
      answersFor(copy(a, { objectCode: { bank: 0x0d } })),
    )
  })

  it('an edit to one RomFile moves it to the entry for its new bytes', () => {
    const a = buildSyntheticRom()
    const before = answersFor(a)
    a.writeAt(0x00c569, [0xea])
    expect(answersFor(a)).not.toBe(before)
  })
})

describe('refusals on a synthetic ROM', () => {
  it('says so when the ROM block contents cannot be read (no content index given)', () => {
    const rom = buildSyntheticRom()
    expect(columnsOf(rom, { content: undefined })).toMatch(/block contents could not be read/)
  })
})

describe('layer1Grid is the map view grid, not a fixed shape', () => {
  // A slot with no objects: the header and the terminator. Header byte 0 low 5 bits are screens - 1, byte 1 low 5 bits the level mode.
  const level = (screens: number, mode: number) => Buffer.from([screens - 1, mode, 0, 0, 0, 0xff])
  const fake = (raw: Buffer, rom = buildSyntheticRom()) =>
    ({
      rom,
      getLevelRawData: () => raw,
      requireVerticalTable: () => SYNTHETIC_VERTICAL_TABLE,
    }) as unknown as SmwRom

  it('is screens * 16 wide and 27 tall for a horizontal mode, 32 wide and screens * 16 tall for a vertical one', () => {
    const h = layer1Grid(fake(level(3, 0)), 5)!
    expect([h[0]!.length, h.length]).toEqual([48, 27])
    const v = layer1Grid(fake(level(3, 1)), 5)! // SYNTHETIC_VERTICAL_TABLE[1] has the layer 1 vertical bit
    expect([v[0]!.length, v.length]).toEqual([32, 48])
  })

  it('reads the Layer 3 setting of the slot it was asked for, not slot 0', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x05f200 + 7, [0x40]) // slot 7 only: bits 7-6 nonzero add two overflow screens
    expect(layer1Grid(fake(level(3, 0), rom), 7)![0]!.length).toBe(48 + 32)
    expect(layer1Grid(fake(level(3, 0), rom), 6)![0]!.length).toBe(48)
  })

  it('has no grid for a slot with no data, and throws the reason when the vertical table is unreadable', () => {
    const none = { rom: buildSyntheticRom(), getLevelRawData: () => null } as unknown as SmwRom
    expect(layer1Grid(none, 1)).toBeNull()
    const noTable = {
      rom: buildSyntheticRom(),
      getLevelRawData: () => level(1, 0),
      requireVerticalTable: () => {
        throw new Error('no vertical table')
      },
    } as unknown as SmwRom
    expect(() => layer1Grid(noTable, 1)).toThrow('no vertical table')
  })
})
