/**
 * The footprint collector (#1237): every cell a stored piece wrote, overwritten ones included, recorded
 * only when a caller passes one. Synthetic cart, no ROM, runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { expandMapOwned, SWITCH_FLAGS_UNCLEARED } from '../../../src/rom/ObjectExpander'
import type { Footprint } from '../../../src/rom/objectHandlers/cursor'
import type { LevelObject } from '../../../src/rom/LevelParser'

const DISPATCHER = 0x0da500
const FILL = 0x0df066
const JMP = 0x4c

/** Tileset 0 routes standard object 2 to the rectangle fill, which writes tile $02. */
function cart(): RomFile {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
  rom.writeAt(0x0da41e, long(DISPATCHER))
  rom.writeAt(DISPATCHER + 10, [...long(FILL), ...long(FILL)])
  rom.writeAt(FILL + 1, [0x02])
  rom.writeAt(FILL + 2, [JMP, 0xce, 0xec])
  return rom
}

const rect = (x: number, y: number, settings: number): LevelObject =>
  ({ type: 'standard', screen: 0, x, y, objectNumber: 2, settings, newScreen: false, highCoord: false, raw: [0, 0, settings], objectType: 2, param: settings }) as LevelObject // prettier-ignore

const run = (objects: LevelObject[], footprint: Footprint | null) =>
  expandMapOwned(objects, 1, cart(), 0, false, undefined, undefined, SWITCH_FLAGS_UNCLEARED, null, footprint) // prettier-ignore

describe('the footprint collector', () => {
  const objects = [rect(3, 2, 0x12), rect(4, 3, 0x12)]

  it('records each piece cell, the cell a later piece covers included', () => {
    const fp: Footprint = []
    const { owners } = run(objects, fp)
    const of = (owner: number) => new Set(fp.filter(f => f.owner === owner).map(f => `${f.row},${f.col}`)) // prettier-ignore
    expect(of(0).size).toBeGreaterThan(0)
    expect(of(1).size).toBeGreaterThan(0)
    const shared = [...of(0)].filter(k => of(1).has(k))
    expect(shared.length).toBeGreaterThan(0)
    // The owner grid keeps only the last writer; the footprint still holds the first.
    for (const k of shared) {
      const [r, c] = k.split(',').map(Number)
      expect(owners[r!]![c!]).toBe(1)
    }
    // The last piece's entries carry the tile the grid shows.
    const { grid } = run(objects, null)
    for (const f of fp.filter(x => x.owner === 1)) expect(grid[f.row]![f.col]).toBe(f.tile)
  })

  it('draws the same grid and owners with or without a collector', () => {
    const plain = run(objects, null)
    const withFp = run(objects, [])
    expect(withFp.grid).toEqual(plain.grid)
    expect(withFp.owners).toEqual(plain.owners)
  })

  it('every cell an owner grid names has that owner in the footprint', () => {
    const fp: Footprint = []
    const { owners } = run(objects, fp)
    for (let r = 0; r < owners.length; r++)
      for (let c = 0; c < owners[r]!.length; c++) {
        const o = owners[r]![c]!
        if (o >= 0) expect(fp.some(f => f.owner === o && f.row === r && f.col === c)).toBe(true)
      }
  })
})
