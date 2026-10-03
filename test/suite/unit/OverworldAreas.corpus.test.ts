import { describe, it, expect } from 'vitest'
import { deriveOverworldAreas } from '../../../src/rom/OverworldAreas'
import { CORPUS, VANILLA, freshRom, hasRom } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('deriveOverworldAreas on the vanilla ROM', () => {
  it('starts in area 1 and reaches areas 0-6', () => {
    expect(deriveOverworldAreas(freshRom(VANILLA))).toEqual({
      entry: 1,
      areas: [0, 1, 2, 3, 4, 5, 6],
    })
  })
})

// Not an assertion on hack results: prints what each corpus ROM returns.
describe.skipIf(!hasRom(VANILLA))('deriveOverworldAreas across the corpus', () => {
  it('returns a verdict for every ROM present', () => {
    for (const name of CORPUS) {
      if (!hasRom(name)) continue
      const r = deriveOverworldAreas(freshRom(name))
      console.log(name, JSON.stringify(r))
      expect(r).toSatisfy((v: object) => 'areas' in v || 'unavailable' in v)
    }
  })
})
