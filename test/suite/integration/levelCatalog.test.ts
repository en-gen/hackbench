import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import * as path from 'path'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildLevelCatalog, type LevelCatalog } from '../../../src/rom/LevelCatalog'
import { assertCatalogAcceptance, buildBrokenCatalogVariants } from '../support/catalogAcceptance'

// Measured baseline -- see docs/ideas/level-classification.md Tier 1.
// Every ROM in the corpus now parses its catalog in full (parseable == real).
// The two 4 MB ROMs did not when this table was first written: they sat at
// 197/291 and 192/354, which the Tier 1 write-up attributed to expanded-ROM
// addressing. The addressing fix landed separately and closed both gaps
// exactly, which is the confirmation that hypothesis was waiting on.
const CORPUS: Array<{ file: string; real: number; parseable: number }> = [
  { file: 'Super Mario World (USA).vanilla.sfc', real: 235, parseable: 235 },
  { file: 'Super Mario World (USA).magic.sfc', real: 235, parseable: 235 },
  { file: 'Seven_Vanilla_Levels.sfc', real: 251, parseable: 251 },
  { file: 'GrandPooWorld_V1.2.sfc', real: 235, parseable: 235 },
  { file: 'Grand Poo World 2 1.1.sfc', real: 291, parseable: 291 },
  { file: 'Invictus 1.0.sfc', real: 354, parseable: 354 },
]

for (const { file, real, parseable } of CORPUS) {
  const romPath = path.resolve(__dirname, '../../roms', file)
  const romPresent = existsSync(romPath)

  // "matches the measured real/parseable counts" was folded away here: it
  // was a strict subset of the acceptance gate below (same two expectations,
  // among others) -- see the gate's own real/parseable checks.
  describe.skipIf(!romPresent)(`buildLevelCatalog (requires test/roms/${file})`, () => {
    let catalog: LevelCatalog

    it('never marks a filler-pointer slot real (complement of realCount)', () => {
      catalog ??= buildLevelCatalog(SmwRom.open(romPath))
      const fillerSlots = catalog.entries.filter(e => e.l1Pointer === catalog.fillerPointer)
      expect(fillerSlots.length).toBe(LEVEL_COUNT - real)
      expect(fillerSlots.every(e => !e.isReal)).toBe(true)
    })

    // The gap is a fact derivable from realCount - parseableCount; this only
    // checks that a note shows up exactly when that fact is nonzero, without
    // matching the note's English wording (see catalogAcceptance.ts, and
    // MUST-FIX 8 in the level-catalog review).
    it('reports a note exactly when parseable < real', () => {
      catalog ??= buildLevelCatalog(SmwRom.open(romPath))
      const hasGap = catalog.realCount - catalog.parseableCount > 0
      expect(hasGap).toBe(parseable < real)
      expect(catalog.notes.length > 0).toBe(hasGap)
    })

    it('passes the full acceptance gate', () => {
      catalog ??= buildLevelCatalog(SmwRom.open(romPath))
      expect(catalog.entries).toHaveLength(LEVEL_COUNT)
      expect(catalog.realCount).toBe(real)
      expect(catalog.parseableCount).toBe(parseable)
      expect(() => assertCatalogAcceptance(catalog, real, parseable)).not.toThrow()
    })
  })
}

// Teeth: the acceptance gate above must reject broken catalogs built from
// every ROM in the corpus, not just one. Mirrors the real failure mode this
// gate exists to catch: `return []` once passed a six-ROM acceptance sweep
// because every check there was a vacuous per-element loop.
describe('teeth: acceptance gate rejects broken catalogs (six-ROM sweep)', () => {
  for (const { file, real, parseable } of CORPUS) {
    const romPath = path.resolve(__dirname, '../../roms', file)
    if (!existsSync(romPath)) {
      it.skip(`${file} (ROM not present)`, () => {})
      continue
    }

    const good = buildLevelCatalog(SmwRom.open(romPath))
    const brokenVariants = buildBrokenCatalogVariants(good)

    for (const [variantName, broken] of Object.entries(brokenVariants)) {
      it(`${file}: "${variantName}" fails the gate`, () => {
        expect(() => assertCatalogAcceptance(broken, real, parseable)).toThrow()
      })
    }
  }
})
