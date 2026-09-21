import { expect } from 'vitest'
import type { LevelCatalog } from '../../../src/rom/LevelCatalog'
import { LEVEL_COUNT } from '../../../src/rom/SmwRom'

/**
 * The acceptance gate for a LevelCatalog result. Every assertion here must
 * fail on at least one of the broken variants exercised by the teeth tests
 * (return [], drop every second entry, mark everything/nothing real) -- see
 * LevelCatalog.synthetic.test.ts and the ROM-gated teeth test.
 */
export function assertCatalogAcceptance(
  catalog: LevelCatalog,
  expectedReal: number,
  expectedParseable: number,
): void {
  expect(catalog.entries).toHaveLength(LEVEL_COUNT) // kills return [] / dropped entries
  expect(catalog.realCount).toBe(expectedReal)
  expect(catalog.parseableCount).toBe(expectedParseable)

  const actualReal = catalog.entries.filter(e => e.isReal).length
  const actualParseable = catalog.entries.filter(e => e.parseable).length
  expect(actualReal).toBe(catalog.realCount) // kills counts that lie about entries
  expect(actualParseable).toBe(catalog.parseableCount)

  const fillerSlots = catalog.entries.filter(e => e.l1Pointer === catalog.fillerPointer)
  expect(fillerSlots.length).toBeGreaterThan(0)
  for (const e of fillerSlots) expect(e.isReal).toBe(false) // kills mark-everything-real

  expect(new Set(catalog.entries.map(e => e.isReal)).size).toBe(2) // kills mark-nothing-real too
  expect(catalog.entries[0]!.isReal).toBe(true) // known member: slot $000 is always real
}

/**
 * Four ways a LevelCatalog can be broken while still type-checking, shared by
 * the synthetic teeth suite and the ROM-gated teeth suite so the variants are
 * defined once instead of copy-pasted per file.
 */
export function buildBrokenCatalogVariants(good: LevelCatalog): Record<string, LevelCatalog> {
  return {
    empty: {
      entries: [],
      fillerPointer: good.fillerPointer,
      realCount: 0,
      parseableCount: 0,
      notes: [],
    },
    droppedHalf: {
      ...good,
      entries: good.entries.filter((_, i) => i % 2 === 0),
    },
    allReal: {
      ...good,
      entries: good.entries.map(e => ({ ...e, isReal: true })),
      realCount: LEVEL_COUNT,
    },
    noneReal: {
      ...good,
      entries: good.entries.map(e => ({ ...e, isReal: false, parseable: false })),
      realCount: 0,
      parseableCount: 0,
    },
  }
}
