/**
 * #1230: the rope's model from the slot the loader gives it (RopeLength.ts). Synthetic loader and a stand-in `runAt`, no ROM:
 * the stand-in draws one part per tile, 9 when the slot is the high one and the setting is not 0 and 5 otherwise, so these
 * tests prove the wiring (which slot, which orientation, which parts are tagged, what a refusal says); the ROM's own
 * branch is exercised on the vanilla draw in RopeLength.corpus.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { ropeModel, type RopeAt } from '../../../../src/rom/sprites/interp/RopeLength'
import type { SpriteModel, SpritePart } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { ROWS, slotCart, SPECIAL } from '../../support/slotPickCart'

const part = (dx: number, extra: Partial<SpritePart> = {}): SpritePart => ({ oam: 0, char: 0, size: 16, palette: 8, priority: 2, flipX: false, flipY: false, dx, dy: 0, attr: 0, ox: 0, oy: 0, ...extra }) as SpritePart // prettier-ignore
/** The stand-in draw: tiles in a row; `setting` and `slot` choose the count the way the game's own test would. */
const drawer = (setting: number, seen: number[] = [], anchorX = (_s: number) => 100) => (slot: number): SpriteModel => {
  seen.push(slot)
  const n = slot >= 6 && setting !== 0 ? 9 : 5
  const parts = Array.from({ length: n }, (_, i) => part(i * 16))
  return { chosen: 0, anchor: { x: anchorX(slot), y: 50 }, passes: [{ pass: 0, parts, companions: [] }] } as unknown as SpriteModel // prettier-ignore
}
const { rom, spec } = slotCart()
const at = (o: Partial<RopeAt>): RopeAt => ({ id: SPECIAL, setting: 1, x: 0x10, y: 0x20, vertical: false, spec, door: true, ...o }) // prettier-ignore
const tiles = (m: SpriteModel) => m.passes[0]!.parts.length

describe('ropeModel', () => {
  it('setting 1: an odd column runs in the reserved slot and draws long; an even one draws short', () => {
    const seen: number[] = []
    expect(tiles(ropeModel(rom, at({ x: 0x10 }), drawer(1, seen)))).toBe(9)
    expect(seen).toEqual([7])
    expect(tiles(ropeModel(rom, at({ x: 0x20 }), drawer(1)))).toBe(5)
  })
  it('a vertical map takes the row parity and ignores the column parity, a horizontal one the reverse', () => {
    expect(tiles(ropeModel(rom, at({ x: 0x10, y: 0x20, vertical: true }), drawer(1)))).toBe(5)
    expect(tiles(ropeModel(rom, at({ x: 0x20, y: 0x10, vertical: true }), drawer(1)))).toBe(9)
    expect(tiles(ropeModel(rom, at({ x: 0x20, y: 0x10, vertical: false }), drawer(1)))).toBe(5)
  })
  it('setting 0 draws short in every slot, so the run is one solid rope with nothing tagged', () => {
    for (const x of [0x00, 0x10, 0x20, 0x30]) {
      const m = ropeModel(rom, at({ setting: 0, x }), drawer(0))
      expect(tiles(m)).toBe(5)
      expect(m.passes[0]!.parts.some(p => p.door)).toBe(false)
    }
  })
  it('a slot the ordinary sprites share: the short rope is solid and only the extra length is tagged', () => {
    const m = ropeModel(rom, at({ setting: 2, id: 0x01 }), drawer(2))
    const parts = m.passes[0]!.parts
    expect(parts).toHaveLength(9)
    expect(parts.filter(p => p.door).map(p => p.dx)).toEqual([80, 96, 112, 128])
    expect(parts.slice(0, 5).some(p => p.door)).toBe(false)
  })
  it('the door is off until it is wired: the short rope stands', () => {
    expect(tiles(ropeModel(rom, at({ setting: 2, id: 0x01, door: undefined }), drawer(2)))).toBe(5)
  })
  it('keeps slot 0 and says why for a loader or a setting it cannot read', () => {
    const seen: number[] = []
    const bad = ropeModel(rom, at({ spec: { ...spec, sha256: 'x' } }), drawer(1, seen))
    expect(seen).toEqual([0])
    expect(bad.unverifiedReason).toMatch(/loader.*not the original.*short length/)
    expect(tiles(bad)).toBe(5)
    const past = ropeModel(rom, at({ setting: ROWS.max.length }), drawer(1))
    expect(past.unverifiedReason).toMatch(/setting 4/)
  })
  it('reports it when the two slots start the rope at different spots, and shows the short length', () => {
    const m = ropeModel(rom, at({ setting: 2, id: 0x01 }), drawer(2, [], s => 100 + s))
    expect(tiles(m)).toBe(5)
    expect(m.unverifiedReason).toMatch(/different spot/)
  })
})
