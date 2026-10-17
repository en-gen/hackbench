import { createHash } from 'crypto'
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

// SHA-256 of JSON.stringify(deriveOverworldAreas(rom)), taken from the byte-pattern version of the
// module before it moved to fingerprints (one machine, this corpus): the full result, every
// area's camera X and Y included, and every hack's refusal text, is unchanged.
const BEFORE_FINGERPRINTS = {
  stock: '8ac0dd09f06a8adb9262e58ad7df4d566996f24339c961f95b6582d6f35e3124',
  refused: '67187efca4d4cbb963978612aee3904271e4a6d7465dabcc19b2c428bbce7035',
}
describe.each(CORPUS)('deriveOverworldAreas result unchanged by fingerprinting: %s', name => {
  it.skipIf(!hasRom(name))('is identical to the byte-pattern result', () => {
    const json = JSON.stringify(deriveOverworldAreas(freshRom(name)))
    const want = name === VANILLA || name === MAGIC ? 'stock' : 'refused'
    expect(createHash('sha256').update(json).digest('hex')).toBe(BEFORE_FINGERPRINTS[want])
  })
})
