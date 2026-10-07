/**
 * The sprite runner on a SYNTHETIC cart (no ROM needed), plus the vanilla
 * checks gated on the corpus. Every defect the oracle claims to catch is
 * planted here and shown to change the verdict.
 */
import { levelSeed, loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { describe, expect, it } from 'vitest'
import { runSprite, TOTAL_STEP_CAP } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  resolveLoop,
  resolvePointer,
  resolveTables,
} from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { SpriteBus } from '../../../../src/rom/sprites/interp/SpriteBus'
import { CORPUS, freshRom, hasRom, hasRoms, VANILLA } from '../../support/corpus'
import { grade, passPieces } from '../../support/spriteGrade'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()

describe('sprite loop reader', () => {
  it('resolves the setup and HandleSprite addresses from the loop itself', () => {
    expect(resolveLoop(rom)).toEqual({ ok: true, setup: 0x0180d2, handle: 0x018127 })
  })
  it('refuses a loop whose countdown matches more than once', () => {
    const dup = buildSyntheticRom({ dupLoop: true })
    expect(resolveLoop(dup)).toMatchObject({ ok: false, reason: /more than once/ })
    expect(runSprite(dup, 0).refusal).toMatch(/more than once/)
  })
  it('refuses a loop that is not the countdown shape', () => {
    const bad = buildSyntheticRom({ badLoop: true })
    expect(resolveLoop(bad).ok).toBe(false)
    expect(runSprite(bad, 0).refusal).toMatch(/countdown/)
  })
})

describe('dispatch reader', () => {
  it('reads both table bases from the dispatch code', () => {
    const t = resolveTables(rom)
    expect(t).toEqual({ ok: true, tables: { initTable: 0x01817b, mainTable: 0x018329 } })
  })
  it('refuses a HandleSprite that is not the known shape', () => {
    const t = resolveTables(buildSyntheticRom({ badDispatch: true }))
    expect(t.ok).toBe(false)
  })
  it('refuses dispatch calls that do not reach one 16-bit ExecutePtr', () => {
    const t = resolveTables(buildSyntheticRom({ badExecutePtr: true }))
    expect(t).toMatchObject({ ok: false, reason: /same routine/ })
    // Agreeing calls into a routine of another shape (here, a RTS) are refused too.
    const rts = buildSyntheticRom()
    rts.writeAt(0x0086fa, [0x60])
    expect(resolveTables(rts)).toMatchObject({ ok: false, reason: /16-bit ExecutePtr/ })
  })
  it('refuses an id past the table and a pointer below $8000', () => {
    const t = resolveTables(rom)
    if (!t.ok) throw new Error('tables')
    expect(resolvePointer(rom, t.tables.mainTable, 201).ok).toBe(false)
    const p = resolvePointer(rom, t.tables.initTable, 6)
    expect(p.ok).toBe(false)
    expect(resolvePointer(rom, t.tables.initTable, 0).ok).toBe(true)
  })
})

describe('runtime palette writes', () => {
  // Each id writes one color in INIT by a different route; the model carries it from pass 0 on.
  it.each([
    [20, 0xd1, 0x03ff, 'the NMI upload list'],
    [21, 0xd2, 0x01aa, 'the palette mirror'],
    [22, 0xd3, 0x0255, 'CGADD and CGDATA'],
  ])('id %i: color %i set through %s', (id, index, bgr555) => {
    const m = runSprite(rom, id)
    expect(m.passes[0].palette).toEqual([{ index, bgr555 }])
    expect(m.passes.at(-1)!.palette).toEqual([{ index, bgr555 }])
  })

  const image = (cells: Record<number, number>) => {
    const w = new Uint8Array(0x20000)
    for (const [k, v] of Object.entries(cells)) w[Number(k)] = v
    return w
  }

  it('entries the loader left in the upload list are not the sprite own (the run starts at $0681)', () => {
    // $0681 = 4 with a stale entry [2 bytes, color $D7, $2211] at $0682.
    const stale = image({ 0x681: 4, 0x682: 2, 0x683: 0xd7, 0x684: 0x11, 0x685: 0x22 })
    const m = runSprite(rom, 20, withSeed({ loaded: stale }))
    expect(m.passes[0].palette).toEqual([{ index: 0xd1, bgr555: 0x03ff }])
  })

  it('a color set directly and then by the list ends as the list set it, in that order', () => {
    expect(runSprite(rom, 23).passes[0].palette).toEqual([
      { index: 0xd1, bgr555: 0x0211 },
      { index: 0xd1, bgr555: 0x03ff },
    ])
  })

  it('the MainPalette source is a list with a header, like the others: id 21 uploads its entry', () => {
    expect(runSprite(rom, 21).passes[0].palette).toEqual([{ index: 0xd2, bgr555: 0x01aa }])
  })

  it('colors written where the list has no header upload nothing (first byte 0 ends the walk)', () => {
    expect(runSprite(rom, 28).passes[0].palette).toEqual([])
  })

  it('the MainPalette list is not walked unless the run asked for it ($0680 = 6), whatever $0680 held', () => {
    expect(runSprite(rom, 26).passes[0].palette).toEqual([])
    expect(runSprite(rom, 26, withSeed({ loaded: image({ 0x680: 6 }) })).passes[0].palette).toEqual([]) // prettier-ignore
  })

  it('a MainPalette upload leaves the dynamic list for the next NMI', () => {
    // Appended and $0680 = 6 in one frame: INIT's NMI walks MainPalette (empty), pass 0's walks the list.
    expect(runSprite(rom, 24).passes[0].palette).toEqual([{ index: 0xd1, bgr555: 0x03ff }])
  })

  it('two consecutive CGDATA colors land on consecutive indices (CGADD auto-increments)', () => {
    expect(runSprite(rom, 25).passes[0].palette).toEqual([
      { index: 0xd4, bgr555: 0x0123 },
      { index: 0xd5, bgr555: 0x0456 },
    ])
  })

  it('an entry running past the 127-byte table is still uploaded (the DMA reads on), and the list is drained each frame', () => {
    // $0681 = $7C: the sprite appends at $06FE; its data bytes sit at $0700 and $0701.
    const m = runSprite(rom, 20, withSeed({ loaded: image({ 0x681: 0x7c }) }))
    expect(m.passes[0].palette).toEqual([{ index: 0xd1, bgr555: 0x03ff }])
    // Drained: no later pass re-applies or piles anything.
    expect(runSprite(rom, 20).passes.at(-1)!.palette).toHaveLength(1)
  })

  it('a two-color entry lands on consecutive colors from its CGRAM index', () => {
    expect(runSprite(rom, 29).passes[0].palette).toEqual([
      { index: 0xd6, bgr555: 0x0111 },
      { index: 0xd7, bgr555: 0x0222 },
    ])
  })

  it('the list is drained by each frame: a color appended every pass lands every pass', () => {
    const m = runSprite(rom, 27)
    expect([0, 1, 5].map(p => m.passes[p].palette.length)).toEqual([1, 2, 6])
  })

  it('refuses a list whose header or data is cut off by the end of WRAM, and one with no terminator', () => {
    const len = 0x20000
    // Entries of 100 bytes chain from $0682 (the run starts at $0681 = 0) up to `end`, then `tail` is written there.
    const chain = (tail: (w: Uint8Array, at: number) => void) => {
      const w = new Uint8Array(len)
      let at = 0x682
      while (len - 1 - at - 2 > 100) {
        w[at] = 100
        w[at + 1] = 0x80
        for (let i = 0; i < 100; i++) w[at + 2 + i] = 0x11
        at += 102
      }
      tail(w, at)
      return w
    }
    // (a) count byte in the very last cell: no header after it. Walk by 102 until the stride lands on len-1.
    const cut = (w: Uint8Array, at: number) => {
      const r = len - 1 - at - 2 // data bytes left between this entry's header and the last cell
      w[at] = r
      w[at + 1] = 0x80
      for (let i = 0; i < r; i++) w[at + 2 + i] = 0x11
      w[len - 1] = 7
    }
    const a = runSprite(rom, 0, withSeed({ loaded: chain(cut) }))
    expect(a.refusal).toMatch(/header is cut off/)
    // (b) the last entry claims more data than WRAM has left.
    const over = (w: Uint8Array, at: number) => {
      w[at] = 200
      w[at + 1] = 0x80
    }
    const b = runSprite(rom, 0, withSeed({ loaded: chain(over) }))
    expect(b.refusal).toMatch(/runs past the end of WRAM/)
    // (c) a well-formed list that ends in a terminator is not refused.
    const ok = (w: Uint8Array, at: number) => void (w[at] = 0)
    expect(runSprite(rom, 0, withSeed({ loaded: chain(ok) })).refusal).toBeUndefined()
  })

  it('a sprite that writes no color has none', () => {
    expect(runSprite(rom, 0).passes[0].palette).toEqual([])
  })
})

describe('runner on a synthetic cart', () => {
  it('shifts the anchor by what INIT executes, and a changed operand changes the shift', () => {
    const a = runSprite(rom, 0)
    expect(a.anchor).toMatchObject({ x: 0x88, y: 0x80, rawX: 0x80, rawY: 0x80 })
    const b = runSprite(buildSyntheticRom({ initShift: 3 }), 0)
    expect(b.anchor?.x).toBe(0x83)
  })

  it('INIT shift with a Y borrow (the +8,-1 shape) crosses the high byte', () => {
    const m = runSprite(rom, 1, withSeed({ sprite: { x: 0x100, y: 0x100 } }))
    expect(m.anchor).toMatchObject({ x: 0x108, y: 0xff })
  })

  it('captures OAM parts relative to the post-INIT anchor, with palette row and size', () => {
    const m = runSprite(rom, 0)
    expect(m.refusal).toBeUndefined()
    expect(m.passes).toHaveLength(SPRITE_SEED.mainPasses)
    expect(m.passes[0].parts).toEqual([
      {
        oam: 64,
        char: 0x24,
        size: 16,
        palette: 8 + 5,
        priority: 0,
        flipX: false,
        flipY: false,
        dx: 0,
        dy: 0,
        attr: 0x0a,
        ox: 0x88,
        oy: 0x80,
      },
    ])
  })

  it('a planted missing tile write empties the model with a reason', () => {
    const m = runSprite(buildSyntheticRom({ noTileWrite: true }), 0)
    // The OAM X/Y writes still happen, but no tile byte was written: nothing is attributed.
    expect(m.passes.every(p => p.parts.length === 0)).toBe(true)
    expect(m.emptyReason).toMatch(/drew no OAM tile/)
  })

  it('a sprite that draws nothing says so', () => {
    const m = runSprite(rom, 5)
    expect(m.emptyReason).toBeDefined()
    expect(m.refusal).toBeUndefined()
  })

  it('flags dependsOn marioX by diffing a run with Mario on the other side', () => {
    expect(runSprite(rom, 2).dependsOn).toEqual(['marioX'])
    expect(runSprite(rom, 0).dependsOn).toEqual([])
  })

  it('models the multiply unit', () => {
    expect(runSprite(rom, 3).passes[0].parts[0].char).toBe(15)
  })

  it('refuses honestly: COP, id past the table, pointer below $8000', () => {
    expect(runSprite(rom, 4).refusal).toMatch(/COP executed/)
    expect(runSprite(rom, 201).refusal).toMatch(/past the 201-entry/)
    expect(runSprite(rom, 6).refusal).toMatch(/not in ROM code/)
  })

  it('INIT status: 9 runs on, 0 is an erased sprite, 1 is an INIT that did not complete', () => {
    expect(runSprite(rom, 7).refusal).toBeUndefined()
    expect(runSprite(rom, 8).emptyReason).toMatch(/erased/)
    expect(runSprite(rom, 9).refusal).toMatch(/status stays 1/)
  })

  it('level state is seeded where sprites read it, and recorded as an input', () => {
    expect(runSprite(rom, 10).passes[0].parts[0].char).toBe(0)
    const seed = withSeed({ level: { water: 1 } })
    const m = runSprite(rom, 10, seed, { trackInputs: true })
    expect(m.passes[0].parts[0].char).toBe(1)
    expect(m.inputs).toContain(0x85)
    // Mario's X is read by id 2 only through the seed, never invented.
    expect(runSprite(rom, 0, SPRITE_SEED, { trackInputs: true }).inputs).not.toContain(0x85)
  })

  it('an INIT that stays under the per-call budget but never settles hits the total step cap', () => {
    const m = runSprite(rom, 30)
    expect(m.refusal).toMatch(/total step cap/)
    // Without the cap this would run 64 retries of ~196k steps each (~12.6M).
    expect(m.steps.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(TOTAL_STEP_CAP)
  })

  it('refuses when the dispatch shape is wrong', () => {
    expect(runSprite(buildSyntheticRom({ badDispatch: true }), 0).refusal).toMatch(/HandleSprite/)
  })

  it('a different seed position moves the OAM, not the offsets', () => {
    const m = runSprite(
      rom,
      0,
      withSeed({ sprite: { x: 0x140, y: 0x90 }, camera: { x: 0x100, y: 0 } }),
    )
    expect(m.passes[0].parts[0]).toMatchObject({ dx: 0, dy: 0, oy: 0x90 })
  })
})

describe('the grader can go red', () => {
  const m = runSprite(rom, 0)
  const exact = passPieces(m, 0)
  it('exact for the same pieces, wrong for a planted tile change', () => {
    expect(grade(m, [exact]).verdict).toBe('exact')
    expect(grade(m, [[{ ...exact[0], tile: exact[0].tile + 1 }]]).verdict).toBe('wrong')
  })
  it('shape when only the offset from the sprite differs; close when only a flip does', () => {
    expect(grade(m, [[{ ...exact[0], dx: 5 }]]).verdict).toBe('shape')
    expect(grade(m, [[{ ...exact[0], attr: exact[0].attr | 0x40 }]]).verdict).toBe('close')
  })
  it('set membership: the chosen frame may equal ANY recorded frame', () => {
    const other = [{ ...exact[0], tile: exact[0].tile + 3 }]
    expect(grade(m, [other, exact]).verdict).toBe('exact')
    expect(grade(m, [other, other]).verdict).toBe('wrong')
  })
  it('frame policy: chosen is the first pass that draws', () => {
    expect(runSprite(rom, 0).chosen).toBe(0)
    expect(runSprite(rom, 5).chosen).toBeUndefined()
  })
  it('passes refusals and empties through', () => {
    expect(grade(runSprite(rom, 4), [exact]).verdict).toBe('refused')
    expect(grade(runSprite(rom, 5), [exact]).verdict).toBe('empty')
  })
})

describe('hardware stubs', () => {
  it('multiplies and divides through the register pairs', () => {
    const bus = new SpriteBus(rom)
    bus.write(0x4202, 200)
    bus.write(0x4203, 100)
    expect(bus.read(0x4216) | (bus.read(0x4217) << 8)).toBe(20000)
    bus.write(0x4204, 0x34)
    bus.write(0x4205, 0x12)
    bus.write(0x4206, 10)
    expect(bus.read(0x4214) | (bus.read(0x4215) << 8)).toBe(Math.floor(0x1234 / 10))
    expect(bus.read(0x4216) | (bus.read(0x4217) << 8)).toBe(0x1234 % 10)
  })
})

describe.skipIf(!hasRom(VANILLA))('vanilla', () => {
  it('$4F on $105 anchors at the placement plus (8,-1)', () => {
    const m = runSprite(freshRom(), 0x4f, withSeed({ sprite: { x: 2096, y: 352 } }))
    expect(m.anchor).toMatchObject({ x: 2104, y: 351 })
  })
  it('refuses ids past the table, completing none of $C9-$FF', () => {
    const r = freshRom()
    for (let id = 0xc9; id < 0x100; id++) expect(runSprite(r, id).refusal).toBeDefined()
  })
})

describe.skipIf(!hasRom(VANILLA))('ROM level loader (vanilla)', () => {
  it('loads level $105 by running the ROM: header cells, Map16 filled, level sprites cleared by the runner', () => {
    const r = loadLevelState(freshRom(), 0x105)
    if (!r.ok) throw new Error(r.reason)
    expect(r.wram[0x5d]).toBe(0x14) // LevelScrLength from the header's first byte
    expect(r.wram.subarray(0xc800, 0xc800 + 0x3800).some(b => b !== 0)).toBe(true)
  })
  it('GetRand with the FastROM mirror banks ($01:ACFF and $01:AD04 = $81) runs and agrees with vanilla', () => {
    const plain = runSprite(freshRom(), 0x0f)
    const rom = freshRom()
    rom.writeAt(0x01acff, [0x81])
    rom.writeAt(0x01ad04, [0x81])
    const fast = runSprite(rom, 0x0f)
    expect(fast.refusal).toBeUndefined()
    expect(fast.chosen).toBe(plain.chosen)
    expect(JSON.stringify(fast.passes)).toBe(JSON.stringify(plain.passes))
  })
  it('refuses when the sublevel path it models is rerouted ($05:D83B = JMP $8000)', () => {
    const rom = freshRom()
    rom.writeAt(0x05d83b, [0x4c, 0x00, 0x80])
    expect(loadLevelState(rom, 0x105)).toMatchObject({
      ok: false,
      reason: /jump into the pointer loader/,
    })
  })
  it('a planted header-decode defect changes the loaded state (the loader can go red)', () => {
    const rom = freshRom()
    // CODE_0584E3: AND #$1F (screens) planted to AND #$0F.
    expect(rom.readByte(0x0584e9)).toBe(0x1f)
    rom.writeAt(0x0584e9, [0x0f])
    const r = loadLevelState(rom, 0x105)
    if (!r.ok) throw new Error(r.reason)
    expect(r.wram[0x5d]).toBe(4)
  })
})

describe('runner mechanics, each guarded by a case that goes red without it', () => {
  const stateOf = (id: number, over: Parameters<typeof withSeed>[0] = {}) => {
    let wram: Uint8Array | undefined
    const m = runSprite(rom, id, withSeed(over), {
      probe: (p, w) => {
        if (p === -1) wram = w.slice()
      },
    })
    return { m, wram: wram! }
  }

  it('sets X to the slot for every call (InitSpriteTables stores through X)', () => {
    const { wram } = stateOf(0, { slot: 3 })
    expect(wram[0x1603]).toBe(0x55)
    expect(wram[0x1600]).toBe(0)
  })

  it("zeroes the level loader's own sprites so only the sprite under test runs", () => {
    const loaded = new Uint8Array(0x20000)
    loaded[0x14c8 + 5] = 8 // another slot, left running by a loader (id 0 draws)
    const { m } = stateOf(0, { loaded })
    expect(m.passes[0].parts).toHaveLength(1)
  })

  it('re-runs INIT while it leaves status 1 (two retries for id 13), then draws', () => {
    const { m } = stateOf(13)
    expect(m.initFrames).toBe(3)
    expect(m.refusal).toBeUndefined()
    expect(m.passes[0].parts).toHaveLength(1)
  })

  it('ticks the frame counter once per pass, after the INIT frames', () => {
    const { m } = stateOf(14)
    // TrueFrame is the tile: seed 0, no INIT retry, so pass p sees p + 1.
    expect(m.passes.slice(0, 4).map(p => p.parts[0].char)).toEqual([1, 2, 3, 4])
  })

  it('derives the RNG by running the ROM GetRand once from zero', () => {
    expect(stateOf(15).m.passes[0].parts[0].char).toBe(2)
    // A loaded image that already carries RNG state is not touched.
    const loaded = new Uint8Array(0x20000)
    loaded[0x148b] = 9
    expect(stateOf(15, { loaded }).m.passes[0].parts[0].char).toBe(9)
  })

  it('writes mario.dir only when no loaded image supplies $76', () => {
    expect(stateOf(16).m.passes[0].parts[0].char).toBe(1)
    const loaded = new Uint8Array(0x20000) // a level whose entrance leaves $76 = 0
    expect(stateOf(16, { loaded }).m.passes[0].parts[0].char).toBe(0)
  })

  it('reads the $0200 OAM page too, with the matching size byte', () => {
    const { m } = stateOf(12)
    expect(m.refusal).toBeUndefined()
    expect(m.emptyReason).toBeUndefined()
    expect(m.passes[0].parts).toEqual([
      expect.objectContaining({ oam: 3, char: 0x33, size: 16, palette: 13, ox: 0x50, oy: 0x60 }),
    ])
  })

  it('refuses when execution leaves ROM, with the address', () => {
    expect(stateOf(11).m.refusal).toMatch(/execution left ROM code at \$7E0000/)
  })

  it('accepts GetRand with the FastROM mirror banks ($81), as 36 of 101 hacks use', () => {
    const fast = buildSyntheticRom({ fastRomGetRand: true })
    const m = runSprite(fast, 15)
    expect(m.refusal).toBeUndefined()
    expect(m.passes[0].parts[0].char).toBe(2)
  })

  it('ticks $13 and $14 on INIT retry frames too', () => {
    const { m, wram } = stateOf(17)
    expect(m.initFrames).toBe(3)
    // Each INIT call stores the counter it saw; the last call is retry frame 2.
    expect(wram[0x1620]).toBe(2)
    expect(wram[0x1630]).toBe(2)
  })

  it('ticks $14 (EffFrame) once per MAIN pass', () => {
    expect(
      stateOf(18)
        .m.passes.slice(0, 4)
        .map(p => p.parts[0].char),
    ).toEqual([1, 2, 3, 4])
  })

  it('re-clears OAM Y between passes: a tile written without a Y is not drawn from a stale one', () => {
    const { m } = stateOf(19)
    // $13 is p + 1: odd on even passes (a Y is written), even on odd passes (tile only).
    expect(m.passes.slice(0, 4).map(p => p.parts.length)).toEqual([1, 0, 1, 0])
  })

  it('reports where the seed came from', () => {
    expect(stateOf(0).m).toMatchObject({
      seedSource: 'generic',
      seedReason: 'no level image was given',
    })
    const l = loadLevelState(rom, 0x105)
    if (!l.ok) throw new Error(l.reason)
    expect(stateOf(0, { loaded: l.wram }).m.seedSource).toBe('rom-level-load')
    const refused = levelSeed(buildSyntheticRom({ badLoader: 'data' }), 0x105)
    expect(runSprite(rom, 0, refused)).toMatchObject({
      seedSource: 'generic',
      seedReason: expect.stringMatching(/data loader/),
    })
  })

  it('refuses when InitSpriteTables or GetRand has a different shape', () => {
    expect(runSprite(buildSyntheticRom({ badInitTables: true }), 0).refusal).toMatch(
      /InitSpriteTables/,
    )
    expect(runSprite(buildSyntheticRom({ badGetRand: true }), 0).refusal).toMatch(/GetRand/)
  })
})

describe('level loader on a synthetic cart', () => {
  const run = (o: Parameters<typeof buildSyntheticRom>[0] = {}, level = 0x105) =>
    loadLevelState(buildSyntheticRom(o), level)

  it('runs every entry in GM11 order: pointers, layer copy, Mario entrance, screen setup, level data', () => {
    const l = run()
    if (!l.ok) throw new Error(l.reason)
    expect(l.wram[0x1692]).toBe(7) // CODE_05D8B7 stand-in
    expect(l.wram[0x71]).toBe(6) // CODE_00A635 stand-in: skipping it leaves 0
    expect(l.wram[0xc800]).toBe(0x25) // CODE_05801E stand-in
    expect(l.wram[0x0e]).toBe(0x05)
    expect(l.wram[0x0f]).toBe(0x01)
    // The GM11 spans (bank_00.asm:2645-2656), run from the cart's bytes; each cell needs the
    // step before it: $1462 and $1E hold the pointer stub's $1A only if the copy ran after it,
    // and $20 holds $71 only if the entrance setup ran before the screen setup.
    expect(l.wram[0x1462]).toBe(7)
    expect(l.wram[0x1e]).toBe(7)
    expect(l.wram[0x20]).toBe(6)
    expect(l.wram[0x5e]).toBe(0x77) // the data stub's, written after GM11's STA $5E (so the data loader ran last)
    expect(l.wram[0x1404]).toBe(1)
  })

  it('refuses each differing entry with its name', () => {
    expect(run({ badLoader: 'lead' })).toMatchObject({ ok: false, reason: /CODE_05D796 prologue/ })
    expect(run({ badLoader: 'jump' })).toMatchObject({
      ok: false,
      reason: /jump into the pointer loader/,
    })
    expect(run({ badLoader: 'callsite' })).toMatchObject({
      ok: false,
      reason: /GM11 call JSL CODE_05D796/,
    })
    expect(run({ badLoader: 'pointers' })).toMatchObject({ ok: false, reason: /pointer loader/ })
    expect(run({ badLoader: 'entrance' })).toMatchObject({ ok: false, reason: /entrance setup/ })
    expect(run({ badLoader: 'data' })).toMatchObject({ ok: false, reason: /data loader/ })
    expect(run({ badLoader: 'scroll' })).toMatchObject({
      ok: false,
      reason: /Layer 2 scroll setup/,
    })
    expect(run({ badLoader: 'update' })).toMatchObject({
      ok: false,
      reason: /UpdateScreenPosition/,
    })
  })

  it('a wrong-kind return inside the screen setup span is refused, not run on', () => {
    expect(run({ badLoader: 'scrollRtl' })).toMatchObject({ ok: false, reason: /stack unbalanced/ })
    expect(run({ badLoader: 'updateRts' })).toMatchObject({ ok: false, reason: /stack unbalanced/ })
  })

  it('refuses when the loader executes COP', () => {
    expect(run({ loaderCop: true })).toMatchObject({ ok: false, reason: /COP executed/ })
  })
})

describe.skipIf(!hasRoms())('level loader on the hack corpus', () => {
  it('refuses every ROM whose loader entries differ from vanilla, with a reason', () => {
    const refused: string[] = []
    for (const name of CORPUS) {
      const l = loadLevelState(freshRom(name), 0x105)
      if (!l.ok) refused.push(name)
    }
    // The three hacks that patch $00:A635 and $05:D8B7, and Seven Vanilla Levels
    // (LM's JSL at $05:D8B1 in front of the entry), must not return "ok".
    expect(refused).toHaveLength(4)
    expect(refused.join('|')).toMatch(/Grand Poo World 2/)
    expect(refused.join('|')).toMatch(/Invictus/)
    expect(refused.join('|')).toMatch(/Seven_Vanilla/)
    // The product-facing answer: a hack gets a generic seed with the reason, never a guess.
    const hack = CORPUS.find(n => /Invictus/.test(n))!
    expect(runSprite(freshRom(hack), 0x0f, levelSeed(freshRom(hack), 0x105))).toMatchObject({
      seedSource: 'generic',
    })
    for (const name of CORPUS.filter(n => !refused.includes(n)))
      expect(name).toMatch(/Super Mario World/)
  })
})
