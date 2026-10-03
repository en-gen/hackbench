/**
 * The Maps tree shows MAPS (slots sharing an L1 pointer), not slots (#434).
 * ROM-free: every byte is built here, so this runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapNode } from '../../../src/rom/MapTree'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

function blank(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  plantStockSubmapCode(rom)
  plantOverworldTiles(rom)
  return rom
}

/** Slots `slots` all point at one room at `ptr` whose primary exits carry `rawBytes`. */
function room(rom: RomFile, slots: number[], ptr: number, rawBytes: number[]): void {
  for (const s of slots) {
    rom.writeAt(ADDR.LEVEL_L1_PTR + s * 3, [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff])
  }
  const body = rawBytes.length ? rawBytes.flatMap(b => [0x00, 0x01, 0x00, b]) : [0x42] // a leaf needs one real object
  rom.writeAt(ptr, [0, 0, 0, 0, 0, ...body, 0xff])
}

const shape = (n: MapNode): unknown =>
  n.children.length ? [n.index, n.kind, n.children.map(shape)] : [n.index, n.kind]

describe('buildMapTree groups slots into maps', () => {
  it('collapses aliased slots and an A <-> B cycle to two map nodes', () => {
    const rom = blank()
    // A = $001 (entrance) + $0C0 + $0C1; B = $0C2 + $0C3. A exits to B and to its
    // own alias; B exits back to an A alias.
    room(rom, [0x001, 0x0c0, 0x0c1], 0x068000, [0xc2, 0xc1])
    room(rom, [0x0c2, 0x0c3], 0x069000, [0xc0])
    const tree = buildMapTree(new SmwRom(rom), SYNTHETIC_FINGERPRINTS)

    expect(tree.overworld.map(shape)).toEqual([[0x001, 'map', [[0x0c2, 'map', [[0x001, 'loop']]]]]])
    expect(tree.unassigned).toEqual([])
    expect(tree.mapCount).toBe(2)
  })

  it('unions the exits of a map whose slots sit on both sides of $100', () => {
    const rom = blank()
    room(rom, [0x001], 0x06a000, [0xc0]) // main-map entrance -> $0C0
    room(rom, [0x101], 0x06b000, [0xc0]) // submap entrance -> $1C0
    // One map, two slots. Its single exit byte resolves under each slot's own flag.
    room(rom, [0x0c0, 0x1c0], 0x068000, [0xd0])
    room(rom, [0x0d0], 0x069000, [])
    room(rom, [0x1d0], 0x069800, [])
    const tree = buildMapTree(new SmwRom(rom), SYNTHETIC_FINGERPRINTS)

    for (const top of tree.overworld) {
      expect(top.children.map(shape)).toEqual([
        [
          0x0c0,
          'map',
          [
            [0x0d0, 'map'],
            [0x1d0, 'map'],
          ],
        ],
      ])
    }
    expect(tree.overworld.map(n => n.index)).toEqual([0x001, 0x101])
    expect(tree.mapCount).toBe(5)
  })
})
