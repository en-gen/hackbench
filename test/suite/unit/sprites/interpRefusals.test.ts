/**
 * Every refusal and budget path of the runner and the level loader, each on a
 * synthetic cart with one planted routine (no ROM, no corpus). Audit #647 F2,
 * F4, F10, F14, F15: before this file, deleting the BRK refusal, the stack
 * check, the total cap or any loader "did not return" path left every test
 * green.
 */
import { describe, expect, it } from 'vitest'
import { Cpu65816 } from '../../../../src/rom/cpu/Cpu65816'
import type { RomFile } from '../../../../src/rom/RomFile'
import { LOADER_TOTAL_CAP, loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { resolvePointer, resolveTables } from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { Machine, runSprite, TOTAL_STEP_CAP } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const BRA_SELF = [0x80, 0xfe]

/** Sprite id 0's INIT replaced by `bytes`. */
function initPatched(bytes: number[]): RomFile {
  const rom = buildSyntheticRom()
  const t = resolveTables(rom)
  if (!t.ok) throw new Error('tables')
  const p = resolvePointer(rom, t.tables.initTable, 0)
  if (!p.ok) throw new Error('pointer')
  rom.writeAt(p.handler.address, bytes)
  return rom
}

describe('runner refusals name their cause and address', () => {
  it.each([
    ['BRK', [0x00], /^BRK executed at \$01[0-9A-F]{4}$/],
    ['COP', [0x02, 0x00], /^COP executed at \$01/],
    ['WDM', [0x42, 0x00], /^WDM executed at \$01/],
    ['WAI', [0xcb, 0x60], /^WAI executed at \$01/],
    ['STP', [0xdb], /^STP executed at \$01/],
    [
      'a jump into the register half of bank 1',
      [0x4c, 0x00, 0x60],
      /^execution left ROM code at \$016000$/,
    ],
    ['a jump into WRAM', [0x5c, 0x00, 0x00, 0x7e], /^execution left ROM code at \$7E0000$/],
    ['a jump into SRAM', [0x5c, 0x00, 0x00, 0x70], /^execution left ROM code at \$700000$/],
  ])('%s', (_name, bytes, reason) => {
    expect(runSprite(initPatched(bytes), 0).refusal).toMatch(reason)
  })
})

describe('Machine.call: returns, budgets and the stack (F2, F4, F10)', () => {
  const at = 0x068000
  const machine = (code: number[], more: Record<number, number[]> = {}) => {
    const rom = buildSyntheticRom()
    rom.writeAt(at, code)
    for (const [a, b] of Object.entries(more)) rom.writeAt(Number(a), b)
    return new Machine(rom, SPRITE_SEED, 0)
  }

  it('a clean return costs its instructions', () => {
    const m = machine([0xea, 0xea, 0x6b])
    m.call(at, 'jsl')
    expect(m.steps).toBe(3)
  })
  it('RTS under a JSL frame is an unbalanced stack, not a BRK from the stray address', () => {
    expect(() => machine([0x60]).call(at, 'jsl')).toThrow(/^stack unbalanced at return \(S=\$01FE, expected \$01FF\)$/) // prettier-ignore
  })
  it('RTL under a JSR frame is unbalanced too', () => {
    expect(() => machine([0x6b]).call(at, 'jsr')).toThrow(/^stack unbalanced at return/)
  })
  it('PHA then RTS is unbalanced', () => {
    expect(() => machine([0x48, 0x60]).call(at, 'jsr')).toThrow(/^stack unbalanced at return/)
  })
  it('one call that never returns spends the per-call budget and says so', () => {
    const m = machine(BRA_SELF)
    expect(() => m.call(at, 'jsl')).toThrow(/^step budget of 200000 spent; the routine waits on state the seed lacks$/) // prettier-ignore
    expect(m.steps).toBe(200_000)
  })
  it('near the total cap the room is what is left, and the message names the total', () => {
    const m = machine(BRA_SELF)
    m.steps = TOTAL_STEP_CAP - 150_000
    expect(() => m.call(at, 'jsl')).toThrow(/^total step cap of 1000000 spent across INIT and MAIN/)
    expect(m.steps).toBe(TOTAL_STEP_CAP)
  })
  it('with the total already spent no step runs', () => {
    const m = machine([0x6b])
    m.steps = TOTAL_STEP_CAP
    expect(() => m.call(at, 'jsl')).toThrow(/^total step cap of 1000000 spent/)
    expect(m.steps).toBe(TOTAL_STEP_CAP)
  })
  it('F10: P, D and DB from one call do not carry into the next', () => {
    // Call 1: REP #$30 ; RTL. Call 2: LDA #$12 ; STA $0300 ; RTL decodes wrongly under 16-bit M.
    const m = machine([0xc2, 0x30, 0x6b], { 0x068100: [0xa9, 0x12, 0x8d, 0x00, 0x03, 0x6b] })
    m.call(at, 'jsl')
    expect(m.cpu.m8).toBe(false)
    m.call(0x068100, 'jsl')
    expect(m.bus.wram[0x300]).toBe(0x12)
    expect(m.cpu.m8).toBe(true)
  })
  it('X is the slot at every call', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(at, [0x8e, 0x01, 0x03, 0x6b]) // STX $0301 ; RTL
    const m = new Machine(rom, { ...SPRITE_SEED, slot: 3 }, 0)
    m.call(at, 'jsl')
    expect(m.bus.wram[0x301]).toBe(3)
  })
})

describe('level loader paths (F2, F14, F15)', () => {
  // Entry routines of the synthetic cart end at these addresses (see syntheticSpriteRom.ts): the
  // pointer loader's PLB at $05:D8C9, the entrance setup's RTS at $00:A647, the data loader's PLP at $05:802C.
  const PTR = 0x05d8c9
  const ENT = 0x00a647
  const DATA = 0x05802c
  const UPD = 0x00f6e7 // UpdateScreenPosition's stub PLB, inside the screen setup span
  const loaded = (at: number, bytes: number[]) => {
    const rom = buildSyntheticRom()
    rom.writeAt(at, bytes)
    return loadLevelState(rom, 0x105)
  }

  it('the unmodified synthetic cart loads, and its step count is the instructions run (F14)', () => {
    const real = Cpu65816.prototype.step
    let n = 0
    Cpu65816.prototype.step = function (this: Cpu65816) {
      n++
      return real.call(this)
    }
    try {
      const l = loadLevelState(buildSyntheticRom(), 0x105)
      expect(l.ok).toBe(true)
      expect(l.ok && l.steps).toBe(n)
      expect(n).toBeGreaterThan(20)
    } finally {
      Cpu65816.prototype.step = real
    }
  })
  it.each([
    ['level pointer loader', PTR],
    ['Mario entrance setup', ENT],
    ['screen position setup', UPD],
    ['level data loader', DATA],
  ])('%s that never returns is refused by name', (name, at) => {
    const l = loaded(at, BRA_SELF)
    expect(l).toEqual({
      ok: false,
      reason: `${name} did not return within the loader's total of ${LOADER_TOTAL_CAP} steps`,
    })
  })
  it.each([
    ['level pointer loader', PTR, /^BRK executed at \$05D8C9$/],
    ['Mario entrance setup', ENT, /^BRK executed at \$00A647$/],
    ['screen position setup', UPD, /^BRK executed at \$00F6E7$/],
    ['level data loader', DATA, /^BRK executed at \$05802C$/],
  ])('%s that executes BRK is refused with its address', (_n, at, reason) => {
    const l = loaded(at, [0x00])
    expect(l.ok).toBe(false)
    expect(!l.ok && l.reason).toMatch(reason)
  })
  it('a data loader that returns the wrong kind is an unbalanced stack, not a hang', () => {
    const l = loaded(DATA, [0x60]) // RTS where PLP, RTL belong
    expect(!l.ok && l.reason).toMatch(/^stack unbalanced at return/)
  })
  it('the cap is a TOTAL: three calls that each fit it are refused together', () => {
    // A counting loop of about 1.05 M steps in the pointer loader and again in the data loader.
    // Each alone fits LOADER_TOTAL_CAP; together they do not, so the data loader is the one cut off.
    const spin = [0xc2, 0x10, 0xa0, 0x00, 0x00, 0xa2, 0xff, 0xff, 0xca, 0xd0, 0xfd, 0xc8, 0xc0, 0x08, 0x00, 0xd0, 0xf4, 0xe2, 0x10] // prettier-ignore
    const one = loaded(PTR, [...spin, 0xab, 0x6b])
    expect(one.ok).toBe(true)
    expect(one.ok && one.steps).toBeGreaterThan(1_000_000)
    expect(one.ok && one.steps).toBeLessThan(LOADER_TOTAL_CAP)
    const rom = buildSyntheticRom()
    rom.writeAt(PTR, [...spin, 0xab, 0x6b])
    rom.writeAt(DATA, [...spin, 0x28, 0x6b])
    expect(loadLevelState(rom, 0x105)).toEqual({
      ok: false,
      reason: `level data loader did not return within the loader's total of ${LOADER_TOTAL_CAP} steps`,
    })
  })
})
