/**
 * The line-guided grinder ($67) run INIT-on is drawn where the line walk puts it, two passes after its first draw (#126);
 * the map's picture at rest draws it at the list position instead (D91).
 * Synthetic cart: ids 31 and 103 draw one piece at SpriteXPos and then move +4 (hand-written opcodes),
 * so CI (no cart) proves the rule picks the third drawn pass for $67 only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
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
  grinderDrawsBeforeSnap,
  isStockRoutine,
  INIT_SHIFT_IDS,
  LINE_GUIDED_IDS,
  VANILLA_DISPATCH,
} from '../../../../src/rom/sprites/interp/LineGuided'
import { RAM, runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import {
  freshRom,
  hasRom,
  romPath,
  SPRITE_TRACE_SET,
  TOOLS_ROOT,
  VANILLA,
} from '../../support/corpus'
import { GRINDER_DISPATCH_AT, grinderShape, GRINDER_HANDLER } from '../../support/syntheticGrinder'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const seed = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
const gate = (rom: RomFile, handler: number) =>
  grinderDrawsBeforeSnap(rom, handler, 0x67, RAM.spriteNumber, grinderShape(rom)).ok
const run = (id: number, o: SyntheticOptions = {}) => {
  const rom = buildSyntheticRom(o)
  return runOnce(rom, id, seed, { grinderDispatch: grinderShape(rom) })
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
    expect(g.lineGateReason).toMatch(/out of order/)
    expect(run(103).lineGateReason).toBeUndefined()
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
    expect(g.passes[0]!.parts[0]!.dx).toBe(0)
  })

  it('keeps pass 0 when the line step does not move the sprite: no "on-track" claim for an unmoved draw', () => {
    // The call targets and fingerprint still match, but the step routine at $019290 is RTS.
    const rom = buildSyntheticRom()
    rom.writeAt(0x019290, [0x60])
    expect(gate(rom, GRINDER_HANDLER)).toBe(true)
    const g = runOnce(rom, 103, seed, { grinderDispatch: grinderShape(rom) })
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
    expect(gate(rom, GRINDER_HANDLER)).toBe(true)
    const g = runOnce(rom, 103, seed, { grinderDispatch: grinderShape(rom) })
    expect(g.passes.slice(0, 3).map(p => p.parts.length > 0)).toEqual([true, true, true])
    expect(g.passes[1]!.pos).toEqual(g.passes[0]!.pos)
    expect(g.chosen).toBe(1)
    expect(g.anchor!.x).toBe(0x84)
  })

  it('flags the run model as snapping for a vanilla-shaped $67 only (SpriteModel.snaps)', () => {
    expect(run(103).snaps).toBe(true)
    // Not vanilla-shaped, another id, and a run whose draw dispatch is not the pinned shape: all unflagged.
    expect(run(103, { alteredGrinder: true }).snaps).toBeUndefined()
    expect(run(31).snaps).toBeUndefined()
    expect(runOnce(buildSyntheticRom(), 103, seed).snaps).toBeUndefined()
  })

  it('applies the snap rule to id $67 only: another id whose MAIN is the grinder handler is generic', () => {
    const rom = buildSyntheticRom({ id31IsGrinder: true })
    // The alias passes the shape gate, so the id check alone is what keeps id 31 generic.
    expect(gate(rom, 0x019500)).toBe(true)
    const g = run(31, { id31IsGrinder: true })
    expect(g.chosen).toBe(0)
    expect(g.anchor!.x).toBe(0x80)
  })

  it('accepts the cart it was fingerprinted on, and no other', () => {
    const rom = buildSyntheticRom()
    expect(gate(rom, GRINDER_HANDLER)).toBe(true)
    // The default digest is vanilla's: the synthetic handler is not it.
    expect(grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, 0x67, RAM.spriteNumber).ok).toBe(false)
  })

  it('refuses a changed byte anywhere in the dispatch block of the cart', () => {
    const flip = (at: number) => {
      const rom = buildSyntheticRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x10])
      return gate(rom, GRINDER_HANDLER)
    }
    // Every byte of the cart's dispatch but the JSL bank (+6): opcodes and operands alike change what the run calls,
    // and bank $11 of this 8-bank cart is a mirror of bank $01, the same routine.
    for (let i = 0; i < 10; i++)
      if (i !== 6) expect(flip(GRINDER_DISPATCH_AT + i), `dispatch +${i}`).toBe(false)
  })

  it('refuses a changed call or jump target: every target operand byte, low and high, several values', () => {
    const TARGET_OPERANDS = [1, 2, 4, 5, 8, 9]
    const flip = (at: number, x: number) => {
      const rom = buildSyntheticRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ x])
      return gate(rom, GRINDER_HANDLER)
    }
    const accepted = TARGET_OPERANDS.flatMap(i =>
      [0x10, 0x7f, 0xff].filter(x => flip(GRINDER_DISPATCH_AT + i, x)).map(x => `+${i}^${x}`),
    )
    expect(accepted).toEqual([])
  })

  it('reads a call target through the FastROM mirror: a JSL to bank $81, or the handler at $81, is the same routine', () => {
    const rom = buildSyntheticRom()
    expect(gate(rom, GRINDER_HANDLER | 0x800000)).toBe(true)
    rom.writeAt(GRINDER_DISPATCH_AT + 6, [0x81])
    expect(gate(rom, GRINDER_HANDLER)).toBe(true)
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

// Needs no ROM: an empty or truncated table would otherwise leave the sweep below asserting nothing.
it('the grinder table covers both configured slots, $1a and $1f', () => {
  expect(Object.keys(GRINDERS).sort()).toEqual([String(0x1a), String(0x1f)])
})

describe.skipIf(!hasRom(VANILLA))('every vanilla grinder, on the vanilla ROM', () => {
  for (const [slot, want] of Object.entries(GRINDERS)) {
    it(`slot $${Number(slot).toString(16)}: ${want.length} placements drawn at their list position, no line walk (D91)`, () => {
      const path = romPath(VANILLA)
      const bytes = new Uint8Array(readFileSync(path))
      const r = mapSprites(new L1ModelCache(), bytes, path, Number(slot))
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
      const built = new L1ModelCache().get(bytes, path, Number(slot), { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const list = parseLevelSprites(readStream(rom.rom, rom.getLevelSpritePointer(Number(slot))!)!, built.inputs.isVertical).filter(x => x.spriteId === 0x67) // prettier-ignore
      const got = r.sprites.filter(d => d.id === 0x67)
      expect(got).toHaveLength(want.length)
      got.forEach((d, i) => {
        // INIT runs for the picture (D139 D); its -$140 X move (bank_01.asm:11793-11799) is re-run with the
        // camera moved, so a grinder the INIT-on table has no anchor for (null) still draws, at its list spot.
        expect(d.status, `#${i}`).toBe('drawn')
        expect([d.x, d.y], `#${i}`).toEqual([list[i]!.x * 16, list[i]!.y * 16])
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

describe('the line-guided routines are named by fingerprint, read from the ROM (#792, #1121)', () => {
  const pristine = grinderShape(buildSyntheticRom())
  const gateOf = (rom: RomFile, number = 0x67, shape = pristine) =>
    grinderDrawsBeforeSnap(rom, GRINDER_HANDLER, number, RAM.spriteNumber, shape)
  const why = (rom: RomFile, shape = pristine) => {
    const g = gateOf(rom, 0x67, shape)
    return g.ok ? null : g.reason
  }
  const DRAW_JSR = GRINDER_DISPATCH_AT + 1
  const arm = pristine.arm

  it('accepts the pristine cart and a cart whose draw, interact and step routines are moved', () => {
    expect(gateOf(buildSyntheticRom()).ok).toBe(true)
    const rom = buildSyntheticRom()
    // The same routine bytes at new addresses, operands rewritten: $019400 -> $019600 (JSR), $019282 -> $019620 (JSL), $019290 -> $019640 (JMP).
    rom.writeAt(0x019600, [...rom.readAt(0x019400, 8)!])
    rom.writeAt(0x019620, [...rom.readAt(0x019282, 4)!])
    rom.writeAt(0x019640, [...rom.readAt(0x019290, 8)!])
    rom.writeAt(DRAW_JSR, [0x00, 0x96])
    rom.writeAt(GRINDER_DISPATCH_AT + 4, [0x20, 0x96])
    rom.writeAt(GRINDER_DISPATCH_AT + 8, [0x40, 0x96])
    expect(why(rom)).toBeNull()
  })

  it('refuses a draw call repointed at a routine that is not stock, naming the call', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(DRAW_JSR, [0x40, 0x94])
    expect(why(rom)).toMatch(
      /slot 0: it calls \$019440, which is not a stock routine \(unverified\)/,
    )
  })

  it('refuses a call repointed at another stock routine: the order is wrong', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(DRAW_JSR, [0x82, 0x92])
    expect(why(rom)).toMatch(/out of order or missing/)
  })

  it.each([
    ['draw', 0x019400],
    ['interact', 0x019282],
    ['step', 0x019290],
  ])('refuses an edited %s routine, though its callers are untouched', (_name, at) => {
    const rom = buildSyntheticRom()
    rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x01])
    const reason = why(rom)
    expect(reason, String(_name)).not.toBeNull()
    // The step is reached by a JMP, so an edited one is run as ordinary code rather than named; the other two are called.
    if (_name !== 'step') expect(reason).toMatch(/unverified/)
  })

  it('runs the arm of the id it is asked about: byId wins, the default covers the rest', () => {
    const rom = buildSyntheticRom()
    const shape = { ...pristine, arm: ['step'], byId: { 0x68: arm } }
    expect(gateOf(rom, 0x68, shape).ok).toBe(true)
    expect(gateOf(rom, 0x67, shape)).toMatchObject({ ok: false, reason: expect.stringMatching(/out of order/) }) // prettier-ignore
  })

  it('refuses an id whose cart calls its arm out of order, per id', () => {
    const rom = buildSyntheticRom({ alteredGrinder: true })
    for (const id of [0x62, 0x64, 0x65, 0x66, 0x67, 0x68])
      expect(gateOf(rom, id, { ...grinderShape(rom), byId: { [id]: arm } }), `id ${id}`).toMatchObject({ ok: false, reason: expect.stringMatching(/out of order/) }) // prettier-ignore
  })

  it('names exactly $62, $64, $65, $66, $67, $68 over every id 0..255 ($63 is a plant that must go red)', () => {
    const named = Array.from({ length: 256 }, (_, id) => id).filter(id => LINE_GUIDED_IDS.has(id))
    expect(named).toEqual([0x62, 0x64, 0x65, 0x66, 0x67, 0x68])
    // Every named id has an arm of known roles that ends in the line step.
    for (const id of named) {
      const roles = VANILLA_DISPATCH.byId?.[id] ?? VANILLA_DISPATCH.arm
      expect(roles.at(-1), `id ${id}`).toBe('step')
      expect(
        roles.every(r => r in VANILLA_DISPATCH.routines),
        `id ${id}`,
      ).toBe(true)
    }
  })
})

describe.skipIf(!hasRom(VANILLA))('per-id arms on the vanilla cart (#792, #1121)', () => {
  const seed3 = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)

  it('the run gate accepts each admitted id and not $63, and says why for none', () => {
    const rom = freshRom()
    const got = [0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68].map(id => {
      const m = runOnce(rom, id, seed3)
      return [id, m.snaps === true, m.lineGateReason]
    })
    expect(got).toEqual([[0x62, true, undefined], [0x63, false, undefined], [0x64, true, undefined], [0x65, true, undefined], [0x66, true, undefined], [0x67, true, undefined], [0x68, true, undefined]]) // prettier-ignore
  }, 120_000)

  it('refuses an id whose draw call is pointed at the interact routine (a planted hijack)', () => {
    const rom = freshRom()
    // CODE_01D9BA (the $67 test) is followed by JSR CODE_01DC0B: point it at MarioSprInteractRt instead.
    const at = 0x01d9be
    expect(rom.readAt(at, 1)![0]).toBe(0x20)
    rom.writeAt(at + 1, [0xe4, 0xa7])
    expect(runOnce(rom, 0x67, seed3).lineGateReason).toMatch(/out of order/)
  }, 120_000)

  it('flags an edited stock routine as unverified, whichever of the eight is edited', () => {
    // Entry byte of each routine the arms call: prelude, $62 draw, rope draw, $67 draw, $68 draw, interact, chainsaw draw wrapper, line step.
    const entries: [number, number][] = [[0x65, 0x018063], [0x62, 0x01b2df], [0x64, 0x01dc54], [0x67, 0x01dc0b], [0x68, 0x01dbd4], [0x65, 0x01a7e4], [0x65, 0x03c263], [0x67, 0x01d74d]] // prettier-ignore
    for (const [id, at] of entries) {
      const rom = freshRom()
      rom.writeAt(at, [rom.readAt(at, 1)![0]! ^ 0x01])
      const m = runOnce(rom, id, seed3)
      expect(m.snaps, `$${at.toString(16)} for id ${id}`).not.toBe(true)
      // A routine INIT itself calls (the rope's draw) stops the run there, before the gate: the refusal is the flag.
      expect(m.lineGateReason ?? m.refusal, `$${at.toString(16)} for id ${id}`).toBeDefined()
    }
  }, 240_000)
})

describe('InitLineGuidedSpr is checked by fingerprint (#792, D110 call 4)', () => {
  it('names the four ids whose INIT is it, and no other over 0..255', () => {
    expect(Array.from({ length: 256 }, (_, id) => id).filter(id => INIT_SHIFT_IDS.has(id))).toEqual([0x65, 0x66, 0x67, 0x68]) // prettier-ignore
  })

  it('accepts a routine whose bytes hash to the stock one and refuses each single-byte edit (synthetic bytes)', () => {
    const rom = buildSyntheticRom()
    const stock = { len: 16, sha: fingerprint(rom.readAt(0x019200, 16))! }
    expect(isStockRoutine(rom, 0x019200, stock)).toBe(true)
    const accepted = Array.from({ length: 16 }, (_, i) => i).filter(i => {
      const r = buildSyntheticRom()
      r.writeAt(0x019200 + i, [r.readAt(0x019200 + i, 1)![0]! ^ 0x01])
      return isStockRoutine(r, 0x019200, stock)
    })
    expect(accepted).toEqual([])
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'InitLineGuidedSpr on the vanilla cart (#792, D110 call 4)',
  () => {
    const seed3 = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)

    it('is stock for $65-$68 and not flagged', () => {
      const rom = freshRom()
      for (const id of INIT_SHIFT_IDS) expect(runOnce(rom, id, seed3).lineInitReason, `id ${id}`).toBeUndefined() // prettier-ignore
    }, 120_000)

    it('flags an edited subtract constant as unverified, while the interpreter still runs the edited INIT', () => {
      const stock = runOnce(freshRom(), 0x65, seed3)
      const rom = freshRom()
      // The constant of the even-column branch's SBC #imm: changed, so the shift differs from stock.
      rom.writeAt(0x01d6fa, [rom.readAt(0x01d6fa, 1)![0]! ^ 0x10])
      const m = runOnce(rom, 0x65, seed3)
      expect(m.lineInitReason).toMatch(/not the stock InitLineGuidedSpr/)
      expect(m.refusal).toBeUndefined()
      expect(m.anchor!.x).not.toBe(stock.anchor!.x)
    }, 120_000)
  },
)

const TRACE_SLOT_7 = join(TOOLS_ROOT, 'fixtures', 'sprite-trace', SPRITE_TRACE_SET, '01f')

describe.skipIf(!hasRom(VANILLA) || !existsSync(TRACE_SLOT_7))(
  'Mesen capture, slot $1F grinder in sprite slot 7',
  () => {
    it('the INIT-on run is drawn where the capture left it after the line pull, (431,336); the picture at rest is not', () => {
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
      // The INIT-on run (the default; play/simulate) reaches the capture's spot; the map's picture does not (D91).
      const path = romPath(VANILLA)
      const bytes = new Uint8Array(readFileSync(path))
      const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
      const built = new L1ModelCache().get(bytes, path, 0x1f, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const first = parseLevelSprites(readStream(rom.rom, rom.getLevelSpritePointer(0x1f)!)!, built.inputs.isVertical).filter(x => x.spriteId === 0x67)[0]! // prettier-ignore
      const draws = (run?: (...a: Parameters<typeof runOnce>) => SpriteModel) => interpDrawer(rom.rom, 0x1f, built.inputs, run)(first) // prettier-ignore
      const played = draws((r, id, sd) => runOnce(r, id, sd))
      const rest = draws()
      if (!played.ok || !rest.ok) throw new Error('grinder not drawn')
      expect([played.anchor!.x, played.anchor!.y]).toEqual(at(lastWram))
      expect([rest.anchor!.x, rest.anchor!.y]).toEqual([first.x * 16, first.y * 16])
    }, 120_000)
  },
)
