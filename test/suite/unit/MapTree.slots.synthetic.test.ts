/** New slots (zero or out-of-file pointer) versus ordinary maps that share a pointer (#949, D155). ROM-free. */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapNode } from '../../../src/rom/MapTree'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { applyGroups, topLevelSlots } from '../../../src/project/MapGroups'
import {
  plantBonusCode,
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

/** Points `slot` at a minimal room of its own at $069000. */
function plantRoom(rom: RomFile, slot: number): void {
  point(rom, slot, 0x069000)
  rom.writeAt(0x069000, [0, 0, 0, 0, 0, 0xff])
}

/** `n` slots from $040 upward on SHARED, plus one real room at $0D0 so the ROM is not all filler. */
function romWithShared(n: number): RomFile {
  const rom = blank()
  for (let i = 0; i < n; i++) point(rom, 0x040 + i, SHARED)
  rom.writeAt(SHARED, [0, 0, 0, 0, 0, 0xff]) // a shared room that ends properly
  plantRoom(rom, 0x0d0)
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
  it.each(
    [0x000000, 0x001234, 0x007fff, 0x7e8000, 0x7f9000].map(p => [p.toString(16), p] as const),
  )('marks a slot whose pointer is $%s as New and not a map', (_hex, ptr) => {
    const rom = romWithShared(12)
    point(rom, 0x1ff, ptr)
    const tree = treeOf(rom)
    const row = tree.unassigned.find(n => n.index === 0x1ff)!

    expect(row.noPointer).toBe(true)
    expect(row.unreadable).toBeUndefined()
    expect(tree.mapCount).toBe(13)
    expect(tree.counts.noPointer).toBe(512 - 13)
  })

  it('sorts a New slot between two maps by index', () => {
    const rom = blank()
    for (let i = 0; i < 12; i++) point(rom, 0x042 + i, SHARED)
    plantRoom(rom, 0x040)
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
  it.each([0xfffffb, 0xfffffc, 0xfffffe, 0xffffff].map(p => [p.toString(16), p] as const))(
    'a pointer at $%s is unreadable',
    (_hex, ptr) => {
      const rom = blank()
      point(rom, 0x060, ptr)
      const row = treeOf(rom).unassigned.find(n => n.index === 0x060)!

      expect(row.noPointer).toBeUndefined()
      expect(row.unreadable).toBe(true)
    },
  )

  // D155: the data must be walkable to its end marker. Six bytes is the shortest room that is.
  it('a room whose end marker is the last byte of the file is readable', () => {
    const rom = blank()
    rom.writeAt(0xfffffa, [0, 0, 0, 0, 0, 0xff])
    point(rom, 0x060, 0xfffffa)
    expect(treeOf(rom).unassigned.find(n => n.index === 0x060)!.unreadable).toBeUndefined()
  })

  it('warns when a long stream never reaches its end marker, though its header fits', () => {
    const rom = blank() // zero bytes are 3-byte objects all the way to the end of the read
    point(rom, 0x060, 0x069000)
    expect(treeOf(rom).unassigned.find(n => n.index === 0x060)!.unreadable).toBe(true)
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

describe('buildMapTree warns on every kind of row (F1, D155)', () => {
  const END = [0, 0, 0, 0, 0, 0xff]
  const room = (rom: RomFile, slot: number, at: number, body = END): void => {
    point(rom, slot, at)
    rom.writeAt(at, body)
  }
  /** Roots $001 (reads, exits to $0C5) and $002; bonus $0C8; title slot $0C9. Each of $002, $0C5, $0C8 and $0C9 is unterminated. */
  function mixed(): RomFile {
    const rom = blank()
    plantBonusCode(rom)
    rom.writeAt(0x0096cb, [0xa9, 0xed, 0xa0, 0x00, 0x8d, 0x09, 0x01]) // title screen loads $0C9
    room(rom, 0x001, 0x069000, [0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0xc5, 0xff])
    point(rom, 0x002, 0x06a000)
    point(rom, 0x0c5, 0x06b000)
    point(rom, 0x0c8, 0x06c000)
    point(rom, 0x0c9, 0x06d000)
    return rom
  }

  it('flags an unreadable root, sub area, bonus map and special map, and nothing else', () => {
    const tree = buildMapTree(new SmwRom(mixed()), SYNTHETIC_FINGERPRINTS)
    const flat = (rows: MapNode[]): MapNode[] => rows.flatMap(r => [r, ...flat(r.children)])
    const root = tree.overworld.find(n => n.index === 0x001)!

    expect(root.children.map(c => [c.index, c.unreadable])).toEqual([[0xc5, true]])
    expect(tree.overworld.find(n => n.index === 0x002)!.unreadable).toBe(true)
    expect(tree.bonus.find(n => n.index === 0x0c8)!.unreadable).toBe(true)
    expect(tree.special.find(n => n.index === 0x0c9)!.unreadable).toBe(true)
    const flagged = flat([...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned])
    expect(
      flagged
        .filter(n => n.unreadable)
        .map(n => n.index)
        .sort((a, b) => a - b),
    ).toEqual([0x002, 0x0c5, 0x0c8, 0x0c9])
  })
})

describe('the common pointer ignores pointers outside the file (F2)', () => {
  // 20 slots on a WRAM address outnumber the 15 on a real room; the WRAM ones are New.
  function witness(): RomFile {
    const rom = blank()
    for (let i = 0; i < 20; i++) point(rom, 0x100 + i, 0x7e8000)
    for (let i = 0; i < 15; i++) point(rom, 0x040 + i, SHARED)
    rom.writeAt(SHARED, [0, 0, 0, 0, 0, 0xff])
    return rom
  }

  it('names the real room as common, so catalog, exit graph and tree agree', () => {
    const sm = new SmwRom(witness())
    const catalog = buildLevelCatalog(sm)
    const graphPick = (
      sm as unknown as { _findFillerL1Pointer(): number | null }
    )._findFillerL1Pointer()

    expect(catalog.fillerPointer).toBe(SHARED)
    expect(graphPick).toBe(SHARED)
    expect(catalog.sharedPointerCount).toBe(15)
    expect(catalog.realCount).toBe(0)
    expect(catalog.entries.filter(e => e.sharedPointer && !e.pointed)).toEqual([])
    const tree = buildMapTree(sm, SYNTHETIC_FINGERPRINTS)
    expect(tree.mapCount).toBe(catalog.realCount + catalog.sharedPointerCount)
    expect(tree.counts.noPointer).toBe(512 - 15)
  })
})

describe('what counts as an unreadable stream (round 3)', () => {
  const rowsOf = (tree: ReturnType<typeof treeOf>) => tree.unassigned.filter(n => n.unreadable)

  it('a stream whose end marker lies past the 8 KB read cap gives no warning', () => {
    const rom = blank()
    point(rom, 0x060, 0x069000)
    // 3000 harmless 3-byte objects (9000 bytes), then the end marker.
    rom.writeAt(0x069000, [
      0,
      0,
      0,
      0,
      0,
      ...new Array<number[]>(3000).fill([0x42, 0, 0]).flat(),
      0xff,
    ])
    expect(rowsOf(treeOf(rom))).toEqual([])
  })

  it('a stream whose end marker lies past the 128 KB window warns', () => {
    const rom = blank()
    point(rom, 0x060, 0x069000)
    rom.writeAt(0x069000, [
      0,
      0,
      0,
      0,
      0,
      ...new Array<number[]>(45000).fill([0x42, 0, 0]).flat(),
      0xff,
    ])
    expect(rowsOf(treeOf(rom)).map(n => n.index)).toEqual([0x060])
  })

  it('a stream ending past 8 KB has no row warning but its lost connections get their own note', () => {
    const rom = blank()
    point(rom, 0x060, 0x069000)
    rom.writeAt(0x069000, [
      0,
      0,
      0,
      0,
      0,
      ...new Array<number[]>(3000).fill([0x42, 0, 0]).flat(),
      0xff,
    ])
    const tree = treeOf(rom)
    const note = tree.notes.find(n => /more connections than could be read/.test(n))
    expect(rowsOf(tree)).toEqual([])
    expect(note).toContain('$060')
    expect(note).not.toMatch(/0x|pointer/i)
  })

  it('a stream with no end marker before the file ends still warns', () => {
    const rom = blank()
    point(rom, 0x060, 0x069000)
    expect(rowsOf(treeOf(rom)).map(n => n.index)).toEqual([0x060])
  })

  it('the exit graph does not treat a slot whose pointer is outside the file as a destination (M22)', () => {
    const rom = blank()
    point(rom, 0x001, 0x069000)
    rom.writeAt(0x069000, [0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0xc5, 0xff])
    point(rom, 0x0c5, 0x7e8000)
    const sm = new SmwRom(rom)
    const { roots } = deriveOverworldEntrances(sm, undefined, SYNTHETIC_FINGERPRINTS)
    expect(
      sm.buildLevelExitGraph(roots, SYNTHETIC_FINGERPRINTS.entry).graph.get(0x001),
    ).toBeUndefined()
  })

  it('the toast note and the rows name the same unreadable slots (M25)', () => {
    const rom = romWithShared(12)
    point(rom, 0x060, 0x06b000) // one unreadable ordinary map
    const tree = treeOf(rom)
    const rows = rowsOf(tree).map(n => n.index)
    const note = tree.notes.find(n => /could not be read to its end/.test(n))
    expect(rows).toEqual([0x060])
    expect(note).toMatch(/^1 map has/)
    expect(note).toContain('$060')

    const shared = blank()
    for (let i = 0; i < 12; i++) point(shared, 0x040 + i, 0xfffffe)
    const t2 = treeOf(shared)
    expect(t2.notes.find(n => n.includes('could not be read to its end'))).toMatch(
      new RegExp(`^${rowsOf(t2).length} maps have`),
    )
  })
})
