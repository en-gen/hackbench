/**
 * #840: a sprite whose INIT spawns companions is credited with its own drawing only. The synthetic cart's
 * id 34 spawns id 35 into the slot below; both draw one piece in their own slot's OAM entry. The game's
 * loop stores the slot it is on in $15E9 before running it (SMWDisX bank_01.asm:110-125), so a tile byte
 * written while $15E9 names another slot is that slot's.
 */
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()
const SLOT = 5
/** Entry index of the slot's first piece: the draw stores at $0300 + 4 * slot, and entries count from $0200. */
const FIRST = (0x300 - 0x200) / 4 + SLOT

describe('companions spawned in INIT', () => {
  it("are not the spawner's parts: it keeps the piece it drew in its own slot", () => {
    const m = runSprite(rom, 34, withSeed({ slot: SLOT }))
    expect(m.refusal).toBeUndefined()
    expect(m.chosen).toBeDefined()
    expect(m.passes[m.chosen!].parts.map(p => p.oam)).toEqual([FIRST])
  })

  it('a sprite that draws two pieces itself keeps both (no over-filtering)', () => {
    const m = runSprite(rom, 36, withSeed({ slot: SLOT }))
    expect(m.refusal).toBeUndefined()
    expect(m.passes[m.chosen!].parts.map(p => p.oam)).toEqual([FIRST, FIRST + 1])
  })
})
