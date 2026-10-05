/**
 * The sprite runner on a SYNTHETIC cart (no ROM needed), plus the vanilla
 * checks gated on the corpus. Every defect the oracle claims to catch is
 * planted here and shown to change the verdict.
 */
import { describe, expect, it } from 'vitest'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { resolvePointer, resolveTables } from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { SpriteBus } from '../../../../src/rom/sprites/interp/SpriteBus'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { grade, passPieces } from '../../support/spriteGrade'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()

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
        oam: 0,
        char: 0x24,
        size: 16,
        palette: 8 + 5,
        priority: 0,
        flipX: false,
        flipY: false,
        dx: 0,
        dy: 0,
        attr: 0x0a,
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
    expect(grade(m, exact).verdict).toBe('exact')
    expect(grade(m, [{ ...exact[0], tile: exact[0].tile + 1 }]).verdict).toBe('wrong')
  })
  it('shape when only the offset from the sprite differs; close when only a flip does', () => {
    expect(grade(m, [{ ...exact[0], dx: 5 }]).verdict).toBe('shape')
    expect(grade(m, [{ ...exact[0], attr: exact[0].attr | 0x40 }]).verdict).toBe('close')
  })
  it('passes refusals and empties through', () => {
    expect(grade(runSprite(rom, 4), exact).verdict).toBe('refused')
    expect(grade(runSprite(rom, 5), exact).verdict).toBe('empty')
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
