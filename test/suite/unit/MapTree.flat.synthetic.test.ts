/** A root lists its sub areas flat, each once (#434). ROM-free: every byte is built here. */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
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

/** Slot `slot` with its own room at `ptr`, primary exits to the given low bytes. */
function room(rom: RomFile, slot: number, ptr: number, exits: number[]): void {
  rom.writeAt(ADDR.LEVEL_L1_PTR + slot * 3, [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff])
  const body = exits.length ? exits.flatMap(b => [0x00, 0x01, 0x00, b]) : [0x42]
  rom.writeAt(ptr, [0, 0, 0, 0, 0, ...body, 0xff])
}

const treeOf = (rom: RomFile) => buildMapTree(new SmwRom(rom), SYNTHETIC_FINGERPRINTS)
const kids = (tree: ReturnType<typeof treeOf>, root: number) =>
  tree.overworld.find(n => n.index === root)!.children

describe("buildMapTree lists a root's sub areas flat", () => {
  it('lists each slot of an A <-> B cycle plus a diamond once, with no nesting', () => {
    const rom = blank()
    room(rom, 0x001, 0x068000, [0xc0])
    room(rom, 0x0c0, 0x069000, [0xc1, 0xc2]) // diamond top; also A
    room(rom, 0x0c1, 0x06a000, [0xc3, 0xc0]) // back edge to the top
    room(rom, 0x0c2, 0x06b000, [0xc3])
    room(rom, 0x0c3, 0x06c000, [0xc1]) // tail rejoins B: a cycle
    room(rom, 0x0d0, 0x06d000, []) // reached by nothing
    const tree = treeOf(rom)
    const children = kids(tree, 0x001)

    expect(children.map(c => c.index)).toEqual([0x0c0, 0x0c1, 0x0c2, 0x0c3])
    expect(children.every(c => c.children.length === 0 && c.kind === 'map')).toBe(true)
    // Placed under the root, so not also unassigned; only the orphan is.
    expect(tree.unassigned.map(n => n.index)).toEqual([0x0d0])
    expect(tree.mapCount).toBe(6)
  })

  it('lists a slot reached from two roots under both', () => {
    const rom = blank()
    room(rom, 0x001, 0x068000, [0xc0])
    room(rom, 0x002, 0x069000, [0xc0])
    room(rom, 0x0c0, 0x06a000, [])
    const tree = treeOf(rom)

    expect(kids(tree, 0x001).map(c => c.index)).toEqual([0x0c0])
    expect(kids(tree, 0x002).map(c => c.index)).toEqual([0x0c0])
  })
})
