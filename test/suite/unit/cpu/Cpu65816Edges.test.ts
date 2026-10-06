/**
 * Synthetic edge tests for Cpu65816 (#646). Bytes are built inline, no ROM and
 * no SingleStepTests data, so CI runs them. They cover rules the 5.12M random
 * vectors reach 0 to 2 times (so a mutant there survives) and the two
 * emulation-mode rules where the vectors are disputed upstream. Rules cite
 * Bruce Clark, "Investigating the 65C816's Operation" (Clark), and Snes9x.
 */
import { describe, it, expect } from 'vitest'
import { Cpu65816, type Bus } from '../../../../src/rom/cpu/Cpu65816'

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
/** Native mode, 8-bit registers, `code` follows CLC XCE. */
function nat(code: number[], at = 0x8000) {
  const m = machine([...NATIVE, ...code], at)
  m.run(2)
  return m
}
type Mem = Map<number, number>
const seed = (mem: Mem, kv: [number, number][]) => kv.forEach(([a, v]) => mem.set(a, v))

describe('Cpu65816 addressing edges', () => {
  it('abs,X, long,X and (dp),Y carry into the next bank', () => {
    const a = nat([0xbd, 0xff, 0xff])
    a.cpu.db = 0x12
    a.cpu.x = 2
    seed(a.mem, [[0x130001, 0x77], [0x120001, 0x11]]) // prettier-ignore
    a.run(1)
    expect(a.cpu.a & 0xff).toBe(0x77)
    const l = nat([0xc2, 0x10, 0xbf, 0x00, 0xff, 0x20])
    l.run(1)
    l.cpu.x = 0x200
    seed(l.mem, [[0x210100, 0x66], [0x200100, 0x11]]) // prettier-ignore
    l.run(1)
    expect(l.cpu.a & 0xff).toBe(0x66)
    const p = nat([0xb1, 0x10])
    p.cpu.db = 0x12
    p.cpu.y = 2
    seed(p.mem, [[0x10, 0xff], [0x11, 0xff], [0x130001, 0x55], [0x120001, 0x11]]) // prettier-ignore
    p.run(1)
    expect(p.cpu.a & 0xff).toBe(0x55)
  })
  it('a multi-byte operand fetch at PC $FFFF continues at $0000 of the same bank', () => {
    const m = nat([])
    m.cpu.pc = 0xfffe
    seed(m.mem, [[0xfffe, 0xad], [0xffff, 0x00], [0x0000, 0x20], [0x10000, 0x99], [0x2000, 0x5a]]) // prettier-ignore
    m.run(1)
    expect([m.cpu.a & 0xff, m.cpu.pc]).toEqual([0x5a, 0x0001])
  })
  it('emulation direct page indexing wraps in the page only when DL is 0', () => {
    for (const [d, want] of [
      [0x0000, 0x0000],
      [0x0001, 0x0101],
    ]) {
      const m = machine([0xb5, 0xff])
      m.cpu.d = d
      m.cpu.x = 1
      seed(m.mem, [[0x0000, 0xa1], [0x0100, 0xb2], [0x0101, 0xc3]]) // prettier-ignore
      m.run(1)
      expect(m.cpu.a & 0xff).toBe(m.mem.get(want))
    }
  })
  it('emulation (dp) and (dp),Y wrap the pointer in the page when DL is 0, not otherwise', () => {
    for (const op of [0xb2, 0xb1]) {
      const m = machine([op, 0xff])
      seed(m.mem, [[0xff, 0x34], [0x00, 0x12], [0x100, 0x99], [0x1234, 0xaa], [0x9934, 0xbb]]) // prettier-ignore
      m.run(1)
      expect(m.cpu.a & 0xff).toBe(0xaa)
      const n = machine([op, 0xfe])
      n.cpu.d = 0x0001 // DL is not 0: pointer at $00FF/$0100, no wrap
      seed(n.mem, [[0xff, 0x34], [0x100, 0x12], [0x00, 0x99], [0x1234, 0xaa]]) // prettier-ignore
      n.run(1)
      expect(n.cpu.a & 0xff).toBe(0xaa)
    }
  })
  it('emulation [dp] never wraps in the page, even with DL 0 (Clark)', () => {
    const m = machine([0xa7, 0xff])
    seed(m.mem, [[0xff, 0x00], [0x100, 0x90], [0x101, 0x01], [0x019000, 0x5a]]) // prettier-ignore
    m.run(1)
    expect(m.cpu.a & 0xff).toBe(0x5a)
  })
  it('16-bit d,S, dp,X and dp,Y at $FFFF take the high byte from $0000 of bank 0', () => {
    const cases: [number[], (c: Cpu65816) => void][] = [
      [[0xa3, 0xff], c => (c.s = 0xff00)],
      [[0xb5, 0x00], c => Object.assign(c, { d: 0xff00, x: 0xff })],
      [[0xb6, 0x00], c => Object.assign(c, { d: 0xff00, y: 0xff })],
    ]
    for (const [code, set] of cases) {
      const m = nat([0xc2, 0x30, ...code])
      m.run(1)
      set(m.cpu)
      seed(m.mem, [[0xffff, 0x34], [0x0000, 0x12], [0x10000, 0x99]]) // prettier-ignore
      m.run(1)
      expect(code[0] === 0xb6 ? m.cpu.x : m.cpu.a).toBe(0x1234)
    }
  })
  it('JMP (a), JML [a] and (d,S),Y read a pointer at $FFFF across $0000 of bank 0', () => {
    const j = nat([0x6c, 0xff, 0xff])
    seed(j.mem, [[0xffff, 0x34], [0x0000, 0x12], [0x10000, 0x99]]) // prettier-ignore
    j.run(1)
    expect(j.cpu.pc).toBe(0x1234)
    const l = nat([0xdc, 0xff, 0xff])
    seed(l.mem, [[0xffff, 0x34], [0x0000, 0x12], [0x0001, 0x05], [0x10000, 0x99], [0x10001, 0x98]]) // prettier-ignore
    l.run(1)
    expect([l.cpu.pb, l.cpu.pc]).toEqual([0x05, 0x1234])
    const s = nat([0xb3, 0xff])
    s.cpu.s = 0xff00
    seed(s.mem, [[0xffff, 0x34], [0x0000, 0x12], [0x10000, 0x99], [0x1234, 0xaa]]) // prettier-ignore
    s.run(1)
    expect(s.cpu.a & 0xff).toBe(0xaa)
  })
  it('JMP (a,X) adds X inside the program bank', () => {
    const m = nat([0x7c, 0xff, 0xff])
    m.cpu.x = 2
    seed(m.mem, [[0x0001, 0x34], [0x0002, 0x12], [0x10001, 0x99], [0x10002, 0x98]]) // prettier-ignore
    m.run(1)
    expect(m.cpu.pc).toBe(0x1234)
  })
  it('PEI in emulation mode reads its pointer across the page edge, no wrap', () => {
    const m = machine([0xd4, 0xff])
    seed(m.mem, [[0xff, 0x34], [0x100, 0x12], [0x00, 0x99]]) // prettier-ignore
    m.run(1)
    expect([m.mem.get(0x1ff), m.mem.get(0x1fe)]).toEqual([0x12, 0x34])
  })
  it('(dp,X) in emulation mode with DL 0 wraps the pointer high byte in the page (Clark 5.11)', () => {
    const m = machine([0xa1, 0xb0])
    m.cpu.d = 0xf400
    m.cpu.x = 0x4f
    seed(m.mem, [[0xf4ff, 0x34], [0xf400, 0x12], [0xf500, 0x99], [0x1234, 0xaa], [0x9934, 0xbb]]) // prettier-ignore
    m.run(1)
    expect(m.cpu.a & 0xff).toBe(0xaa)
  })
})

describe('Cpu65816 flag and register edges', () => {
  it('BIT #imm sets Z only; N and V keep their values', () => {
    for (const [nv, imm, a] of [
      [true, 0x80, 0],
      [false, 0xc0, 0x3f],
    ] as const) {
      const m = nat([0x89, imm])
      m.cpu.n = m.cpu.v = nv
      m.cpu.a = a
      m.run(1)
      expect([m.cpu.n, m.cpu.v, m.cpu.z]).toEqual([nv, nv, true])
    }
  })
  it('decimal ADC takes V from the top nibble before correction, 8 and 16 bit', () => {
    const m8 = nat([0xf8, 0x18, 0x69, 0x50])
    m8.cpu.a = 0x50
    m8.run(3)
    expect([m8.cpu.a, m8.cpu.c, m8.cpu.v]).toEqual([0, true, true])
    const m16 = nat([0xc2, 0x30, 0xf8, 0x18, 0x69, 0x00, 0x50])
    m16.run(1)
    m16.cpu.a = 0x5000
    m16.run(3)
    expect([m16.cpu.a, m16.cpu.c, m16.cpu.v]).toEqual([0, true, true])
  })
  it('decimal SBC sets V and C, 8 and 16 bit', () => {
    const m8 = nat([0xf8, 0x38, 0xe9, 0x01])
    m8.cpu.a = 0x80
    m8.run(3)
    expect([m8.cpu.a, m8.cpu.c, m8.cpu.v]).toEqual([0x79, true, true])
    const m16 = nat([0xc2, 0x30, 0xf8, 0x38, 0xe9, 0x01, 0x00])
    m16.run(1)
    m16.cpu.a = 0x8000
    m16.run(3)
    expect([m16.cpu.a, m16.cpu.c, m16.cpu.v]).toEqual([0x7999, true, true])
  })
  it('CMP, CPX and CPY set C when the registers are equal (>=)', () => {
    for (const [op, reg] of [
      [0xc9, 'a'],
      [0xe0, 'x'],
      [0xc0, 'y'],
    ] as const) {
      const m = nat([op, 0x40])
      m.cpu[reg] = 0x40
      m.run(1)
      expect([m.cpu.c, m.cpu.z]).toEqual([true, true])
    }
  })
  it('TSB and TRB take Z from A AND memory, not from the result', () => {
    for (const op of [0x04, 0x14]) {
      const m = nat([op, 0x10])
      m.cpu.a = 0x0f
      m.mem.set(0x10, 0xf0)
      m.run(1)
      expect(m.cpu.z).toBe(true)
    }
  })
  it('BRK and COP clear D, set I, push 4 bytes in native mode and jump through the vector', () => {
    for (const [op, vec] of [
      [0x00, 0xffe6],
      [0x02, 0xffe4],
    ]) {
      const m = nat([0xf8, 0x58, op, 0x00])
      seed(m.mem, [[vec, 0x00], [vec + 1, 0x90]]) // prettier-ignore
      m.run(3)
      expect([m.cpu.dec, m.cpu.i, m.cpu.pc, m.cpu.s]).toEqual([false, true, 0x9000, 0x1fb])
    }
  })
  it('XCE into emulation truncates X, Y and the S high byte and forces M and X', () => {
    const m = nat([0xc2, 0x30, 0x38, 0xfb])
    m.run(1)
    Object.assign(m.cpu, { x: 0x1234, y: 0xabcd, s: 0x2345, a: 0x5678 })
    m.run(2)
    expect(m.cpu).toMatchObject({
      e: true,
      m8: true,
      x8: true,
      x: 0x34,
      y: 0xcd,
      s: 0x145,
      a: 0x5678,
    })
  })
  it('MVN counts all of A even with 8-bit M', () => {
    const m = nat([0x54, 0x01, 0x00])
    m.cpu.a = 0x0001
    m.run(2)
    expect([m.cpu.a, m.cpu.pc]).toEqual([0xffff, 0x8005])
  })
})

describe('Cpu65816 emulation-mode stack rules', () => {
  it('PEA is not page-wrapped: from S=$0100 it writes $0100 then $00FF, S ends at $01FE', () => {
    const m = machine([0xf4, 0x34, 0x12])
    m.cpu.s = 0x100
    m.run(1)
    expect([m.mem.get(0x100), m.mem.get(0xff), m.cpu.s]).toEqual([0x12, 0x34, 0x1fe])
  })
  it('S is pinned to page 1 before the step: PHA with S=$034A writes $014A', () => {
    const m = machine([0x48])
    m.cpu.s = 0x34a
    m.cpu.a = 0x77
    m.run(1)
    expect([m.mem.get(0x14a), m.cpu.s]).toEqual([0x77, 0x149])
  })
  it('PLB is not page-wrapped: from S=$01FF it reads $0200, then S re-pins to $0100', () => {
    const m = machine([0xab])
    seed(m.mem, [[0x200, 0x48], [0x100, 0x99]]) // prettier-ignore
    m.run(1)
    expect([m.cpu.db, m.cpu.s]).toEqual([0x48, 0x100])
  })
  it('BRK pushes no program bank in emulation mode and jumps through $FFFE', () => {
    const m = machine([0x00, 0x00])
    seed(m.mem, [[0xfffe, 0x00], [0xffff, 0x90]]) // prettier-ignore
    m.run(1)
    expect([m.cpu.s, m.cpu.pc, m.mem.get(0x1ff), m.mem.get(0x1fe)]).toEqual([
      0x1fc, 0x9000, 0x80, 0x02,
    ])
  })
  it('RTI pulls P and PC only in emulation mode', () => {
    const m = machine([0x40])
    m.cpu.s = 0x1fc
    seed(m.mem, [[0x1fd, 0x30], [0x1fe, 0x34], [0x1ff, 0x12], [0x100, 0x05]]) // prettier-ignore
    m.run(1)
    expect([m.cpu.pb, m.cpu.pc, m.cpu.s]).toEqual([0, 0x1234, 0x1ff])
  })
  it('JSR (a,X) in emulation mode is not page-wrapped: from S=$0100 it writes $0100 then $00FF (Clark appendix)', () => {
    const m = machine([0xfc, 0x00, 0x90])
    m.cpu.s = 0x100
    seed(m.mem, [[0x9000, 0x00], [0x9001, 0xa0]]) // prettier-ignore
    m.run(1)
    const c = m.cpu
    expect([m.mem.get(0x100), m.mem.get(0xff), m.mem.get(0x1ff), c.s, c.pc]).toEqual([
      0x80,
      0x02,
      undefined,
      0x1fe,
      0xa000,
    ])
  })
})

describe('Cpu65816 WAI, STP, WDM and the e flag', () => {
  it('WAI and STP halt step(): later instructions do not run and PC stays', () => {
    for (const [op, flag] of [
      [0xcb, 'waiting'],
      [0xdb, 'stopped'],
    ] as const) {
      const m = nat([op, 0xe8, 0xe8])
      m.run(4)
      expect([m.cpu[flag], m.cpu.x, m.cpu.pc]).toEqual([true, 0, 0x8003])
    }
  })
  it('WDM skips its signature byte without reading it', () => {
    const reads: number[] = []
    const cpu = new Cpu65816({
      read: a => (reads.push(a), a === 0x8000 ? 0x42 : 0xea),
      write: () => {},
    })
    cpu.pc = 0x8000
    cpu.step()
    expect([cpu.pc, reads.includes(0x8001)]).toEqual([0x8002, false])
  })
  it('setting e = true enforces the M/X, index and S invariant XCE applies', () => {
    const m = machine([0xa9, 0x34, 0x12])
    m.cpu.e = false
    m.cpu.p = 0x04
    Object.assign(m.cpu, { x: 0x1234, s: 0x2345 })
    m.cpu.e = true
    expect([m.cpu.m8, m.cpu.x8, m.cpu.x, m.cpu.s]).toEqual([true, true, 0x34, 0x145])
    m.run(1)
    expect([m.cpu.a, m.cpu.pc]).toEqual([0x34, 0x8002])
  })
})
