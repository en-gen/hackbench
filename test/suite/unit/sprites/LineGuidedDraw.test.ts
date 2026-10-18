/**
 * The line-guided grinder ($67) is drawn where the line walk puts it, two passes after its first draw (#126).
 * Synthetic cart: ids 31 and 103 draw one piece at SpriteXPos and then move +4 (hand-written opcodes),
 * so CI (no cart) proves the rule picks the third drawn pass for $67 only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  grinderDrawsBeforeSnap,
} from '../../../../src/rom/sprites/interp/LineGuided'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { hasRom, romPath, SPRITE_TRACE_SET, TOOLS_ROOT, VANILLA } from '../../support/corpus'
import {
  GRINDER_DISPATCH_AT,
  GRINDER_DISPATCH,
  GRINDER_HANDLER,
} from '../../support/syntheticGrinder'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const run = (id: number, o: SyntheticOptions = {}) =>
  runOnce(buildSyntheticRom(o), id, seed, { grinderDispatch: GRINDER_DISPATCH })

describe('line-guided draw pass', () => {
  it('draws another id at its first pass, at the position the draw ran', () => {
    const m = run(31)
    expect(m.chosen).toBe(0)
    expect(m.anchor!.x).toBe(0x80)
    expect(m.passes[0]!.parts[0]!.dx).toBe(0)
  })

  it('draws $67 at the third pass, with the anchor where that draw happened (draw, then move)', () => {
    const [a, g] = [run(31), run(103)]
    expect(g.chosen).toBe(2)
    expect(g.anchor!.x).toBe(0x88)
    // The same OAM X as the other id's third pass, and the body is centred on the anchor it reports.
    const part = g.passes[2]!.parts[0]!
    expect(part.ox).toBe(a.passes[2]!.parts[0]!.ox)
    expect(part.ox).toBe(a.passes[0]!.parts[0]!.ox + 8)
    expect(part.dx).toBe(0)
  })

  it('stops at the second pass when the third draws nothing', () => {
    const g = run(103, { grinderDrawsTwice: true })
    expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, false])
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
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

  it('keeps pass 0 when the line step does not move the sprite: no "on-track" claim for an unmoved draw', () => {
    // The call targets and fingerprint still match, but the step routine at $019290 is RTS.
    const rom = buildSyntheticRom()
    rom.writeAt(0x019290, [0x60])
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    const g = runOnce(rom, 103, seed, { grinderDispatch: GRINDER_DISPATCH })
    expect(g.passes[1]!.parts).toHaveLength(1)
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
    expect(g.lineStepReason).toMatch(/did not move/)
    // The inverse: the unmodified cart (step is the +4 move) still advances and gives no reason.
    expect(run(103).lineStepReason).toBeUndefined()
  })

  it('puts the anchor where the chosen draw ran when only pass 1 draws: where the generic id lands', () => {
    const [g, other] = [run(103, { grinderDrawsOnPass1: true }), run(32)]
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
    const at = (m: typeof g) => m.anchor!.x + m.passes[m.chosen!]!.parts[0]!.dx
    expect(at(g)).toBe(0x84)
    expect(at(g)).toBe(at(other))
  })

  it('keeps a $67 that first draws on pass 1 at that pass: it is already on its track', () => {
    const g = run(103, { grinderDrawsFromPass1: true })
    expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([false, true, true])
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
  })

  it('keeps pass 1 when the first MAIN moved the sprite but the second did not, though pass 2 draws', () => {
    // The step routine at $019290 moves +4 on its first call only (count in $1650,X), then returns: pass 0 -> 0x84, pass 1 -> 0x84.
    // Dropping the moved(q0, q1) guard, or testing q0 against the anchor instead, would pick pass 2.
    const rom = buildSyntheticRom()
    rom.writeAt(0x019290, [0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, 0xc9, 0x02, 0x90, 0x01, 0x60, 0xb5, 0xe4, 0x18, 0x69, 0x04, 0x95, 0xe4, 0x60]) // prettier-ignore
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    const g = runOnce(rom, 103, seed, { grinderDispatch: GRINDER_DISPATCH })
    expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, true])
    expect(g.passes[1]!.pos).toEqual(g.passes[0]!.pos)
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
  })

  it('applies the snap rule to id $67 only: another id whose MAIN is the grinder handler is generic', () => {
    const rom = buildSyntheticRom({ id31IsGrinder: true })
    // The alias passes the shape gate, so the id check alone is what keeps id 31 generic.
    expect(grinderDrawsBeforeSnap(rom, 0x019500, GRINDER_DISPATCH)).toBe(true)
    const g = run(31, { id31IsGrinder: true })
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
  })

  it('accepts the cart it was fingerprinted on, and no other', () => {
    const rom = buildSyntheticRom()
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    // The default digest is vanilla's: the synthetic handler is not it.
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER)).toBe(false)
  })

  it('refuses a changed byte at every pinned offset of the dispatch span', () => {
    const flip = (at: number) => {
      const rom = buildSyntheticRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x01])
      return grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)
    }
    expect(DISPATCH_PINNED).toHaveLength(28)
    for (const i of DISPATCH_PINNED)
      expect(flip(GRINDER_DISPATCH_AT + i), `dispatch +${i}`).toBe(false)
  })

  it('refuses a changed call or jump target: every target operand byte, low and high, several values', () => {
    const TARGET_OPERANDS = [15, 16, 24, 25, 27, 28, 32, 33, 35, 36, 37, 39, 40]
    const flip = (at: number, x: number) => {
      const rom = buildSyntheticRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ x])
      return grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)
    }
    const accepted = TARGET_OPERANDS.flatMap(i =>
      [0x01, 0x10, 0x7f, 0xff].filter(x => flip(GRINDER_DISPATCH_AT + i, x)).map(x => `+${i}^${x}`),
    )
    expect(accepted).toEqual([])
  })

  it('reads a call target through the FastROM mirror: a JSL to bank $81, or the handler at $81, is the same routine', () => {
    const rom = buildSyntheticRom()
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER | 0x800000, GRINDER_DISPATCH)).toBe(true)
    rom.writeAt(GRINDER_DISPATCH_AT + 37, [0x81])
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
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
 * Every vanilla $67, in stream order, as [x, y] where the line walk left it after the second MAIN: the spot the
 * third pass draws at, on the line (SMWDisX bank_01.asm:11863-11930), or null where the run erases it: not yet
 * investigated, #793 (hypothesis: INIT moves X by -$140, bank_01.asm:11793-11799, away from the spawn-centred
 * camera); pinned here so it cannot change unnoticed. Measured on the vanilla ROM with this runner.
 */
const GRINDERS: Record<number, ([number, number] | null)[]> = {
  0x1a: [[751, 367], null, [943, 367], null, null, [1360, 319], [1503, 335], [1727, 351], [1871, 335], [1935, 368], [2079, 271], [2176, 287], [2255, 303]], // prettier-ignore
  0x1f: [
    [431, 336],
    [559, 320],
    [719, 336],
    [816, 335],
    [1072, 335],
    [1232, 319],
    [1311, 303],
  ],
}

/**
 * Where a line tile draws its line inside its 16x16 cell (the tile pictures of slots $1A and $1F, rendered
 * and read as numbers): $90 at x 0, $91 at x 15, $92 at y 0, $93 at y 15.
 */
const LINE_EDGE: Record<number, (x: number, y: number) => boolean> = {
  0x90: x => x === 0,
  0x91: x => x === 15,
  0x92: (_, y) => y === 0,
  0x93: (_, y) => y === 15,
}

// Needs no ROM: an empty or truncated table would otherwise leave the sweep below asserting nothing.
it('the grinder table covers both configured slots, $1a and $1f', () => {
  expect(Object.keys(GRINDERS).sort()).toEqual([String(0x1a), String(0x1f)])
})

describe.skipIf(!hasRom(VANILLA))('every vanilla grinder, on the vanilla ROM', () => {
  for (const [slot, want] of Object.entries(GRINDERS)) {
    it(`slot $${Number(slot).toString(16)}: ${want.length} placements drawn where the line walk left them`, () => {
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
        expect(m.chosen, `#${i}`).toBe(2)
        const pass = m.passes[2]!
        expect(pass.origin, `#${i}`).toEqual({ x: want[i]![0], y: want[i]![1] })
        // The grinder's own pieces are the lowest OAM entries; slot $1F's level also draws four more, not yet explained (#793).
        const body = [...pass.parts].sort((a, b) => a.oam - b.oam).slice(0, 4)
        expect(body.map(q => [q.dx, q.dy]).sort(), `#${i}`).toEqual([[-16, -16], [-16, 0], [0, -16], [0, 0]]) // prettier-ignore
      })
    }, 120_000)
  }
})

describe.skipIf(!hasRom(VANILLA))('line-guided grinder sweep (all 17 drawn, vanilla)', () => {
  it('draws each one on the edge of its line tile', () => {
    // Proves "on the line" only: every point of a line tile's edge is a cell corner, so this cannot tell pass 2
    // from pass 3. The GRINDERS table above and the Mesen capture test below pin which pass.
    const path = romPath(VANILLA)
    const bytes = new Uint8Array(readFileSync(path))
    let drawn = 0
    // The 3 undrawn $1A grinders (indices 1, 3, 4) are #793, not this rule: GRINDERS marks them null.
    for (const slot of [0x1a, 0x1f]) {
      const built = new L1ModelCache().get(bytes, path, slot, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const grid = built.inputs.grid as number[][]
      const r = mapSprites(new L1ModelCache(), bytes, path, slot)
      if (r.status !== 'ok') throw new Error(`slot ${slot}: ${r.status}`)
      r.sprites
        .filter(d => d.id === 0x67 && d.status === 'drawn')
        .forEach(d => {
          const tile = (grid[d.y >> 4]?.[d.x >> 4] ?? -1) & 0xff
          const on = LINE_EDGE[tile]
          expect(on, `slot ${slot} (${d.x},${d.y}): tile $${tile.toString(16)} is not a line-guide tile`).toBeDefined() // prettier-ignore
          expect(on!(d.x & 15, d.y & 15), `slot ${slot} (${d.x},${d.y}) tile $${tile.toString(16)}`).toBe(true) // prettier-ignore
          drawn++
        })
    }
    expect(drawn).toBe(17)
  }, 120_000)
})

const TRACE_SLOT_7 = join(TOOLS_ROOT, 'fixtures', 'sprite-trace', SPRITE_TRACE_SET, '01f')

describe.skipIf(!hasRom(VANILLA) || !existsSync(TRACE_SLOT_7))(
  'Mesen capture, slot $1F grinder in sprite slot 7',
  () => {
    it('is drawn where the capture left it after the line pull, (431,336)', () => {
      // The capture's WRAM snapshots are 8 KiB per call, taken as the next call starts. Sprite slot 7 reads
      // (400,336) after the load, (415,336) after INIT, (419,340) after the first MAIN and (431,336) after the second.
      const calls = JSON.parse(readFileSync(join(TRACE_SLOT_7, 'calls.json'), 'utf8')) as { slot: number; kind: string; wram: number }[] // prettier-ignore
      const wram = readFileSync(join(TRACE_SLOT_7, 'wram.bin'))
      const at = (k: number) => [wram[k * 8192 + 0xe4 + 7]! | (wram[k * 8192 + 0x14e0 + 7]! << 8), wram[k * 8192 + 0xd8 + 7]! | (wram[k * 8192 + 0x14d4 + 7]! << 8)] // prettier-ignore
      const mains = calls.filter(c => c.slot === 7 && c.kind === 'main')
      expect(mains).toHaveLength(2)
      expect(at(mains[0]!.wram)).toEqual([415, 336])
      expect(at(mains[1]!.wram)).toEqual([419, 340])
      // The snapshot after the second MAIN is the next call's: take it from calls.json, not from index arithmetic.
      const next = calls[calls.indexOf(mains[1]!) + 1]
      expect(next, 'a call follows slot 7 second MAIN').toBeDefined()
      const lastWram = next!.wram
      expect(lastWram).toBe(mains[1]!.wram + 1)
      expect(at(lastWram)).toEqual([431, 336])
      const r = mapSprites(
        new L1ModelCache(),
        new Uint8Array(readFileSync(romPath(VANILLA))),
        romPath(VANILLA),
        0x1f,
      )
      if (r.status !== 'ok') throw new Error(r.status)
      const first = r.sprites.filter(d => d.id === 0x67)[0]!
      expect([first.x, first.y]).toEqual(at(lastWram))
    }, 120_000)
  },
)
