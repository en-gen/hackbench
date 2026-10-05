/**
 * The sprite runner on a SYNTHETIC cart (no ROM needed), plus the vanilla
 * checks gated on the corpus. Every defect the oracle claims to catch is
 * planted here and shown to change the verdict.
 */
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
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
  it('refuses an id past the table and a pointer below $8000', () => {
    const t = resolveTables(rom)
    if (!t.ok) throw new Error('tables')
    expect(resolvePointer(rom, t.tables.mainTable, 201).ok).toBe(false)
    const p = resolvePointer(rom, t.tables.initTable, 6)
    expect(p.ok).toBe(false)
    expect(resolvePointer(rom, t.tables.initTable, 0).ok).toBe(true)
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

  it('runs every entry: pointers, Mario entrance, then level data', () => {
    const l = run()
    if (!l.ok) throw new Error(l.reason)
    expect(l.wram[0x1692]).toBe(7) // CODE_05D8B7 stand-in
    expect(l.wram[0x71]).toBe(6) // CODE_00A635 stand-in: skipping it leaves 0
    expect(l.wram[0xc800]).toBe(0x25) // CODE_05801E stand-in
    expect(l.wram[0x0e]).toBe(0x05)
    expect(l.wram[0x0f]).toBe(0x01)
  })

  it('refuses each differing entry with its name', () => {
    expect(run({ badLoader: 'lead' })).toMatchObject({ ok: false, reason: /lead-in at \$05:D8AE/ })
    expect(run({ badLoader: 'pointers' })).toMatchObject({ ok: false, reason: /pointer loader/ })
    expect(run({ badLoader: 'entrance' })).toMatchObject({ ok: false, reason: /entrance setup/ })
    expect(run({ badLoader: 'data' })).toMatchObject({ ok: false, reason: /data loader/ })
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
    for (const name of CORPUS.filter(n => !refused.includes(n)))
      expect(name).toMatch(/Super Mario World/)
  })
})
