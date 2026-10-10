/**
 * The line-guided grinder ($67) is drawn at the first frame after it attaches to its line (#126).
 * Synthetic cart: ids 31 and 103 draw one piece at SpriteXPos and then move +4 (hand-written opcodes),
 * so CI (no cart) proves the rule picks the second drawn pass for $67 only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  interpDrawer,
  mapSprites,
  readStream,
} from '../../../../theia/extension/src/node/map-sprites'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import {
  DISPATCH_PINNED,
  ENTRY_PINNED,
  grinderDrawsBeforeSnap,
} from '../../../../src/rom/sprites/interp/LineGuided'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import {
  GRINDER_DISPATCH_AT,
  GRINDER_DISPATCH_SHA,
  GRINDER_HANDLER,
} from '../../support/syntheticGrinder'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const run = (id: number, o: SyntheticOptions = {}) =>
  runOnce(buildSyntheticRom(o), id, seed, { grinderDispatchSha: GRINDER_DISPATCH_SHA })

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

  it('falls back to the first drawn pass when the pass after it draws nothing', () => {
    const g = run(103, { grinderDrawsOnce: true })
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
    expect(g.passes[0]!.parts).toHaveLength(1)
    expect(g.passes[1]!.parts).toHaveLength(0)
  })

  it('leaves another id that first draws on pass 1, and moves every pass, relative to the INIT anchor', () => {
    const g = run(32)
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x80)
    // Drawn after one +4 move: four pixels from the INIT anchor, as every other id's parts are.
    expect(g.passes[1]!.parts[0]!.dx).toBe(4)
    expect(g.passes[1]!.origin.x).toBe(0x80)
  })

  it('draws $67 at the first drawn pass when its handler is not the vanilla shape (a hack)', () => {
    const g = run(103, { alteredGrinder: true })
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
    expect(g.passes[0]!.parts[0]!.dx).toBe(0)
  })

  it('puts the anchor where the chosen draw ran when only pass 1 draws: where the generic id lands', () => {
    const [g, other] = [run(103, { grinderDrawsOnPass1: true }), run(32)]
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
    const at = (m: typeof g) => m.anchor!.x + m.passes[m.chosen!]!.parts[0]!.dx
    expect(at(g)).toBe(0x84)
    expect(at(g)).toBe(at(other))
  })

  it('accepts the cart it was fingerprinted on, and no other', () => {
    const rom = buildSyntheticRom()
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH_SHA)).toBe(true)
    // The default digest is vanilla's: the synthetic handler is not it.
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER)).toBe(false)
  })

  it('refuses a changed byte at every pinned offset of the entry and of the dispatch span', () => {
    const flip = (at: number) => {
      const rom = buildSyntheticRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x01])
      return grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH_SHA)
    }
    expect(ENTRY_PINNED).toHaveLength(14)
    expect(DISPATCH_PINNED).toHaveLength(26)
    for (const i of ENTRY_PINNED) expect(flip(GRINDER_HANDLER + i), `entry +${i}`).toBe(false)
    for (const i of DISPATCH_PINNED)
      expect(flip(GRINDER_DISPATCH_AT + i), `dispatch +${i}`).toBe(false)
  })

  it('reports where each pass drew from: the INIT anchor, or for $67 the position the pass before left', () => {
    expect(
      run(103)
        .passes.slice(0, 3)
        .map(p => p.origin.x),
    ).toEqual([0x80, 0x84, 0x88])
    expect(
      run(31)
        .passes.slice(0, 3)
        .map(p => p.origin.x),
    ).toEqual([0x80, 0x80, 0x80])
  })
})

/**
 * Every vanilla $67, in stream order, as [x, y] where the first MAIN left it (INIT spot plus the winning probe
 * corner, bank_01.asm:12054-12061), or null where the run erases it: not yet investigated (hypothesis: INIT moves X
 * by -$140, bank_01.asm:11793-11799, away from the spawn-centred camera); pinned here so it cannot change unnoticed. Measured on the vanilla ROM with this runner;
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

    it(`slot $${Number(slot).toString(16)}: each drawn grinder's four body pieces sit 16 px around the anchor it reports`, () => {
      const path = romPath(VANILLA)
      const bytes = new Uint8Array(readFileSync(path))
      const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
      const built = new L1ModelCache().get(bytes, path, Number(slot), { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const data = readStream(rom.rom, rom.getLevelSpritePointer(Number(slot))!)
      const ran: SpriteModel[] = []
      const draw = interpDrawer(rom.rom, Number(slot), built.inputs, (r, id, sd) => {
        const m = runOnce(r, id, sd)
        ran.push(m)
        return m
      })
      const grinders = parseLevelSprites(data, built.inputs.isVertical).filter(
        x => x.spriteId === 0x67,
      )
      grinders.forEach((g, i) => {
        draw(g)
        const m = ran.at(-1)!
        if (want[i] === null) return expect(m.chosen, `#${i}`).toBeUndefined()
        expect(m.chosen, `#${i}`).toBe(1)
        const pass = m.passes[1]!
        expect(pass.origin, `#${i}`).toEqual({ x: want[i]![0], y: want[i]![1] })
        // The grinder's own pieces are the lowest OAM entries; slot $1F's level also draws four unrelated ones.
        const body = [...pass.parts].sort((a, b) => a.oam - b.oam).slice(0, 4)
        expect(body.map(q => [q.dx, q.dy]).sort(), `#${i}`).toEqual([[-16, -16], [-16, 0], [0, -16], [0, 0]]) // prettier-ignore
      })
    }, 120_000)
  }
})
