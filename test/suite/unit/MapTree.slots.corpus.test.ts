/** The tree lists every slot; slots sharing the most common pointer are ordinary maps and the hierarchy is unchanged (#901, #949). Needs the corpus. */
import { describe, it, expect } from 'vitest'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { reachableSlots } from '../../../src/rom/LevelTree'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { isOverworldLevel } from '../../../src/rom/SmwRom'
import { INVICTUS, VANILLA, freshRom, hasRom } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('vanilla tree lists every slot', () => {
  it('lists 512 slots, all maps, and the shared-pointer slots are plain unassigned maps', () => {
    const rom = new SmwRom(freshRom(VANILLA))
    const tree = buildMapTree(rom)

    const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
    const repeats = new Map<number, number>()
    for (const p of pointers) repeats.set(p, (repeats.get(p) ?? 0) + 1)
    const expected = Math.max(...repeats.values())
    const mostCommon = [...repeats].find(([, n]) => n === expected)![0]

    const listed = new Set(
      [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].flatMap(n => [
        n.index,
        ...n.children.map(c => c.index),
      ]),
    )
    expect(listed.size).toBe(LEVEL_COUNT)
    // Acceptance 4: on vanilla every one of the 512 slots is a map and none is New.
    expect(tree.mapCount).toBe(LEVEL_COUNT)
    expect(tree.counts.noPointer).toBe(0)
    expect(tree.unassigned.filter(n => n.noPointer || n.unreadable)).toEqual([])
    // The slots on the most common pointer ($068000) are among the unassigned maps, unmarked.
    const sharedRows = tree.unassigned.filter(n => pointers[n.index] === mostCommon)
    expect(sharedRows).toHaveLength(expected)
    expect(tree.counts.unassigned).toBeGreaterThanOrEqual(expected)
    // $025 shares it and is the slot the Playwright spec opens.
    expect(tree.unassigned.find(n => n.index === 0x025)).toMatchObject({
      index: 0x025,
      kind: 'map',
    })
  })
})

// Literal list, one skipIf describe each: a missing ROM skips only its own case, visibly.
const CORPUS_ROMS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Seven_Vanilla_Levels.sfc',
  'Grand Poo World 2 1.1.sfc',
  'Invictus 1.0.sfc',
] as const

for (const name of CORPUS_ROMS) {
  describe.skipIf(!hasRom(name))(
    `sharing a pointer changes no map the hierarchy already listed: ${name}`,
    () => {
      it('keeps entry maps, sub areas, bonus rooms and real orphans identical', () => {
        const rom = new SmwRom(freshRom(name))
        const tree = buildMapTree(rom)

        // The pre-#901 rule, recomputed independently of the catalog: the catalog's filler was
        // the mode of all 512 pointers (zero included) and a map was any slot not holding it.
        const catalog = buildLevelCatalog(rom)
        const pointers = Array.from(
          { length: LEVEL_COUNT },
          (_, i) => rom.getLevelL1Pointer(i) ?? 0,
        )
        const tally = new Map<number, number>()
        for (const p of pointers) tally.set(p, (tally.get(p) ?? 0) + 1)
        const oldFiller = [...tally].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
        const maps = new Set(pointers.flatMap((p, i) => (p === oldFiller ? [] : [i])))
        const entrance = deriveOverworldEntrances(rom, catalog)
        const roots = [...maps]
          .filter(i => isOverworldLevel(i, entrance.roots))
          .sort((a, b) => a - b)
        const { graph } = rom.buildLevelExitGraph(entrance.roots)
        const stops = (i: number) => isOverworldLevel(i, entrance.roots) || !maps.has(i)

        expect(
          tree.overworld.map(n => n.index),
          name,
        ).toEqual(roots)
        for (const n of tree.overworld) {
          // The wings link (#1229) adds Yoshi Heaven; the exit graph's own sub areas are what the old rule gives.
          expect(
            n.children.filter(c => !tree.wingsPlaced!.includes(c.index)).map(c => c.index),
            `${name} $${n.index.toString(16)}`,
          ).toEqual(reachableSlots(n.index, graph, stops))
        }
        const sharedSlots = new Set(catalog.entries.filter(e => e.sharedPointer).map(e => e.index))
        const real = tree.unassigned.filter(n => !sharedSlots.has(n.index)).map(n => n.index)
        // Everything the old tree placed outside Unassigned: specials, bonus rooms, roots, sub areas.
        const placed = new Set(
          [...tree.special, ...tree.bonus, ...tree.overworld].flatMap(n => [
            n.index,
            ...n.children.map(c => c.index),
          ]),
        )
        expect(real, `${name} real orphans`).toEqual(
          [...maps].filter(i => !placed.has(i)).sort((a, b) => a - b),
        )
        expect(catalog.realCount, name).toBe(maps.size)
        expect(tree.mapCount, name).toBe(maps.size + catalog.sharedPointerCount)
      })
    },
  )
}

// Measured on develop before #901 (tree rows and counts), so a drift in any row shows here.
// Literal table, one skipIf describe each: a missing ROM skips visibly instead of vanishing.
const PINNED = [
  {
    rom: 'Super Mario World (USA).vanilla.sfc',
    maps: 235,
    entry: 79,
    orphans: 18,
    shared: 277,
    special: [
      [0xc7, 'title-screen'],
      [0xc5, 'new-game'],
    ],
    bonus: [
      [0x000, 'bonus-game'],
      [0x100, 'bonus-game'],
    ],
  },
  {
    rom: 'Super Mario World (USA).magic.sfc',
    maps: 235,
    entry: 79,
    orphans: 18,
    shared: 277,
    special: [
      [0xc7, 'title-screen'],
      [0xc5, 'new-game'],
    ],
    bonus: [
      [0x000, 'bonus-game'],
      [0x100, 'bonus-game'],
    ],
  },
  {
    rom: 'GrandPooWorld_V1.2.sfc',
    maps: 235,
    entry: 33,
    orphans: 200,
    shared: 277,
    special: [
      [0xc7, 'title-screen'],
      [0xc5, 'new-game'],
    ],
    bonus: [],
  },
  {
    rom: 'Seven_Vanilla_Levels.sfc',
    maps: 251,
    entry: 9,
    orphans: 240,
    shared: 261,
    special: [
      [0xc7, 'title-screen'],
      [0xc5, 'new-game'],
    ],
    bonus: [],
  },
  {
    rom: 'Grand Poo World 2 1.1.sfc',
    maps: 291,
    entry: 37,
    orphans: 253,
    shared: 221,
    special: [[0xc5, 'new-game']],
    bonus: [],
  },
  {
    rom: 'Invictus 1.0.sfc',
    maps: 354,
    entry: 38,
    orphans: 315,
    shared: 158,
    special: [[0xc5, 'new-game']],
    bonus: [],
  },
] as const

for (const p of PINNED) {
  describe.skipIf(!hasRom(p.rom))(`pinned tree shape: ${p.rom}`, () => {
    it('lists all 512 slots with the counts, entry maps, special and bonus rows measured before #901', () => {
      const tree = buildMapTree(new SmwRom(freshRom(p.rom)))
      const listed = new Set(
        [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].flatMap(n => [
          n.index,
          ...n.children.map(c => c.index),
        ]),
      )
      expect(listed.size).toBe(LEVEL_COUNT)
      expect(tree.mapCount).toBe(p.maps + p.shared)
      expect(tree.counts.noPointer).toBe(0)
      expect(tree.counts.unassigned).toBe(p.orphans + p.shared)
      expect(tree.overworld).toHaveLength(p.entry)
      expect(tree.special.map(n => [n.index, n.role])).toEqual(p.special)
      expect(tree.bonus.map(n => [n.index, n.role])).toEqual(p.bonus)
    })
  })
}

describe.skipIf(!hasRom(VANILLA))('vanilla notes', () => {
  it('has no lost-connections note, since every stream ends within the graph read', () => {
    const notes = buildMapTree(new SmwRom(freshRom(VANILLA))).notes
    expect(notes.filter(n => /more connections than could be read/.test(n))).toEqual([])
  })
})

// A hack's custom objects can desync the stock-size walk without an end marker showing, so these
// working hacks must give no warning row at all (round 3). Slots are named in the message.
describe.each([VANILLA, 'Grand Poo World 2 1.1.sfc', INVICTUS, 'Kaizo Kindergarten v1.09.sfc'])(
  'no warning rows on %s',
  name => {
    it.skipIf(!hasRom(name))('lists no unreadable map', () => {
      const tree = buildMapTree(new SmwRom(freshRom(name)))
      const all = [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].flatMap(
        function walk(n: (typeof tree.unassigned)[number]): (typeof n)[] {
          return [n, ...n.children.flatMap(walk)]
        },
      )
      const bad = all.filter(n => n.unreadable).map(n => '$' + n.index.toString(16).toUpperCase())
      expect(bad, `warning rows on slots ${bad.join(' ')}`).toEqual([])
    })
  },
)
