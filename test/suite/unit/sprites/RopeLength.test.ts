/**
 * #1230: the rope's model (RopeLength.ts) over a synthetic loader and the stand-in draw (ropeStandIn.ts), no ROM: which
 * slot, which orientation, which run is shown, what a refusal says. The ROM's own branch runs in RopeEdits.corpus.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { ropeModel, type RopeAt } from '../../../../src/rom/sprites/interp/RopeLength'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { ROWS, slotCart, SPECIAL } from '../../support/slotPickCart'
import { drawer, standIn } from '../../support/ropeStandIn'

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
  it('a gate-refused draw says why in the note, from the gate own reason', () => {
    const run = (slot: number) => ({ ...drawer(1)(slot), snaps: false, lineGateReason: 'slot 0: it calls $01DC54, which is not a stock routine here' }) as SpriteModel // prettier-ignore
    const m = ropeModel(rom, at({}), run)
    expect(m.lengthNote).toBe(
      'Not checked against the sprite loader on this ROM, so its length in play may differ.',
    )
    expect(m.unverifiedReason).toBe('slot 0: it calls $01DC54, which is not a stock routine here')
  })
  it('a run with no chosen pass cannot throw, and shows the short run', () => {
    const run = (slot: number) =>
      ({ ...drawer(2)(slot), chosen: undefined }) as unknown as SpriteModel
    expect(() => ropeModel(rom, at({ setting: 2, id: 0x01 }), run)).not.toThrow()
  })
  it('the slots must agree on the chosen pass and on both anchor coordinates, else the short rope is shown with a note', () => {
    const other = (patch: Partial<SpriteModel>) => (slot: number) => ({ ...drawer(2)(slot), ...(slot === 6 ? patch : {}) }) as SpriteModel // prettier-ignore
    for (const patch of [{ chosen: 1 }, { anchor: { x: 100, y: 51 } }, { anchor: { x: 101, y: 50 } }])
      expect(ropeModel(rom, at({ setting: 2, id: 0x01 }), other(patch)).lengthNote, JSON.stringify(patch)).toMatch(/different spot/) // prettier-ignore
  })
  it('the same number of parts at other positions is not the same rope: the short run is shown, not the long one', () => {
    const run = (slot: number) =>
      standIn(slot === 6 ? [0, 16, 32, 48, 64] : [0, 16, 32, 48, 80], slot)
    expect(ropeModel(rom, at({ setting: 2, id: 0x01 }), run).passes[0]!.parts[0]!.char).toBe(2)
    const same = (slot: number) => standIn([0, 16, 32, 48, 64], slot)
    expect(ropeModel(rom, at({ setting: 2, id: 0x01 }), same).passes[0]!.parts[0]!.char).toBe(6)
  })
})
