/**
 * The line-guided grinder ($67) is drawn where the line walk puts it, two passes after its first draw (#126); so are $62, $65, $66
 * and $68, by their own shape checks (#792; $64 is not admitted: INIT already steps it onto the track).
 * Synthetic cart: ids 31 and 103 draw one piece at SpriteXPos and then move +4 (hand-written opcodes),
 * so CI (no cart) proves the rule picks the third drawn pass for the admitted ids only.
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
  VANILLA_DISPATCH,
  DISPATCH_PINNED,
  ENTRY_PINNED,
  lineDrawsBeforeSnap,
  PLAT_ARM,
  PRELUDE_LEN,
  PRELUDE_OPERANDS,
} from '../../../../src/rom/sprites/interp/LineGuided'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { hasRom, romPath, SPRITE_TRACE_SET, TOOLS_ROOT, VANILLA } from '../../support/corpus'
import {
  CHAINSAW_HANDLER,
  GRINDER_DISPATCH_AT,
  GRINDER_DISPATCH,
  GRINDER_HANDLER,
  JMP_HANDLER,
} from '../../support/syntheticGrinder'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const run = (id: number, o: SyntheticOptions = {}) =>
  runOnce(buildSyntheticRom(o), id, seed, { lineDispatch: GRINDER_DISPATCH })

/** Whether the gate still accepts `id` at `handler` after XOR-ing the byte at `at` with `x`. */
const flipped = (id: number, handler: number, at: number, x = 0x01) => {
  const rom = buildSyntheticRom()
  rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ x])
  return lineDrawsBeforeSnap(rom, id, handler, GRINDER_DISPATCH)
}

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
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    const g = runOnce(rom, 103, seed, { lineDispatch: GRINDER_DISPATCH })
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
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    const g = runOnce(rom, 103, seed, { lineDispatch: GRINDER_DISPATCH })
    expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, true])
    expect(g.passes[1]!.pos).toEqual(g.passes[0]!.pos)
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
  })

  it('gives the snap rule to the admitted ids only: another id whose MAIN is the grinder handler is generic', () => {
    const rom = buildSyntheticRom({ id31IsGrinder: true })
    // The alias passes the shape gate, so the id check alone is what keeps id 31 generic.
    expect(lineDrawsBeforeSnap(rom, 103, 0x019500, GRINDER_DISPATCH)).toBe(true)
    const g = run(31, { id31IsGrinder: true })
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
  })

  it('accepts the cart it was fingerprinted on, and no other', () => {
    const rom = buildSyntheticRom()
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
    // The default digest is vanilla's: the synthetic handler is not it.
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER)).toBe(false)
  })

  it('refuses a changed byte at every pinned offset of the entry and of the dispatch span', () => {
    const flip = (at: number) => flipped(103, GRINDER_HANDLER, at)
    expect(ENTRY_PINNED).toHaveLength(14)
    expect(DISPATCH_PINNED).toHaveLength(28)
    for (const i of ENTRY_PINNED) expect(flip(GRINDER_HANDLER + i), `entry +${i}`).toBe(false)
    for (const i of DISPATCH_PINNED)
      expect(flip(GRINDER_DISPATCH_AT + i), `dispatch +${i}`).toBe(false)
  })

  it('refuses a changed call or jump target: every target operand byte, low and high, several values', () => {
    const TARGET_OPERANDS = [15, 16, 24, 25, 27, 28, 32, 33, 35, 36, 37, 39, 40]
    const flip = (at: number, x: number) => flipped(103, GRINDER_HANDLER, at, x)
    const accepted = TARGET_OPERANDS.flatMap(i =>
      [0x01, 0x10, 0x7f, 0xff].filter(x => flip(GRINDER_DISPATCH_AT + i, x)).map(x => `+${i}^${x}`),
    )
    expect(accepted).toEqual([])
  })

  it('reads a call target through the FastROM mirror: a JSL to bank $81, or the handler at $81, is the same routine', () => {
    const rom = buildSyntheticRom()
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER | 0x800000, GRINDER_DISPATCH)).toBe(true)
    rom.writeAt(GRINDER_DISPATCH_AT + 37, [0x81])
    expect(lineDrawsBeforeSnap(rom, 103, GRINDER_HANDLER, GRINDER_DISPATCH)).toBe(true)
  })

  // Synthetic ids 98/104 enter by a bare JMP, 101/102 through the chainsaw prelude; the handler differs per id, the dispatch is shared.
  const ADMITTED: [number, number][] = [[98, JMP_HANDLER], [101, CHAINSAW_HANDLER], [102, CHAINSAW_HANDLER], [104, JMP_HANDLER]] // prettier-ignore

  it.each(ADMITTED)('draws id %i at the third pass, where the line walk left it', id => {
    const g = run(id)
    expect(g.passes.slice(0, 3).map(p => p.origin.x)).toEqual([0x80, 0x84, 0x88])
    expect(g.chosen).toBe(2)
    expect(g.anchor!.x).toBe(0x88)
  })

  it.each(ADMITTED)(
    'keeps pass 0 for id %i when pass 2 draws nothing (grinder id 103 alone may stop at pass 1)',
    id => {
      const g = run(id, { grinderDrawsTwice: true })
      expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, false])
      expect(g.chosen).toBe(0)
      expect(g.anchor!.x).toBe(0x80)
      expect(g.lineStepReason).toMatch(/third pass/)
    },
  )

  it.each(ADMITTED)(
    'keeps pass 0 for id %i when the first MAIN moved it but the second did not, though pass 2 draws',
    id => {
      // Twin of the grinder test above: the step moves +4 on its first call only, so moved(q0, q1) is false.
      const rom = buildSyntheticRom()
      rom.writeAt(0x019290, [0xfe, 0x50, 0x16, 0xbd, 0x50, 0x16, 0xc9, 0x02, 0x90, 0x01, 0x60, 0xb5, 0xe4, 0x18, 0x69, 0x04, 0x95, 0xe4, 0x60]) // prettier-ignore
      const g = runOnce(rom, id, seed, { lineDispatch: GRINDER_DISPATCH })
      expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, true])
      expect(g.passes[1]!.pos).toEqual(g.passes[0]!.pos)
      expect(g.chosen).toBe(0)
      expect(g.anchor!.x).toBe(0x80)
      expect(g.lineStepReason).toMatch(/third pass/)
    },
  )

  it.each(ADMITTED)(
    'draws id %i at its first pass when the dispatch is not the vanilla shape',
    id => {
      const g = run(id, { alteredGrinder: true })
      expect(g.chosen).toBe(0)
      expect(g.anchor!.x).toBe(0x80)
    },
  )

  it('admits $62, $65, $66, $68 and $67 only: $64 has the prelude and the dispatch, and is refused', () => {
    const rom = buildSyntheticRom()
    for (const [id, at] of ADMITTED) expect(lineDrawsBeforeSnap(rom, id, at, GRINDER_DISPATCH), `id ${id}`).toBe(true) // prettier-ignore
    expect(lineDrawsBeforeSnap(rom, 100, CHAINSAW_HANDLER, GRINDER_DISPATCH)).toBe(false)
    // The entry kind is the id's: a JMP entry for a chainsaw id, and a chainsaw entry for a JMP id, are refused.
    expect(lineDrawsBeforeSnap(rom, 101, JMP_HANDLER, GRINDER_DISPATCH)).toBe(false)
    expect(lineDrawsBeforeSnap(rom, 98, CHAINSAW_HANDLER, GRINDER_DISPATCH)).toBe(false)
  })

  it('refuses a changed byte in the chainsaw prelude, or in the platform arm, apart from its free operands', () => {
    // Literal offsets, so editing the exported constants is itself caught. Only the prelude's table address (22, 23) is
    // left free; its JSR target (31, 32) and the arm's two JSR targets (46, 47 and 66, 67) are compared to routines.
    const hit = Array.from({ length: PRELUDE_LEN }, (_, i) => i).filter(i => flipped(101, CHAINSAW_HANDLER, CHAINSAW_HANDLER + i)) // prettier-ignore
    expect(PRELUDE_LEN).toBe(33)
    expect(PRELUDE_OPERANDS).toEqual([22, 23, 31, 32])
    expect(hit).toEqual([22, 23])
    // The platform arm sits at $019700, 68 bytes.
    expect(PLAT_ARM).toEqual({ len: 68, draw: 46, step: 66 })
    const arm = Array.from({ length: 68 }, (_, i) => i).filter(i => flipped(98, JMP_HANDLER, 0x019700 + i)) // prettier-ignore
    expect(arm).toEqual([])
  })

  it('refuses a hijacked prelude call, platform-arm draw call or step call', () => {
    for (const x of [0x01, 0x10, 0x7f, 0xff]) {
      for (const i of [31, 32]) expect(flipped(101, CHAINSAW_HANDLER, CHAINSAW_HANDLER + i, x), `prelude +${i}^${x}`).toBe(false) // prettier-ignore
      for (const i of [46, 47, 66, 67]) expect(flipped(98, JMP_HANDLER, 0x019700 + i, x), `arm +${i}^${x}`).toBe(false) // prettier-ignore
    }
  })

  it('admits exactly $62, $65, $66, $67, $68 over every id 0..255', () => {
    const rom = buildSyntheticRom()
    // Every id is offered each synthetic entry shape; only the five route ids may pass, and only with their own entry kind.
    const entries = [JMP_HANDLER, CHAINSAW_HANDLER, GRINDER_HANDLER]
    const admitted = Array.from({ length: 256 }, (_, id) => id).filter(id => entries.some(h => lineDrawsBeforeSnap(rom, id, h, GRINDER_DISPATCH))) // prettier-ignore
    expect(admitted).toEqual([0x62, 0x65, 0x66, 0x67, 0x68])
  })

  it('refuses $62 when the platform arm is not reached by a JMP (0x4C), though the digest still matches', () => {
    const rom = buildSyntheticRom()
    // The byte after the 41-byte span is the digest's blind spot: the BCC at 8 lands on it.
    rom.writeAt(GRINDER_DISPATCH_AT + 41, [0x20])
    expect(lineDrawsBeforeSnap(rom, 98, JMP_HANDLER, GRINDER_DISPATCH)).toBe(false)
  })

  it('refuses a bare-JMP entry whose opcode is changed to a JML (0x5C)', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(JMP_HANDLER, [0x5c])
    expect(lineDrawsBeforeSnap(rom, 104, JMP_HANDLER, GRINDER_DISPATCH)).toBe(false)
    expect(lineDrawsBeforeSnap(rom, 98, JMP_HANDLER, GRINDER_DISPATCH)).toBe(false)
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
          const tile = grid[d.y >> 4]?.[d.x >> 4] ?? -1
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

/** The first placement of each admitted id on the vanilla ROM, where the line walk leaves it: [map, id, x, y]. */
const ON_TRACK: [number, number, number, number][] = [[0x05, 0x62, 639, 304], [0x05, 0x68, 2559, 239], [0x0f, 0x65, 495, 384], [0x0f, 0x66, 4015, 208]] // prettier-ignore

describe.skipIf(!hasRom(VANILLA))(
  'line-guided $62, $65, $66, $68 on the vanilla ROM (#792)',
  () => {
    it.each(ON_TRACK)(
      'map %i (decimal), sprite id %i (decimal): the first is drawn at (%i, %i)',
      (slot, id, x, y) => {
        const path = romPath(VANILLA)
        const r = mapSprites(new L1ModelCache(), new Uint8Array(readFileSync(path)), path, slot)
        expect(r.status).toBe('ok')
        if (r.status !== 'ok') return
        const first = r.sprites.find(d => d.id === id)!
        expect([first.status, first.x, first.y]).toEqual(['drawn', x, y])
      },
      120_000,
    )
  },
)

const SWEEP_IDS = [0x62, 0x65, 0x66, 0x68]
/** Every vanilla placement of $62, $65, $66, $68: placements, those the rule moved, and the shifts it made. */
const SWEEP: Record<number, { total: number; moved: number; dx: number[]; dy: number[] }> = {
  0x62: { total: 6, moved: 4, dx: [0, 15], dy: [0, 5, 15] },
  0x65: { total: 32, moved: 24, dx: [-15, 0, 16], dy: [0, 15] },
  0x66: { total: 1, moved: 1, dx: [16], dy: [0] },
  0x68: { total: 37, moved: 28, dx: [0, 11, 16], dy: [0, 4, 15] },
}

describe.skipIf(!hasRom(VANILLA))('every vanilla $62, $65, $66, $68 (#792)', () => {
  it('moves each placement onto a line tile (Map16 $76-$99, bank_01.asm:12000-12004) and pins how many move', () => {
    const path = romPath(VANILLA)
    const bytes = new Uint8Array(readFileSync(path))
    const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
    // Discovery by the sprite streams of all 512 maps, so a map the list below misses fails the totals.
    const slots: number[] = []
    const total = new Map<number, number>()
    for (let slot = 0; slot < 0x200; slot++) {
      const ptr = rom.getLevelSpritePointer(slot)
      if (ptr === null) continue
      const ids = parseLevelSprites(readStream(rom.rom, ptr), false).map(x => x.spriteId).filter(i => SWEEP_IDS.includes(i)) // prettier-ignore
      if (ids.length) slots.push(slot)
      for (const i of ids) total.set(i, (total.get(i) ?? 0) + 1)
    }
    expect(slots).toEqual([5, 15, 300])
    expect(Object.fromEntries(total)).toEqual(Object.fromEntries(SWEEP_IDS.map(i => [i, SWEEP[i]!.total]))) // prettier-ignore
    const got: typeof SWEEP = Object.fromEntries(SWEEP_IDS.map(i => [i, { total: 0, moved: 0, dx: [], dy: [] }])) // prettier-ignore
    const old = { ...VANILLA_DISPATCH, sha: 'no gate match: the generic rule' }
    for (const slot of slots) {
      const built = new L1ModelCache().get(bytes, path, slot, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const grid = built.inputs.grid as number[][]
      const mapped = mapSprites(new L1ModelCache(), bytes, path, slot)
      if (mapped.status !== 'ok') throw new Error(`slot ${slot}: ${mapped.status}`)
      const drawn = mapped.sprites.filter(d => SWEEP_IDS.includes(d.id))
      const placements = parseLevelSprites(readStream(rom.rom, rom.getLevelSpritePointer(slot)!), built.inputs.isVertical).filter(x => SWEEP_IDS.includes(x.spriteId)) // prettier-ignore
      let last: { now: SpriteModel; before: SpriteModel } | undefined
      const draw = interpDrawer(rom.rom, slot, built.inputs, (r, id, sd) => {
        const now = runOnce(r, id, sd)
        // The probe-camera run (map-sprites.ts) calls back again for the same placement; the first call is the main run.
        last ??= { now, before: runOnce(r, id, sd, { lineDispatch: old }) }
        return now
      })
      placements.forEach((p, i) => {
        last = undefined
        draw(p)
        const [a, b] = [last!.now.anchor, last!.before.anchor]
        const g = got[p.spriteId]!
        g.total++
        if (!a || !b) throw new Error(`slot ${slot} #${i}: no anchor`)
        if (a.x === b.x && a.y === b.y) {
          // Unmoved: the pass chosen may differ (animation frame), but it must draw from the generic rule's origin.
          const [n, o] = [last!.now, last!.before]
          expect(n.passes[n.chosen ?? 0]?.origin, `slot ${slot} #${i} unmoved`).toEqual(o.passes[o.chosen ?? 0]?.origin) // prettier-ignore
          return
        }
        g.moved++
        g.dx.push(a.x - b.x)
        g.dy.push(a.y - b.y)
        // The placement the map shows is the one this model chose; it must sit inside a tile of the game's line range.
        const d = drawn[i]!
        const tile = grid[d.y >> 4]?.[d.x >> 4] ?? -1
        const where = `slot ${slot} #${i} id $${p.spriteId.toString(16)} (${d.x},${d.y}) tile $${tile.toString(16)}`
        expect(d.status, where).toBe('drawn')
        expect(tile >= 0x76 && tile <= 0x99, where).toBe(true)
        if (LINE_EDGE[tile]) expect(LINE_EDGE[tile]!(d.x & 15, d.y & 15), where).toBe(true)
      })
    }
    const sorted = (v: number[]) => [...new Set(v)].sort((x, y) => x - y)
    const summary = Object.fromEntries(SWEEP_IDS.map(i => [i, { total: got[i]!.total, moved: got[i]!.moved, dx: sorted(got[i]!.dx), dy: sorted(got[i]!.dy) }])) // prettier-ignore
    const want = Object.fromEntries(SWEEP_IDS.map(i => [i, { ...SWEEP[i]!, dx: sorted(SWEEP[i]!.dx), dy: sorted(SWEEP[i]!.dy) }])) // prettier-ignore
    expect(summary).toEqual(want)
  }, 300_000)
})
