/** Synthetic Cpu65816 tests: no ROM and no SingleStepTests data, so CI runs them. */
import { describe, it, expect } from 'vitest'
import { Cpu65816, type Bus } from '../../../../src/rom/cpu/Cpu65816'
import { runCase, type StepCase } from '../../support/singleStep'

function machine(code: number[], at = 0x8000) {
  const mem = new Map<number, number>()
  code.forEach((b, i) => mem.set(at + i, b))
  const bus: Bus = { read: a => mem.get(a) ?? 0, write: (a, v) => void mem.set(a, v) }
  const cpu = new Cpu65816(bus)
  cpu.pc = at
  return {
    cpu,
    mem,
    run: (n: number) => {
      for (let i = 0; i < n; i++) cpu.step()
    },
  }
}
/** CLC, XCE: leave emulation mode. */
const NATIVE = [0x18, 0xfb]

describe('Cpu65816 width switching', () => {
  it('REP/SEP #$20 changes how many bytes LDA # consumes, and SEP keeps the high byte of A', () => {
    const { cpu, run } = machine([...NATIVE, 0xc2, 0x30, 0xa9, 0x34, 0x12, 0xe2, 0x20, 0xa9, 0x56])
    run(4)
    expect(cpu.a).toBe(0x1234)
    expect(cpu.pc).toBe(0x8007)
    run(2)
    expect(cpu.a).toBe(0x1256)
    expect(cpu.pc).toBe(0x800b)
  })
  it('SEP #$10 truncates X and Y; REP #$10 does not bring the bits back', () => {
    const { cpu, run } = machine([...NATIVE, 0xc2, 0x10, 0xe2, 0x10, 0xc2, 0x10])
    run(3)
    cpu.x = 0x1234
    cpu.y = 0xabcd
    run(1)
    expect([cpu.x, cpu.y]).toEqual([0x34, 0xcd])
    run(1)
    expect(cpu.x).toBe(0x34)
  })
  it('REP/SEP cannot narrow or widen registers in emulation mode', () => {
    const { cpu, run } = machine([0xc2, 0x30])
    run(1)
    expect([cpu.m8, cpu.x8, cpu.p & 0x30]).toEqual([true, true, 0x30])
  })
})

describe('Cpu65816 emulation-mode stack', () => {
  it('PHA at S=$0100 wraps to $01FF inside page 1; PLA wraps back', () => {
    const { cpu, mem, run } = machine([0x48, 0x68])
    cpu.s = 0x100
    cpu.a = 0xab
    run(1)
    expect(mem.get(0x100)).toBe(0xab)
    expect(cpu.s).toBe(0x1ff)
    cpu.a = 0
    run(1)
    expect([cpu.a & 0xff, cpu.s]).toEqual([0xab, 0x100])
  })
  it('XCE into emulation mode pins S to page 1 and clears the index high bytes', () => {
    const { cpu, run } = machine([0x18, 0xfb, 0x38, 0xfb])
    run(2)
    cpu.s = 0x4321
    cpu.x = 0x1234
    run(2)
    expect([cpu.e, cpu.s, cpu.x]).toEqual([true, 0x121, 0x34])
  })
})

describe('Cpu65816 decimal mode', () => {
  const adc = (a: number, v: number, wide = false, carry = false) => {
    const { cpu, run } = machine(
      wide ? [0xf8, 0x18, 0xfb, 0xc2, 0x20, 0x69, v & 0xff, v >> 8] : [0xf8, 0x69, v],
    )
    if (wide) {
      run(4)
      cpu.a = a
      cpu.c = carry
      run(1)
    } else {
      run(1)
      cpu.a = a
      cpu.c = carry
      run(1)
    }
    return cpu
  }
  it('ADC adds BCD digits with carry out', () => {
    expect(adc(0x19, 0x28).a).toBe(0x47)
    const r = adc(0x99, 0x01)
    expect([r.a, r.c, r.z]).toEqual([0, true, true])
  })
  it('16-bit ADC carries through all four digits', () => {
    const r = adc(0x1999, 0x0001, true)
    expect([r.a, r.c]).toEqual([0x2000, false])
  })
  it('SBC subtracts BCD digits and borrows', () => {
    const { cpu, run } = machine([0xf8, 0x38, 0xa9, 0x40, 0xe9, 0x13, 0x38, 0xe9, 0x28])
    run(5)
    expect([cpu.a, cpu.c]).toEqual([0x27, true])
    run(2)
    expect([cpu.a, cpu.c]).toEqual([0x99, false])
  })
})

describe('Cpu65816 branches', () => {
  it('a taken branch crosses a page boundary, forward and back', () => {
    const fwd = machine([0xd0, 0x20], 0x80f0)
    fwd.cpu.z = false
    fwd.run(1)
    expect(fwd.cpu.pc).toBe(0x8112)
    const back = machine([0x80, 0xf0], 0x8100)
    back.run(1)
    expect(back.cpu.pc).toBe(0x80f2)
  })
  it('a branch not taken falls through', () => {
    const { cpu, run } = machine([0xd0, 0x20], 0x80f0)
    cpu.z = true
    run(1)
    expect(cpu.pc).toBe(0x80f2)
  })
})

describe('SingleStep harness oracle', () => {
  // ADC #$01 with A=$FF in 8-bit emulation mode: A=$00, C=1, Z=1.
  const tc = (carry: number): StepCase => ({
    name: 'synthetic',
    initial: {
      pc: 0x8000,
      s: 0x1ff,
      p: 0x30,
      a: 0xff,
      x: 0,
      y: 0,
      dbr: 0,
      d: 0,
      pbr: 0,
      e: 1,
      ram: [
        [0x8000, 0x69],
        [0x8001, 1],
      ],
    },
    final: {
      pc: 0x8002,
      s: 0x1ff,
      p: 0x32 | carry,
      a: 0,
      x: 0,
      y: 0,
      dbr: 0,
      d: 0,
      pbr: 0,
      e: 1,
      ram: [
        [0x8000, 0x69],
        [0x8001, 1],
      ],
    },
  })
  it('passes a correct case', () => {
    expect(runCase(tc(1))).toEqual([])
  })
  it('goes red on a planted defect (ADC that forgets the carry out)', () => {
    class NoCarry extends Cpu65816 {
      override step() {
        super.step()
        this.c = false
      }
    }
    expect(runCase(tc(1), bus => new NoCarry(bus)).join()).toContain('p: got')
  })
  it('goes red when memory differs', () => {
    const bad = tc(1)
    bad.final.ram = [[0x9000, 7]]
    expect(runCase(bad).join()).toContain('[9000]')
  })
})
