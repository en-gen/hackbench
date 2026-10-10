/**
 * The line-guided grinder ($67) is drawn at the first frame after it attaches to its line (#126).
 * Synthetic cart: ids 31 and 103 draw one piece at SpriteXPos and then move +4 (hand-written opcodes),
 * so CI (no cart) proves the rule picks the second drawn pass for $67 only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../../theia/extension/src/node/map-sprites'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const run = (id: number) => runOnce(buildSyntheticRom(), id, seed)

describe('line-guided draw pass', () => {
  it('draws another id at its first pass, at the position the draw ran', () => {
    const m = run(31)
    expect(m.chosen).toBe(0)
    expect(m.anchor!.x).toBe(0x80)
    expect(m.passes[0]!.parts[0]!.dx).toBe(0)
  })

  it('draws $67 at the second pass, with the anchor where that draw happened (draw, then move)', () => {
    const [a, g] = [run(31), run(103)]
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
    // The same OAM X as the other id's second pass, and the body is centred on the anchor it reports.
    const part = g.passes[1]!.parts[0]!
    expect(part.ox).toBe(a.passes[1]!.parts[0]!.ox)
    expect(part.ox).toBe(a.passes[0]!.parts[0]!.ox + 4)
    expect(part.dx).toBe(0)
  })
})

/**
 * Every vanilla $67, in stream order, as [x, y] where the first MAIN left it (INIT spot plus the winning probe
 * corner, bank_01.asm:12045), or null where the run erases it (a placement the INIT shift sends offscreen; a
 * known follow-up, pinned here so it cannot change unnoticed). Measured on the vanilla ROM with this runner;
 * slot $1F's first grinder (sprite slot 7, x 419) also matches the Mesen sprite-trace capture of its first MAIN call.
 */
const GRINDERS: Record<number, ([number, number] | null)[]> = {
  0x1a: [[739, 356], null, [931, 356], null, null, [1371, 308], [1499, 324], [1723, 340], [1859, 324], [1923, 372], [2075, 260], [2179, 276], [2243, 292]], // prettier-ignore
  0x1f: [
    [419, 340],
    [547, 324],
    [707, 340],
    [827, 324],
    [1083, 324],
    [1243, 308],
    [1307, 292],
  ],
}

describe.skipIf(!hasRom(VANILLA))('every vanilla grinder, on the vanilla ROM', () => {
  for (const [slot, want] of Object.entries(GRINDERS)) {
    it(`slot $${Number(slot).toString(16)}: ${want.length} placements drawn where the line snap left them`, () => {
      const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
      const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), Number(slot))
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      const got = r.sprites.filter(d => d.id === 0x67)
      expect(got).toHaveLength(want.length)
      got.forEach((d, i) => {
        const w = want[i]!
        if (w === null) expect(d.status, `#${i}`).toBe('placeholder')
        else {
          expect(d.status, `#${i}`).toBe('drawn')
          expect([d.x, d.y], `#${i}`).toEqual(w)
        }
      })
    }, 120_000)
  }
})
