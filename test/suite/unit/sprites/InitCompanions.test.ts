/**
 * #840: a sprite whose INIT spawns companions is credited with its own drawing only. The synthetic cart's
 * id 34 spawns id 35 into the sprite slot below, id 37 the one above; both draw one piece in their own slot's OAM entry. The game's
 * loop stores the slot it is on in $15E9 before running it (SMWDisX bank_01.asm:110-125), so a tile byte
 * written while $15E9 names another slot is that slot's.
 */
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()
/** Entry index of a slot's first piece: the draw stores at $0300 + $15EA,X, which the synthetic cart sets to 4 * slot, and entries count from $0200. */
const firstOf = (slot: number) => (0x300 - 0x200) / 4 + slot
const SLOT = 5
const FIRST = firstOf(SLOT)

// Sweep the spawner's sprite slot; id 34 spawns below, id 37 above (slot 11 has none above).
const CASES = [
  ...[1, 2, 3, 5, 8, 11].map(slot => ({ id: 34, where: 'below', slot })),
  ...[0, 1, 4, 6, 9, 10].map(slot => ({ id: 37, where: 'above', slot })),
]

describe.each(CASES)(
  'companions spawned in INIT, id $id ($where) in sprite slot $slot',
  ({ id, slot }) => {
    it("are not the spawner's parts: it keeps the piece it drew in its own sprite slot", () => {
      const m = runSprite(rom, id, withSeed({ slot }))
      expect(m.refusal).toBeUndefined()
      expect(m.chosen).toBeDefined()
      expect(m.passes[m.chosen!].parts.map(p => p.oam)).toEqual([firstOf(slot)])
    })
  },
)

describe('a sprite that draws for itself', () => {
  it('a sprite that draws two pieces itself keeps both (no over-filtering)', () => {
    const m = runSprite(rom, 36, withSeed({ slot: SLOT }))
    expect(m.refusal).toBeUndefined()
    expect(m.passes[m.chosen!].parts.map(p => p.oam)).toEqual([FIRST, FIRST + 1])
  })
})
