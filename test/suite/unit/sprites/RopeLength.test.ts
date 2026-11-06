/**
 * #1230: the rope's model from the slot the loader gives it (RopeLength.ts). Synthetic loader and a stand-in `runAt`, no ROM:
 * the stand-in draws one part per tile going DOWN (a vertical rope, like the real one), 9 when the slot is the high one and
 * the setting is not 0 and 5 otherwise, and takes its first part's char from the slot (the motor tile). These prove the
 * wiring (which slot, which orientation, which parts are tagged, what a refusal says); the ROM's own branch runs on the
 * vanilla draw in RopeLength.corpus.test.ts and the call site is exercised in RopeCallSite.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { ropeModel, type RopeAt } from '../../../../src/rom/sprites/interp/RopeLength'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { ROWS, slotCart, SPECIAL } from '../../support/slotPickCart'
import { drawer } from '../../support/ropeStandIn'

const { rom, spec } = slotCart()
const at = (o: Partial<RopeAt>): RopeAt => ({ id: SPECIAL, setting: 1, x: 0x10, y: 0x20, vertical: false, spec, ...o }) // prettier-ignore
const tiles = (m: SpriteModel) => m.passes[0]!.parts.length

describe('ropeModel', () => {
  it('setting 1: an odd column runs in the reserved slot and draws long; an even one draws short', () => {
    const seen: number[] = []
    expect(tiles(ropeModel(rom, at({ x: 0x10 }), drawer(1, seen)))).toBe(9)
    expect(seen).toEqual([6])
    expect(tiles(ropeModel(rom, at({ x: 0x20 }), drawer(1)))).toBe(5)
  })
  it('a vertical map takes the row parity and ignores the column parity, a horizontal one the reverse', () => {
    expect(tiles(ropeModel(rom, at({ x: 0x10, y: 0x20, vertical: true }), drawer(1)))).toBe(5)
    expect(tiles(ropeModel(rom, at({ x: 0x20, y: 0x10, vertical: true }), drawer(1)))).toBe(9)
    expect(tiles(ropeModel(rom, at({ x: 0x20, y: 0x10, vertical: false }), drawer(1)))).toBe(5)
  })
  it('setting 0 draws short in every slot, so the run is one solid rope', () => {
    for (const x of [0x00, 0x10, 0x20, 0x30]) {
      const m = ropeModel(rom, at({ setting: 0, x }), drawer(0))
      expect(tiles(m)).toBe(5)
    }
  })
  it('the same positions in both slots: the picture is the loader first pick, with its motor tile (an even rope)', () => {
    expect(ropeModel(rom, at({ x: 0x20 }), drawer(1)).passes[0]!.parts[0]!.char).toBe(4)
    expect(ropeModel(rom, at({ setting: 0, x: 0x10 }), drawer(0)).passes[0]!.parts[0]!.char).toBe(
      10,
    )
  })
  it('a top slot the ordinary sprites share: the short rope is shown, with its own motor tile', () => {
    const m = ropeModel(rom, at({ setting: 2, id: 0x01 }), drawer(2))
    expect(tiles(m)).toBe(5)
    expect(m.passes[0]!.parts[0]!.char).toBe(2)
  })
  it('keeps slot 0 and says why for a loader or a setting it cannot read', () => {
    const seen: number[] = []
    const bad = ropeModel(rom, at({ spec: { ...spec, sha256: 'x' } }), drawer(1, seen))
    expect(seen).toEqual([0])
    expect(bad.unverifiedReason).toMatch(/loader.*not the original.*short length/)
    expect(bad.lengthNote).toBe(
      'The rope is shown at its short length: the sprite loader on this ROM is not the original one.',
    )
    expect(tiles(bad)).toBe(5)
    const past = ropeModel(rom, at({ setting: ROWS.max.length }), drawer(1))
    expect(past.lengthNote).toMatch(/^The rope is shown at its short length: .*setting 4/)
  })
  it('reports it when the two slots start the rope at different spots, and shows the short length', () => {
    const m = ropeModel(
      rom,
      at({ setting: 2, id: 0x01 }),
      drawer(2, [], s => 100 + s),
    )
    expect(tiles(m)).toBe(5)
    expect(m.lengthNote).toMatch(/different spot/)
  })
  it('a draw the line-guided gate did not confirm as the rope is run in slot 0 as before, with no note', () => {
    for (const o of [{}, { spec: { ...spec, sha256: 'x' } }]) {
      const seen: number[] = []
      const m = ropeModel(rom, at(o), drawer(1, seen, undefined, false))
      expect(seen.at(-1)).toBe(0)
      expect(m.lengthNote).toBeUndefined()
      expect(m.unverifiedReason).toBeUndefined()
    }
  })
})
