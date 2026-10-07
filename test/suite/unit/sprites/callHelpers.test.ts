/**
 * The call helpers (src/rom/cpu/call.ts) on hand-assembled code over a flat
 * RAM bus: no ROM, no corpus. Each outcome of `callSubroutine` has a case that
 * goes red if its check is removed. The audit probe numbers (6a-6d, 8) are
 * #647's.
 */
import { describe, expect, it } from 'vitest'
import { Cpu65816, type Bus } from '../../../../src/rom/cpu/Cpu65816'
import {
  callSubroutine,
  describe as describeResult,
  nativeReset,
  Refusal,
  runUntil,
} from '../../../../src/rom/cpu/call'

/** 16 MB of flat memory: code and stack share it, which is all these routines need. */
function machine(code: Record<number, number[]>) {
  const mem = new Uint8Array(0x1000000)
  for (const [at, bytes] of Object.entries(code)) mem.set(bytes, Number(at))
  const bus: Bus = { read: a => mem[a & 0xffffff], write: (a, v) => void (mem[a & 0xffffff] = v) }
  return { mem, bus, cpu: new Cpu65816(bus) }
}

const ENTRY = 0x008000
const call =
  (kind: 'jsr' | 'jsl') =>
  (code: number[], over: Partial<Parameters<typeof callSubroutine>[2]> = {}) => {
    const m = machine({ [ENTRY]: code })
    return { ...m, r: callSubroutine(m.cpu, ENTRY, { kind, maxSteps: 1000, ...over }) }
  }
const jsr = call('jsr')
const jsl = call('jsl')

describe('callSubroutine: returns', () => {
  it('JSR frame, RTS: returned with the exact step count', () => {
    // NOP NOP RTS is 3 instructions (the loader once reported 3 fewer than it ran).
    const { r, cpu } = jsr([0xea, 0xea, 0x60])
    expect(r).toEqual({ kind: 'returned', steps: 3 })
    expect(cpu.s).toBe(0x1ff)
  })
  it('JSR frame outside bank 0: RTS in bank 1 returns (the return bank is the entry bank)', () => {
    const m = machine({ 0x018000: [0x60] })
    expect(callSubroutine(m.cpu, 0x018000, { kind: 'jsr', maxSteps: 10 })).toEqual({
      kind: 'returned',
      steps: 1,
    })
  })
  it('JSL frame, RTL: returned', () => {
    expect(jsl([0xa9, 0x33, 0x6b]).r).toEqual({ kind: 'returned', steps: 2 })
  })
  it('extra bytes sit under the frame: PLB then RTL returns, with DB from the extra byte', () => {
    const { r, cpu } = jsl([0xab, 0x6b], { extra: [0x05] })
    expect(r.kind).toBe('returned')
    expect(cpu.db).toBe(0x05)
  })
  it('regs are applied after the reset', () => {
    const { r, cpu } = jsr([0x60], { regs: { a: 7, x: 8, y: 9, d: 0x20, db: 0x81 } })
    expect(r.kind).toBe('returned')
    expect([cpu.a, cpu.x, cpu.y, cpu.d, cpu.db]).toEqual([7, 8, 9, 0x20, 0x81])
  })
})

describe('callSubroutine: wrong or unbalanced returns are never run on (audit F4, F5)', () => {
  it('6b: PHA then RTS is unbalanced and the stray address is not executed', () => {
    // RTS pulls the pushed A and half the sentinel: it would land at $7F01+A.
    const { r } = jsr([0xa9, 0x00, 0x48, 0x60])
    expect(r).toMatchObject({ kind: 'unbalanced', steps: 3 })
  })
  it('6c: RTS under a JSL frame is unbalanced', () => {
    const { r } = jsl([0x60])
    expect(r).toMatchObject({ kind: 'unbalanced', s: 0x1fe, expected: 0x1ff, steps: 1 })
    expect(describeResult(r, 10)).toMatch(
      /stack unbalanced at return \(S=\$01FE, expected \$01FF\)/,
    )
  })
  it('RTL under a JSR frame is unbalanced', () => {
    expect(jsr([0x6b]).r).toMatchObject({ kind: 'unbalanced', s: 0x200, expected: 0x1ff })
  })
  it('6a: popping the frame by hand then jumping to the sentinel is unbalanced, not a return', () => {
    // PLA PLA ; JMP $7F00: S is balanced and PC is the sentinel, but the routine never returned.
    const { r } = jsr([0x68, 0x68, 0x4c, 0x00, 0x7f])
    expect(r.kind).toBe('unbalanced')
    expect(describeResult(r, 10)).toMatch(/stack unbalanced at return \(S=\$01FE/)
  })
  it('a stack pointer set back over the frame (TCS) is reported, not run on', () => {
    // REP #$20 ; LDA #$01FF ; TCS ; BRA -2
    const { r } = jsr([0xc2, 0x20, 0xa9, 0xff, 0x01, 0x1b, 0x80, 0xfe])
    expect(r).toMatchObject({ kind: 'unbalanced', steps: 3 })
    expect(describeResult(r, 10)).toMatch(/popped its own return address/)
  })
  it('6d: a JSL routine that lands on $7F00 in another bank is not a return', () => {
    // PLA x3 ; JML $05:7F00. PB differs from the pushed bank 0 at the sentinel.
    const { r } = jsl([0x68, 0x68, 0x68, 0x5c, 0x00, 0x7f, 0x05])
    expect(r.kind).toBe('unbalanced')
  })
  it('a JSR routine that ends in another bank is unbalanced and the text names the bank', () => {
    const m = machine({ [ENTRY]: [0x5c, 0x00, 0x90, 0x05], 0x059000: [0x60] })
    const r = callSubroutine(m.cpu, ENTRY, { kind: 'jsr', maxSteps: 100 })
    expect(r).toMatchObject({ kind: 'unbalanced', pb: 5, expectedPb: 0 })
    expect(describeResult(r, 100)).toMatch(/bank \$05 instead of \$00/)
  })
})

describe('callSubroutine: budget and refusal', () => {
  it('a loop spends exactly maxSteps and reports budget', () => {
    const { r } = jsr([0x80, 0xfe], { maxSteps: 50 })
    expect(r).toEqual({ kind: 'budget', steps: 50 })
    expect(describeResult(r, 50)).toBe('step budget of 50 spent; the routine waits on state the seed lacks') // prettier-ignore
  })
  it('a Refusal from the bus hook is a result with the address, never thrown', () => {
    const m = machine({ [ENTRY]: [0xea, 0x00] })
    m.bus.onInstruction = (a, op) => {
      if (op === 0x00) throw new Refusal(`BRK executed at $${a.toString(16)}`)
    }
    const r = callSubroutine(m.cpu, ENTRY, { kind: 'jsr', maxSteps: 10 })
    expect(r).toEqual({ kind: 'refused', reason: 'BRK executed at $8001', at: 0x008001, steps: 1 })
    expect(describeResult(r, 10)).toBe('BRK executed at $8001')
  })
  it('an error that is not a Refusal is rethrown', () => {
    const m = machine({ [ENTRY]: [0xea] })
    m.bus.onInstruction = () => {
      throw new Error('boom')
    }
    expect(() => callSubroutine(m.cpu, ENTRY, { kind: 'jsr', maxSteps: 10 })).toThrow('boom')
  })
  it('describe is null for a return', () => {
    expect(describeResult({ kind: 'returned', steps: 1 }, 5)).toBeNull()
  })
})

describe('nativeReset (audit F10, probe 8)', () => {
  it('sets native mode, P, S, D and DB', () => {
    const { cpu } = machine({})
    Object.assign(cpu, { e: true, s: 0x155, d: 0x300, db: 0x7e, stopped: true, waiting: true })
    nativeReset(cpu)
    expect([cpu.e, cpu.p, cpu.s, cpu.d, cpu.db, cpu.stopped, cpu.waiting]).toEqual([false, 0x34, 0x1ff, 0, 0, false, false]) // prettier-ignore
    nativeReset(cpu, 0x30)
    expect(cpu.p).toBe(0x30)
  })
  it('8: widths, D and DB from one call do not leak into the next', () => {
    // Routine 1: REP #$30, LDA #$0000 ; RTL (leaves 16-bit M and X). Routine 2: LDA #$12 ; RTL
    // would decode a 16-bit immediate and run into the next byte if the widths leaked.
    const m = machine({ 0x008000: [0xc2, 0x30, 0x6b], 0x008100: [0xa9, 0x12, 0x6b] })
    m.cpu.d = 0x1234
    expect(callSubroutine(m.cpu, 0x008000, { kind: 'jsl', maxSteps: 10 }).kind).toBe('returned')
    expect(m.cpu.m8).toBe(false)
    const r = callSubroutine(m.cpu, 0x008100, { kind: 'jsl', maxSteps: 10 })
    expect(r).toEqual({ kind: 'returned', steps: 2 })
    expect([m.cpu.m8, m.cpu.a & 0xff, m.cpu.d]).toEqual([true, 0x12, 0])
  })
})

describe('runUntil', () => {
  it('stops after the instruction that makes `until` true', () => {
    const m = machine({ [ENTRY]: [0xea, 0xea, 0xea, 0xea] })
    m.cpu.pc = ENTRY
    const r = runUntil(m.cpu, 100, c => c.pc === ENTRY + 3)
    expect(r).toEqual({ kind: 'returned', steps: 3 })
  })
  it('reports budget when `until` never holds', () => {
    const m = machine({ [ENTRY]: [0x80, 0xfe] })
    m.cpu.pc = ENTRY
    expect(runUntil(m.cpu, 20, () => false)).toEqual({ kind: 'budget', steps: 20 })
  })
})
