/**
 * YoshiWings (#1229) on a synthetic ROM: the spawn run finds the wings column by running the
 * dispatcher, not by assuming one, and the path gate and grid read refuse as they should.
 */
import { describe, it, expect } from 'vitest'
import { holdsWings, wingsColumns, WINGS_TILE, type WingsSeams } from '../../../src/rom/YoshiWings'
import type { SmwRom } from '../../../src/rom/SmwRom'
import { buildSyntheticRom, SYNTHETIC_DISPATCHER } from '../support/syntheticSpriteRom'
import { pathDigestOf } from '../support/wingsTree'
import type { RomFile } from '../../../src/rom/RomFile'

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
