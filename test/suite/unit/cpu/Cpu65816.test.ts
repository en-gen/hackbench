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
    run(4)
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

describe('Cpu65816 block moves and direct page wrap', () => {
  it('a full MVN of $300 bytes ends with A=$FFFF, X/Y advanced, DB=dst, PC after the instruction', () => {
    const { cpu, mem, run } = machine([
      ...NATIVE,
      0xc2,
      0x30,
      0xa2,
      0x00,
      0x20,
      0xa0,
      0x00,
      0x40,
      0xa9,
      0xff,
      0x02,
      0x54,
      0x7f,
      0x7e,
    ])
    for (let i = 0; i < 0x300; i++) mem.set(0x7e2000 + i, (i * 7 + 1) & 0xff)
    run(2 + 4 + 0x300)
    expect([cpu.a, cpu.x, cpu.y, cpu.db, cpu.pc]).toEqual([0xffff, 0x2300, 0x4300, 0x7f, 0x8010])
    for (let i = 0; i < 0x300; i++) expect(mem.get(0x7f4000 + i)).toBe((i * 7 + 1) & 0xff)
  })
  it('MVP with 8-bit index registers wraps X and Y inside 8 bits', () => {
    const { cpu, mem, run } = machine([
      ...NATIVE,
      0xc2,
      0x20,
      0xe2,
      0x10,
      0xa2,
      0x02,
      0xa0,
      0x01,
      0xa9,
      0x03,
      0x00,
      0x44,
      0x7f,
      0x7e,
    ])
    mem.set(0x7e0002, 0xa1)
    mem.set(0x7e0001, 0xa2)
    mem.set(0x7e0000, 0xa3)
    mem.set(0x7e00ff, 0xa4)
    run(2 + 5 + 4)
    expect([cpu.a, cpu.x, cpu.y, cpu.pc]).toEqual([0xffff, 0xfe, 0xfd, 0x8010])
    expect([0x01, 0x00, 0xff, 0xfe].map(a => mem.get(0x7f0000 + a))).toEqual([
      0xa1, 0xa2, 0xa3, 0xa4,
    ])
  })
  it('a 16-bit direct page read at D+offset=$FFFF takes its high byte from $0000 of bank 0', () => {
    const { cpu, mem, run } = machine([...NATIVE, 0xc2, 0x20, 0xa5, 0xff])
    cpu.d = 0xff00
    mem.set(0xffff, 0x34)
    mem.set(0x0000, 0x12)
    mem.set(0x010000, 0x99)
    run(4)
    expect(cpu.a).toBe(0x1234)
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
  it('goes red on a stray write of 0 to an unlisted address', () => {
    class StrayZero extends Cpu65816 {
      override step() {
        super.step()
        this.bus.write(0x5000, 0)
      }
    }
    expect(runCase(tc(1), bus => new StrayZero(bus)).join()).toContain('[5000]')
  })
  it('goes red when memory differs', () => {
    const bad = tc(1)
    bad.final.ram = [[0x9000, 7]]
    expect(runCase(bad).join()).toContain('[9000]')
  })
})

describe('SingleStep harness oracle: write log, S/E, collapse scope, MVN (#646)', () => {
  const st = (o: Partial<StepCase['initial']>): StepCase['initial'] => ({
    pc: 0x8000,
    s: 0x1ff,
    p: 0x30,
    a: 0,
    x: 0,
    y: 0,
    dbr: 0,
    d: 0,
    pbr: 0,
    e: 0,
    ram: [],
    ...o, // prettier-ignore
  })
  const w = (a: number, v: number): [number, number, string] => [a, v, 'xxxw']
  /** Native PEA $1234: writes the high byte at $01FF, then the low byte at $01FE. */
  const pea = (): StepCase => ({
    name: 'pea',
    initial: st({ ram: [[0x8000, 0xf4], [0x8001, 0x34], [0x8002, 0x12]] }), // prettier-ignore
    final: st({ pc: 0x8003, s: 0x1fd, ram: [[0x8000, 0xf4], [0x8001, 0x34], [0x8002, 0x12], [0x1ff, 0x12], [0x1fe, 0x34]] }), // prettier-ignore
    cycles: [w(0x1ff, 0x12), w(0x1fe, 0x34)],
  })
  it('passes the correct write order', () => {
    expect(runCase(pea())).toEqual([])
  })
  it('goes red when the expected writes come in the other order', () => {
    const tc = pea()
    tc.cycles = [w(0x1fe, 0x34), w(0x1ff, 0x12)]
    expect(runCase(tc).join()).toContain('write order')
  })
  it('goes red when S or E differ', () => {
    const s = pea()
    s.final.s = 0x1fc
    expect(runCase(s).join()).toContain('s: got')
    const e = pea()
    e.final.e = 1
    expect(runCase(e).join()).toContain('e: got')
  })
  // INC $10 writes once. The data lists the old value then the new one in
  // emulation mode only; the harness may collapse that pair there, not in native mode.
  const inc = (e: number): StepCase => ({
    name: 'inc',
    initial: st({ e, ram: [[0x8000, 0xe6], [0x8001, 0x10], [0x10, 5]] }), // prettier-ignore
    final: st({ e, pc: 0x8002, ram: [[0x8000, 0xe6], [0x8001, 0x10], [0x10, 6]] }), // prettier-ignore
    cycles: [w(0x10, 5), w(0x10, 6)],
  })
  it('collapses a same-address write pair in emulation mode', () => {
    expect(runCase(inc(1))).toEqual([])
  })
  it('does not collapse a same-address write pair in native mode', () => {
    expect(runCase(inc(0)).join()).toContain('write order')
  })
  it('checks an MVN that moves one byte, and the 14-move cut of a longer one', () => {
    const mvn = (a: number): StepCase => {
      const code: [number, number][] = [[0x8000, 0x54], [0x8001, 1], [0x8002, 0]] // prettier-ignore
      const n = a === 0 ? 1 : 14
      const moved = Array.from({ length: n }, (_, k): [number, number] => [0x10030 + k, 0x77])
      const src = Array.from({ length: n }, (_, k): [number, number] => [0x20 + k, 0x77])
      return {
        name: 'mvn',
        initial: st({ a, x: 0x20, y: 0x30, ram: [...code, ...src] }),
        final: st({ a: (a - n) & 0xffff, x: 0x20 + n, y: 0x30 + n, dbr: 1, pc: a === 0 ? 0x8003 : 0x8002, ram: [...code, ...src, ...moved] }), // prettier-ignore
      }
    }
    expect(runCase(mvn(0))).toEqual([])
    expect(runCase(mvn(0x100))).toEqual([])
  })
})

describe('Cpu65816 read-modify-write bus writes (#593)', () => {
  // Hardware writes the HIGH byte first, then the low byte, for every 16-bit RMW.
  // Memory $1234, C=1, A=$0F0F: every result differs from the input and has hi != lo.
  const rmw: [string, number[], number][] = [
    ['ASL', [0x06, 0x0e, 0x16, 0x1e], 0x2468],
    ['ROL', [0x26, 0x2e, 0x36, 0x3e], 0x2469],
    ['LSR', [0x46, 0x4e, 0x56, 0x5e], 0x091a],
    ['ROR', [0x66, 0x6e, 0x76, 0x7e], 0x891a],
    ['INC', [0xe6, 0xee, 0xf6, 0xfe], 0x1235],
    ['DEC', [0xc6, 0xce, 0xd6, 0xde], 0x1233],
    ['TSB', [0x04, 0x0c], 0x1f3f],
    ['TRB', [0x14, 0x1c], 0x1030],
  ]
  /** Runs one RMW opcode on seeded memory; returns the ordered [addr, value] bus writes. */
  function writes(
    op: number,
    wide: boolean,
    operand: number[],
    seed: [number, number][],
    setup: (c: Cpu65816) => void,
  ) {
    const log: [number, number][] = []
    const mem = new Map<number, number>(seed)
    ;[op, ...operand].forEach((b, i) => mem.set(0x8000 + i, b))
    const cpu = new Cpu65816({
      read: a => mem.get(a) ?? 0,
      write: (a, v) => {
        log.push([a, v])
        mem.set(a, v)
      },
    })
    Object.assign(cpu, { pc: 0x8000, e: false, m8: !wide, x8: !wide, c: true, a: 0x0f0f, x: 0 }) // prettier-ignore
    setup(cpu)
    cpu.step()
    return log
  }
  for (const [name, ops, want] of rmw)
    for (const op of ops)
      it(`${name} $${op.toString(16)}: 16-bit writes high then low`, () => {
        const abs = (op & 0x0f) === 0x0e || (op & 0x0f) === 0x0c
        const indexed = !!(op & 0x10) && name !== 'TRB'
        const t = (abs ? 0x2010 : 0x10) + (indexed ? 2 : 0)
        const log = writes(
          op,
          true,
          abs ? [0x10, 0x20] : [0x10],
          [
            [t, 0x34],
            [t + 1, 0x12],
          ],
          c => {
            // prettier-ignore
            c.x = indexed ? 2 : 0
          },
        )
        expect(log).toEqual([
          [t + 1, want >> 8],
          [t, want & 0xff],
        ])
      })

  it('8-bit RMW makes exactly one write', () => {
    const log = writes(0xee, false, [0x10, 0x20], [[0x2010, 0x00]], () => {})
    expect(log).toEqual([[0x2010, 0x01]])
  })
  it('direct page RMW at D+$FF wraps the high byte to bank 0 offset $0000', () => {
    const log = writes(0xe6, true, [0xff], [], c => (c.d = 0xff00))
    expect(log).toEqual([
      [0x0000, 0x00],
      [0xffff, 0x01],
    ])
  })
  it('abs,X RMW at $7E:FFFF puts the high byte at $7F:0000', () => {
    const log = writes(0xfe, true, [0xff, 0xff], [], c => (c.db = 0x7e))
    expect(log).toEqual([
      [0x7f0000, 0x00],
      [0x7effff, 0x01],
    ])
  })
})
