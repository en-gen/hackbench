import { describe, it, expect } from 'vitest'
import { deriveOverworldAreas } from '../../../src/rom/OverworldAreas'
import { VANILLA, MAGIC, freshRom, hasRom } from '../support/corpus'

const ALL = [0, 1, 2, 3, 4, 5, 6]

// Measured on this corpus (one machine, this build): vanilla and its Lunar Magic resave keep
// every site; each hack fails a gate.
describe.each([VANILLA, MAGIC])('deriveOverworldAreas on %s', name => {
  it.skipIf(!hasRom(name))('starts in area 1 and reaches areas 0-6, all valid', () => {
    const r = deriveOverworldAreas(freshRom(name))
    expect(r).toMatchObject({ entry: 1 })
    expect('areas' in r && r.areas.map(a => a.area)).toEqual(ALL)
    expect('areas' in r && r.areas.filter(a => a.invalid)).toEqual([])
  })
})

// The first gate each hack fails. GPW 1.2 passes the routine gates and refuses on the intro
// start-area write.
const REFUSED: [string, RegExp][] = [
  ['Grand Poo World 2 1.1.sfc', /JSL CODE_04853B .* does not call/],
  ['GrandPooWorld_V1.2.sfc', /intro runs, but the intro message-box sprite \$19/],
  ['Invictus 1.0.sfc', /JSL CODE_04853B .* does not call/],
  ['Seven_Vanilla_Levels.sfc', /CODE_048509, the warp scan .* is not stock/],
]

describe.each(REFUSED)('deriveOverworldAreas on %s', (name, reason) => {
  it.skipIf(!hasRom(name))('refuses, with a reason naming the gate', () => {
    expect(deriveOverworldAreas(freshRom(name))).toEqual({
      unavailable: expect.stringMatching(reason),
    })
  })
})
