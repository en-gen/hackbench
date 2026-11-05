/** New slots (zero or out-of-file pointer) versus ordinary maps that share a pointer (#949, D155). ROM-free. */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import { applyGroups, topLevelSlots } from '../../../src/project/MapGroups'
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
const allSlots = (tree: ReturnType<typeof treeOf>) =>
  [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].map(r => r.index)

describe('buildMapTree and slots that share the most common pointer', () => {
  it('lists 12 sharing slots as ordinary unassigned maps, with no mark and counted as maps', () => {
    const tree = treeOf(romWithShared(12))
    const maps = tree.unassigned.filter(n => !n.noPointer)

    expect(maps.map(n => n.index)).toEqual([...slots(12), 0x0d0])
    expect(maps.every(n => n.unreadable === undefined)).toBe(true)
    expect(Object.keys(maps[0]!).sort()).toEqual(['children', 'index', 'kind', 'l1Aliases', 'name'])
    expect(tree.mapCount).toBe(13)
    expect(tree.counts.unassigned).toBe(13)
    expect(tree.counts.noPointer).toBe(512 - 13)
  })

  it.each([0, 9, 10, 12, 15])(
    'lists every slot exactly once with %i slots sharing, maps plus New slots summing to 512',
    n => {
      const tree = treeOf(romWithShared(n))

      expect(allSlots(tree).sort((a, b) => a - b)).toEqual(Array.from({ length: 512 }, (_, i) => i))
      expect(tree.mapCount).toBe(n + 1)
      expect(tree.mapCount + tree.counts.noPointer).toBe(512)
      expect(tree.counts.noPointer).toBe(tree.unassigned.filter(r => r.noPointer).length)
    },
  )

  it('never makes a shared-pointer slot an entry map or a sub area', () => {
    const tree = treeOf(romWithShared(12))
    const placed = [...tree.overworld, ...tree.bonus, ...tree.special].flatMap(n => [
      n.index,
      ...n.children.map(c => c.index),
    ])
    expect(placed.filter(i => slots(12).includes(i))).toEqual([])
  })
})

describe('buildMapTree and New slots', () => {
  // Zero, then pointers that name no ROM byte on a 4 MB cart: registers/low RAM in a
  // low bank, and the WRAM banks. Swept, so one lucky case cannot pass.
  it.each([0x000000, 0x001234, 0x007fff, 0x7e8000, 0x7f9000])(
    'marks a slot whose pointer is $%s as New and not a map',
    ptr => {
      const rom = romWithShared(12)
      point(rom, 0x1ff, ptr)
      const tree = treeOf(rom)
      const row = tree.unassigned.find(n => n.index === 0x1ff)!

      expect(row.noPointer).toBe(true)
      expect(row.unreadable).toBeUndefined()
      expect(tree.mapCount).toBe(13)
      expect(tree.counts.noPointer).toBe(512 - 13)
    },
  )

  it('sorts a New slot between two maps by index', () => {
    const rom = blank()
    for (let i = 0; i < 12; i++) point(rom, 0x042 + i, SHARED)
    point(rom, 0x040, 0x069000)
    rom.writeAt(0x069000, [0, 0, 0, 0, 0, 0x42, 0xff])
    const rows = treeOf(rom).unassigned.filter(r => r.index >= 0x040 && r.index <= 0x042)

    expect(rows.map(r => [r.index, r.noPointer === true])).toEqual([
      [0x040, false],
      [0x041, true],
      [0x042, false],
    ])
  })
})

describe('buildMapTree and a valid pointer whose data cannot be read', () => {
  // The cart is 4 MB, so $FFFFFB is the last offset with five header bytes left.
  // Fewer than five is a pointer that resolves but cannot hold a level header.
  it.each([
    [0xfffffb, false],
    [0xfffffc, true],
    [0xfffffe, true],
    [0xffffff, true],
  ])('a pointer at $%s is unreadable: %s', (ptr, unreadable) => {
    const rom = blank()
    point(rom, 0x060, ptr)
    const row = treeOf(rom).unassigned.find(n => n.index === 0x060)!

    expect(row.noPointer).toBeUndefined()
    expect(row.unreadable).toBe(unreadable ? true : undefined)
  })

  it('stays a map: counted in mapCount and not in the New count', () => {
    const rom = blank()
    point(rom, 0x060, 0xfffffe)
    const tree = treeOf(rom)

    expect(tree.mapCount).toBe(1)
    expect(tree.counts.noPointer).toBe(511)
  })

  it('warns on a shared-pointer slot whose data cannot be read, too', () => {
    const rom = blank()
    for (let i = 0; i < 12; i++) point(rom, 0x040 + i, 0xfffffe)
    const tree = treeOf(rom)

    expect(tree.unassigned.filter(n => n.unreadable).map(n => n.index)).toEqual(slots(12))
    expect(tree.mapCount).toBe(12)
  })
})

describe('groups over a real tree (D155, D156)', () => {
  it('lets a group claim a shared-pointer slot and refuses a New one', () => {
    const tree = treeOf(romWithShared(12))
    const grouped = applyGroups(tree, [{ name: 'A', slots: [0x040, 0x1ff, 0x0d0] }])

    expect(topLevelSlots(tree).has(0x040)).toBe(true)
    expect(topLevelSlots(tree).has(0x1ff)).toBe(false)
    expect(grouped.groups[0]!.maps.map(m => m.index)).toEqual([0x040, 0x0d0])
    expect(grouped.unassigned.map(m => m.index)).toContain(0x1ff)
    expect(grouped.unassigned.map(m => m.index)).not.toContain(0x040)
  })
})
