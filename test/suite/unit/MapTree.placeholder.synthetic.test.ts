/** Placeholder slots are listed as orphans and marked, below a repeat threshold they are not (#901). ROM-free. */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

const SHARED = 0x068000

function blank(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  plantStockSubmapCode(rom)
  plantOverworldTiles(rom)
  return rom
}

const point = (rom: RomFile, slot: number, ptr: number): void =>
  rom.writeAt(ADDR.LEVEL_L1_PTR + slot * 3, [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff])

/** `n` slots from $040 upward on SHARED, plus one real room at $0D0 so the ROM is not all filler. */
function romWithShared(n: number): RomFile {
  const rom = blank()
  for (let i = 0; i < n; i++) point(rom, 0x040 + i, SHARED)
  point(rom, 0x0d0, 0x069000)
  rom.writeAt(0x069000, [0, 0, 0, 0, 0, 0x42, 0xff])
  return rom
}

const treeOf = (rom: RomFile) => buildMapTree(new SmwRom(rom), SYNTHETIC_FINGERPRINTS)
const slots = (n: number) => Array.from({ length: n }, (_, i) => 0x040 + i)

describe('buildMapTree and the shared placeholder room', () => {
  it('lists 12 slots sharing a pointer as orphans, each marked with the count', () => {
    const tree = treeOf(romWithShared(12))
    const marked = tree.unassigned.filter(n => n.placeholder)

    expect(marked.map(n => n.index)).toEqual(slots(12))
    expect(marked.every(n => n.sharedCount === 12)).toBe(true)
    // Listed with the real orphan, in slot order, but not counted as a map.
    expect(tree.unassigned.filter(n => !n.empty).map(n => n.index)).toEqual([...slots(12), 0x0d0])
    expect(tree.mapCount).toBe(1)
    expect(tree.counts.placeholders).toBe(12)
    expect(tree.counts.unassigned).toBe(1)
  })

  it('lists every slot exactly once: slots with no pointer show as empty, outside both counts', () => {
    const tree = treeOf(romWithShared(12))
    const all = [
      ...tree.special,
      ...tree.bonus,
      ...tree.overworld.flatMap(n => [n, ...n.children]),
      ...tree.unassigned,
    ].map(n => n.index)
    const top = [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].map(
      n => n.index,
    )

    expect([...new Set(top)].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 512 }, (_, i) => i),
    )
    expect(top.length).toBe(512)
    expect(all.length).toBeGreaterThanOrEqual(512)
    const empty = tree.unassigned.filter(n => n.empty)
    expect(empty.length).toBe(512 - 12 - 1)
    expect(empty.some(n => n.placeholder)).toBe(false)
    expect(tree.counts.empty).toBe(empty.length)
    expect(tree.counts.placeholders).toBe(12)
    expect(tree.mapCount).toBe(1)
  })

  it('lists 9 slots sharing a pointer, and marks none of them', () => {
    const tree = treeOf(romWithShared(9))

    expect(tree.unassigned.filter(n => !n.empty).map(n => n.index)).toEqual([...slots(9), 0x0d0])
    expect(tree.unassigned.some(n => n.placeholder || n.sharedCount !== undefined)).toBe(false)
    expect(tree.mapCount).toBe(10)
    expect(tree.counts.placeholders).toBe(0)
  })

  it('reads the count from the ROM: 15 sharing reports 15, not a fixed figure', () => {
    const tree = treeOf(romWithShared(15))
    expect(tree.unassigned.find(n => n.index === 0x040)?.sharedCount).toBe(15)
  })

  it('never makes a placeholder an entry map or a sub area', () => {
    const tree = treeOf(romWithShared(12))
    const placed = [...tree.overworld, ...tree.bonus, ...tree.special].flatMap(n => [
      n.index,
      ...n.children.map(c => c.index),
    ])
    expect(placed.filter(i => slots(12).includes(i))).toEqual([])
  })
})
