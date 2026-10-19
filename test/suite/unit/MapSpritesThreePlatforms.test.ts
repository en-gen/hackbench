/**
 * Sprite $E0 on the map (the $E0 issue): the loader's three-platform command is drawn as ONE sprite at its list
 * index whose parts are the three $A3 platforms, from the ROM's own spawner run on the core. Synthetic cart
 * (syntheticPlatforms.ts, CI has no ROM): what is asserted is that the drawer runs the cart's routine and INIT.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import type { RomFile } from '../../../src/rom/RomFile'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import { interpDrawer } from '../../../theia/extension/src/node/map-sprites'
import { eeriesSeed } from '../support/syntheticEeries'
import {
  ANGLE_TABLE_AT,
  platformCart,
  SPAWNER_AT,
  SYNTHETIC_PLATFORM_ROUTINES,
} from '../support/syntheticPlatforms'

/** The $E0 entry the fixture's list holds: data byte $51 (Y $150 = 336), screen 3 column $B (X 944). */
const entry: LevelSprite = { screen: 3, x: 59, y: 21, spriteId: 0xe0, extraBit: false, raw: [0x51, 0xb3, 0xe0], index: 4, streamOffset: 0 } // prettier-ignore
const model = { isVertical: false, screenCount: 16 }

const draw = (rom: RomFile = platformCart(), vertical = false) =>
  interpDrawer(rom, 0x21, { ...model, isVertical: vertical }, runOnce, () => eeriesSeed(100), undefined, undefined, SYNTHETIC_PLATFORM_ROUTINES as never)(entry) // prettier-ignore

function ok(r: ReturnType<typeof draw>) {
  if (!r.ok) throw new Error(`not drawn: ${JSON.stringify(r)}`)
  return r
}

describe('sprite $E0 on the map', () => {
  // The cart's MAIN shifts each piece right by its angle & $70 and INIT sets bit 7 of the angle: three platforms at 16, 32, 48.
  const xs = (r: ReturnType<typeof ok>) =>
    [...new Set(r.parts.map(p => p.dx))].sort((a, b) => a - b)

  it('draws three platforms from one placement, not a placeholder', () => {
    const r = ok(draw())
    expect(r.parts).toHaveLength(3 * 4) // each platform is one 16 x 16 piece, four chars
    expect(r.anchor).toEqual({ x: 944, y: 336 })
    expect(xs(r)).toEqual([16, 24, 32, 40, 48, 56])
    expect(r.unverified).toBeUndefined()
    expect(r.note).toBeUndefined()
  })

  it('takes the angles from the cart table: a moved entry moves its platform', () => {
    const rom = platformCart()
    rom.writeAt(ANGLE_TABLE_AT + 1, [0x44]) // the second angle $22 -> $44: shifted $40 instead of $20
    expect(xs(ok(draw(rom)))).toEqual([16, 24, 48, 56, 64, 72])
  })

  it('draws in a vertical map, flagged unverified, at the entry (the loader hands the spawner the Y boundary as X)', () => {
    const r = ok(draw(platformCart(), true))
    expect(r.parts).toHaveLength(3 * 4)
    expect(r.anchor).toEqual({ x: 944, y: 336 })
    expect(r.unverified).toMatch(/vertical map the spawner is given the entry's Y as its X/)
    // The horizontal map names nothing: the flag is the vertical input's, not the cart's.
    expect(ok(draw()).unverified).toBeUndefined()
    // The cart puts each platform at the spawner's X plus its angle; X is the boundary 336, so the pieces sit 944 - 336 left of the horizontal ones,
    // measured from the entry's own X (re-anchored by `at`, not by the boundary).
    expect(xs(r)).toEqual(xs(ok(draw())).map(x => x - (944 - 336)))
  })

  it('is refused, with the reason, when the level loader gave no image: SpriteDataPtr was never set', () => {
    const noImage = () => {
      const seed = eeriesSeed(100)
      delete seed.loaded
      return { ...seed, loadRefusal: 'loader entry moved' }
    }
    const r = interpDrawer(platformCart(), 0x21, model, runOnce, noImage, undefined, undefined, SYNTHETIC_PLATFORM_ROUTINES as never)(entry) // prettier-ignore
    expect(r.ok).toBe(false)
    expect(!r.ok && 'reason' in r && r.reason).toMatch(/level loader's image: loader entry moved/)
  })

  it('draws a changed spawner and says so (D52), never blank', () => {
    const rom = platformCart()
    rom.writeAt(SPAWNER_AT + 80, [0x02]) // the count's immediate, 3 -> 2: two platforms, and the hash differs
    const r = ok(draw(rom))
    expect(r.parts).toHaveLength(2 * 4)
    expect(r.unverified).toMatch(/^the three platforms are drawn from the spawner the loader calls, and the platform spawner is not the vanilla shape/) // prettier-ignore
    expect(r.note).toBe('Only 2 of the 3 platforms appear.')
  })

  it('is a marker with a reason when the spawner never returns', () => {
    const rom = platformCart()
    rom.writeAt(SPAWNER_AT, [0x4c, 0x33, 0xaf]) // JMP to itself
    const r = draw(rom)
    expect(r.ok).toBe(false)
    expect(!r.ok && 'reason' in r && r.reason).toMatch(/step budget/)
  })

  it('says what it assumed when the spawner is changed: its children are taken to be platforms', () => {
    const rom = platformCart()
    rom.writeAt(SPAWNER_AT + 80, [0x02])
    expect(ok(draw(rom)).unverified).toMatch(/the platform spawner is not the vanilla shape, so where its platforms sit and their per-platform values are taken from that edited code and not checked/) // prettier-ignore
  })

  // The slot range of the map's sprite memory setting: from 0 to 4 free slots; the game's answer is min(room, 3).
  it.each([0, 1, 2, 3, 4])(
    'with room for %i slots: min(room, 3) platforms, told in plain words',
    room => {
      const r = draw(platformCart({ room }))
      const n = Math.min(room, 3)
      if (n === 0) {
        expect(r.ok).toBe(false)
        expect(!r.ok && 'reason' in r && r.reason).toBe("None of the 3 platforms appear: this map's sprite memory setting leaves no room.") // prettier-ignore
        return
      }
      const d = ok(r)
      expect(d.parts).toHaveLength(n * 4)
      expect(d.unverified).toBeUndefined()
      if (n < 3)
        expect(d.note).toBe(`Only ${n} of the 3 platforms appear: this map's sprite memory setting leaves room for ${n}.`) // prettier-ignore
      else expect(d.note).toBeUndefined()
    },
  )
})
