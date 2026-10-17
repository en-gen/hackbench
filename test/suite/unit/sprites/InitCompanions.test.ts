/**
 * #840: a sprite whose INIT spawns companions is credited with its own drawing only. The synthetic cart's
 * id 34 spawns id 35 into the sprite slot below, id 37 the one above; both draw one piece in their own slot's OAM entry. The game's
 * loop stores the slot it is on in $15E9 before running it (SMWDisX bank_01.asm:110-125), so a tile byte
 * written while $15E9 names another slot is that slot's.
 */
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { cameraFor, interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
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
  ({ id, where, slot }) => {
    it("are not the spawner's parts: it keeps the piece it drew in its own sprite slot", () => {
      const m = runSprite(rom, id, withSeed({ slot }))
      expect(m.refusal).toBeUndefined()
      expect(m.chosen).toBeDefined()
      expect(m.passes[m.chosen!].parts.map(p => p.oam)).toEqual([firstOf(slot)])
    })

    it("are listed apart as the pass's companions, never merged into parts", () => {
      const m = runSprite(rom, id, withSeed({ slot }))
      const pass = m.passes[m.chosen!]
      expect(pass.companions?.map(p => p.oam)).toEqual([
        firstOf(where === 'below' ? slot - 1 : slot + 1),
      ])
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

describe('a write under a $15E9 that names no spawned slot', () => {
  it('is in neither parts nor companions (the cluster loop shape, #809)', () => {
    const m = runSprite(rom, 38, withSeed({ slot: SLOT }))
    expect(m.refusal).toBeUndefined()
    for (const p of m.passes) {
      expect(p.parts).toEqual([])
      expect(p.companions ?? []).toEqual([])
    }
  })

  it('a sprite that spawns nothing has no companions', () => {
    const m = runSprite(rom, 36, withSeed({ slot: SLOT }))
    expect(m.passes[m.chosen!].companions ?? []).toEqual([])
  })
})

// The map view keeps what the hardware shows (D52): companions are drawn with their spawner, though the grader's
// parts stay the sprite's own. Piece counts are the draw list (a 16 x 16 piece is 4 cells) as origin/develop
// served them before #840: $61 4 pieces (16 cells), $1E 7 pieces (25 cells).
describe.skipIf(!hasRom(VANILLA))('map view companions, vanilla ROM (#840, D52)', () => {
  const view = (map: number, id: number, x: number, y: number) => {
    const sprite = { screen: 0, x: x / 16, y: y / 16, spriteId: id, extraBit: false, raw: [0, 0, 0], index: -1, streamOffset: 0 } // prettier-ignore
    const r = interpDrawer(freshRom(), map, { isVertical: false, screenCount: 20 })(sprite)
    if (!r.ok) throw new Error('reason' in r ? r.reason : r.failure.kind)
    return r.parts.length
  }
  const split = (map: number, id: number, x: number, y: number) => {
    const rom = freshRom()
    const seed = withSeed(
      { sprite: { x, y }, camera: cameraFor(x, y, false, 20) },
      levelSeed(rom, map),
    )
    const run = runOnce(rom, id, seed)
    const pass = run.passes[run.chosen!]!
    return [pass.parts.length, pass.companions?.length ?? 0]
  }
  it('$61 on 10a at 160,384 draws its four skulls (parts 1 + companions 3)', () => {
    expect(view(0x10a, 0x61, 160, 384)).toBe(16)
    expect(split(0x10a, 0x61, 160, 384)).toEqual([1, 3])
  })
  it('$1E on 1c4 at 1120,224 draws Lakitu and the cloud (7)', () => {
    expect(view(0x1c4, 0x1e, 1120, 224)).toBe(25)
    const [own, comp] = split(0x1c4, 0x1e, 1120, 224)
    expect(own + comp).toBe(7)
    expect(comp).toBeGreaterThan(0)
  })
  it.each([96, 1840])('$B9 on 101 at %i,336 has no companions (the cluster leak stays out)', x => {
    expect(split(0x101, 0xb9, x, 336)).toEqual([1, 0])
  })
})
