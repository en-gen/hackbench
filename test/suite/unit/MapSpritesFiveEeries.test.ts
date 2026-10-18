/**
 * Sprite $DE on the map (#1015): the sprite loader's five-Eerie command is drawn as ONE sprite at its list
 * index whose parts are the five Eeries, from the ROM's own spawner run on the core. Synthetic cart (CI has no
 * ROM): the spawner, its tables and sprite $39 are written for this fixture to the game's I/O contract, so what is
 * asserted is that the drawer runs the cart's routine, not that it knows a constant.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import type { RomFile } from '../../../src/rom/RomFile'
import { bytesAt } from '../../../src/rom/sprites/interp/Guards'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import { interpDrawer } from '../../../theia/extension/src/node/map-sprites'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import {
  COUNT_IMMEDIATE_AT,
  eeriesSeed,
  ROUTE_AT,
  SPAWNER_AT,
  SYNTHETIC_EERIES_ROUTINES,
  SYNTHETIC_OFFSETS,
  SYNTHETIC_SPEEDS,
} from '../support/syntheticEeries'

/** The $DE entry the fixture's list holds: data byte $71 (Y $170 = 368), column 4 of screen 3 (X 832). */
const entry: LevelSprite = { screen: 3, x: 52, y: 23, spriteId: 0xde, extraBit: false, raw: [0x71, 0x43, 0xde], index: 5, streamOffset: 0 } // prettier-ignore
const model = { isVertical: false, screenCount: 16 }
const [near, far] = [SYNTHETIC_OFFSETS[0]!, SYNTHETIC_OFFSETS[4]!]

type Options = { stream?: number[]; spacing?: number[]; room?: number }
const draw = (marioX: number, eeries: Options = {}, tweak?: (rom: RomFile) => void) => {
  const rom = buildSyntheticRom({ eeries })
  tweak?.(rom)
  return interpDrawer(rom, 0x21, model, runOnce, () => eeriesSeed(marioX), undefined, SYNTHETIC_EERIES_ROUTINES as never)(entry) // prettier-ignore
}

/** The drawn reply, or the failure with its own words. */
function ok(r: ReturnType<typeof draw>) {
  if (!r.ok) throw new Error(`not drawn: ${JSON.stringify(r)}`)
  return r
}
const extent = (r: ReturnType<typeof ok>) => ({
  x: [Math.min(...r.parts.map(p => p.dx)), Math.max(...r.parts.map(p => p.dx))],
  y: [Math.min(...r.parts.map(p => p.dy)), Math.max(...r.parts.map(p => p.dy))],
})

describe('sprite $DE on the map', () => {
  it('draws five Eeries from one placement, not a placeholder', () => {
    const r = ok(draw(100))
    // Each Eerie is one 16 x 16 piece, drawn as four chars; the anchor is the list entry.
    expect(r.parts).toHaveLength(5 * 4)
    expect(r.anchor).toEqual({ x: 832, y: 368 })
  })

  it('takes the five X offsets from the cart tables: another table, another spread', () => {
    // The widest offsets and the 8 px second column of the widest piece.
    expect(extent(ok(draw(100))).x).toEqual([near, far + 8])
    expect(extent(ok(draw(100, { spacing: [-0x20, -0x10, 0x10, 0x20] }))).x).toEqual([-0x20, 0x20 + 8]) // prettier-ignore
  })

  it('takes Y from the data byte, not from the entry: $A0 is Y 160, $71 is Y 368, $A1 is Y 416', () => {
    expect(extent(ok(draw(100, { stream: [0xa0, 0x43, 0xde, 0xff] }))).y).toEqual([160 - 368, 160 - 368 + 8]) // prettier-ignore
    expect(extent(ok(draw(100))).y).toEqual([0, 8])
    expect(extent(ok(draw(100, { stream: [0xa1, 0x43, 0xde, 0xff] }))).y).toEqual([416 - 368, 416 - 368 + 8]) // prettier-ignore
  })

  it('faces Mario: the speed the cart picks by his side is what the pieces show', () => {
    const chars = (marioX: number) => [...new Set(ok(draw(marioX)).parts.map(p => p.charNum))]
    // Mario left of the Eeries picks the second table entry, right of them the first; the tile is that speed.
    const [left, right] = [chars(100), chars(2000)]
    expect(left).not.toEqual(right)
    expect(left.length).toBe(4)
    expect(right.length).toBe(4)
    expect(Math.min(...left) & 0xff).toBe(SYNTHETIC_SPEEDS.marioLeft)
    expect(Math.min(...right) & 0xff).toBe(SYNTHETIC_SPEEDS.marioRight)
  })

  it('is refused with the reason in a vertical map: the loader hands the spawner the wrong axis', () => {
    const r = interpDrawer(buildSyntheticRom({ eeries: {} }), 0x21, { isVertical: true, screenCount: 16 }, runOnce, () => eeriesSeed(100), undefined, SYNTHETIC_EERIES_ROUTINES as never)(entry) // prettier-ignore
    expect(r.ok).toBe(false)
    expect(!r.ok && 'reason' in r && r.reason).toMatch(/not drawn in a vertical map/)
  })

  it('is refused, with the reason, when the level loader gave no image: SpriteDataPtr was never set', () => {
    const noImage = () => {
      const seed = eeriesSeed(100)
      delete seed.loaded
      return { ...seed, loadRefusal: 'loader entry moved' }
    }
    const rom = buildSyntheticRom({ eeries: {} })
    const r = interpDrawer(rom, 0x21, model, runOnce, noImage, undefined, SYNTHETIC_EERIES_ROUTINES as never)(entry) // prettier-ignore
    expect(r.ok).toBe(false)
    expect(!r.ok && 'reason' in r && r.reason).toMatch(/level loader's image: loader entry moved/)
  })

  // The slot range of the map's sprite memory setting (SpriteSlotMax / SpriteSlotStart): from 0 to 6 free slots.
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'with room for %i slots: min(room, 5) Eeries, the leftmost ones missing, and told in plain words',
    room => {
      const r = draw(100, { room })
      const n = Math.min(room, 5)
      if (n === 0) {
        expect(r.ok).toBe(false)
        expect(!r.ok && 'reason' in r && r.reason).toBe("None of the 5 Eeries appear: this map's sprite memory setting leaves no room.") // prettier-ignore
        return
      }
      const d = ok(r)
      expect(d.parts).toHaveLength(n * 4)
      // The first spawn is the far end of the table; the ones that never exist are the last spawned, the leftmost.
      expect(extent(d).x).toEqual([SYNTHETIC_OFFSETS.slice(5 - n)[0], far + 8])
      expect(d.unverified).toBeUndefined()
      if (n < 5)
        expect(d.note).toBe(`Only ${n} of the 5 Eeries appear: this map's sprite memory setting leaves room for ${n}.`) // prettier-ignore
      else expect(d.note).toBeUndefined()
    },
  )

  // The slot-range reason is only true while the spawner is the game's: a changed one may spawn fewer for its own reasons.
  it('does not blame the sprite memory setting when the spawner itself is changed', () => {
    // Plenty of room (12 slots); the loop counter's immediate 4 -> 3 spawns four.
    const r = ok(draw(100, {}, rom => rom.writeAt(COUNT_IMMEDIATE_AT, [0x03])))
    expect(r.note).toBe('Only 4 of the 5 Eeries appear.')
    expect(r.unverified).toMatch(/the Eerie spawner is not the vanilla shape/)
  })

  it('words a room-0 marker without the reason when the spawner is changed too', () => {
    const r = draw(100, { room: 0 }, rom => rom.writeAt(COUNT_IMMEDIATE_AT, [0x03]))
    expect(!r.ok && 'reason' in r && r.reason).toBe('None of the 5 Eeries appear.')
  })

  it('names the spawner the loader calls in the unverified text, not a vanilla address', () => {
    const repointed = ok(
      draw(100, {}, rom => {
        rom.writeAt(0x02b100, bytesAt(rom, SPAWNER_AT, 97)!)
        rom.writeAt(ROUTE_AT + 10, [0x00, 0xb1])
      }),
    )
    expect(repointed.unverified).toMatch(
      /^the five Eeries are drawn from the spawner the loader calls, and /,
    )
    expect(repointed.unverified).not.toMatch(/vanilla address/)
    // Unchanged route and routine: nothing to say.
    expect(ok(draw(100)).unverified).toBeUndefined()
  })
})
