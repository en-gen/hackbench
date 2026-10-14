/** The tree lists every slot, and the maps it already listed are unchanged (#901). Needs the corpus. */
import { describe, it, expect } from 'vitest'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildMapTree } from '../../../src/rom/MapTree'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { reachableSlots } from '../../../src/rom/LevelTree'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { isOverworldLevel } from '../../../src/rom/SmwRom'
import { CORPUS, VANILLA, freshRom, hasRom, hasRoms } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('vanilla tree lists every slot', () => {
  it('lists 512 slots, and the placeholder count is the pointer-table repeat count', () => {
    const rom = new SmwRom(freshRom(VANILLA))
    const tree = buildMapTree(rom)

    const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
    const repeats = new Map<number, number>()
    for (const p of pointers) repeats.set(p, (repeats.get(p) ?? 0) + 1)
    const expected = Math.max(...repeats.values())

    const listed = new Set(
      [...tree.special, ...tree.bonus, ...tree.overworld, ...tree.unassigned].flatMap(n => [
        n.index,
        ...n.children.map(c => c.index),
      ]),
    )
    expect(listed.size).toBe(LEVEL_COUNT)
    expect(tree.unassigned.filter(n => n.placeholder)).toHaveLength(expected)
    expect(tree.counts.placeholders).toBe(expected)
    expect(tree.mapCount + tree.counts.placeholders).toBe(LEVEL_COUNT)
    // $025 is a placeholder slot the Playwright spec opens.
    expect(tree.unassigned.find(n => n.index === 0x025)?.placeholder).toBe(true)
  })
})

describe.skipIf(!hasRoms())('placeholders change no map the tree already listed', () => {
  it('keeps entry maps, sub areas, bonus rooms and real orphans identical on every corpus ROM', () => {
    for (const name of CORPUS) {
      const rom = new SmwRom(freshRom(name))
      const tree = buildMapTree(rom)

      // The pre-#901 rule, recomputed independently of the catalog: the catalog's filler was
      // the mode of all 512 pointers (zero included) and a map was any slot not holding it.
      const catalog = buildLevelCatalog(rom)
      const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
      const tally = new Map<number, number>()
      for (const p of pointers) tally.set(p, (tally.get(p) ?? 0) + 1)
      const oldFiller = [...tally].reduce((a, b) => (b[1] > a[1] ? b : a))[0]
      const maps = new Set(pointers.flatMap((p, i) => (p === oldFiller ? [] : [i])))
      const entrance = deriveOverworldEntrances(rom, catalog)
      const roots = [...maps].filter(i => isOverworldLevel(i, entrance.roots)).sort((a, b) => a - b)
      const { graph } = rom.buildLevelExitGraph(entrance.roots)
      const stops = (i: number) => isOverworldLevel(i, entrance.roots) || !maps.has(i)

      expect(
        tree.overworld.map(n => n.index),
        name,
      ).toEqual(roots)
      for (const n of tree.overworld) {
        expect(
          n.children.map(c => c.index),
          `${name} $${n.index.toString(16)}`,
        ).toEqual(reachableSlots(n.index, graph, stops))
      }
      const real = tree.unassigned.filter(n => !n.placeholder).map(n => n.index)
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
      expect(tree.mapCount, name).toBe(maps.size)
      expect(tree.mapCount, name).toBe(catalog.realCount)
      expect(tree.mapCount + tree.counts.placeholders, name).toBe(
        maps.size + catalog.placeholderCount,
      )
    }
  })
})
