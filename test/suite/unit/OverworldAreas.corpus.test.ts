import { describe, it, expect } from 'vitest'
import { deriveOverworldAreas } from '../../../src/rom/OverworldAreas'
import { VANILLA, MAGIC, CORPUS, freshRom, hasRom } from '../support/corpus'

// Measured on this corpus (one machine, this build): vanilla and its Lunar Magic resave keep
// every site; each hack fails the camera-read gate, the first one checked.
describe.each([VANILLA, MAGIC])('deriveOverworldAreas on %s', name => {
  it.skipIf(!hasRom(name))('lists areas 0-6, none invalid', () => {
    const r = deriveOverworldAreas(freshRom(name))
    expect('areas' in r && r.areas.map(a => a.area)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect('areas' in r && r.areas.filter(a => a.invalid)).toEqual([])
  })
})

describe.each(CORPUS.filter(n => n !== VANILLA && n !== MAGIC))(
  'deriveOverworldAreas on %s',
  name => {
    it.skipIf(!hasRom(name))('refuses, naming the camera read', () => {
      expect(deriveOverworldAreas(freshRom(name))).toEqual({
        unavailable: expect.stringMatching(/camera read .* is not stock/),
      })
    })
  },
)
