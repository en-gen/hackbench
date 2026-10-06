/**
 * Cpu65816.ts -- a 65C816 core: all 256 opcodes, native and emulation mode,
 * decimal arithmetic. Plain TypeScript with no shell and no SMW knowledge; the
 * machine is whatever Bus the caller supplies.
 *
 * Scope: registers, flags and memory effects of one instruction per step().
 * Cycle counts and bus timing (dummy reads, write order, MLB/VPA lines) are
 * NOT modelled. Evidence: test/suite/unit/cpu/SingleStep.test.ts.
 *
 * WAI and STP set `waiting` / `stopped` and step() then returns without
 * fetching (PC unchanged); there is no interrupt entry, so nothing clears
 * them. MVN/MVP move one byte per step(), so `onInstruction` fires once per
 * byte moved.
 */

export interface Bus {
  /** 24-bit address, returns 0-255. */
  read(addr: number): number
  /** 24-bit address, value 0-255. */
  write(addr: number, value: number): void
  /** Optional hook, called before each instruction executes. */
  onInstruction?(addr: number, opcode: number): void
}

type Mode =
  | 'imm'
  | 'dp'
  | 'dpx'
  | 'dpy'
  | 'abs'
  | 'absx'
  | 'absy'
  | 'long'
  | 'longx'
  | 'idx'
  | 'ind'
  | 'indy'
  | 'indl'
  | 'indly'
  | 'sr'
  | 'sriy'
  | 'acc'

const G1 = ['ORA', 'AND', 'EOR', 'ADC', 'STA', 'LDA', 'CMP', 'SBC']
// prettier-ignore
const G1_MODE: Record<number, Mode> = {
  0x01: 'idx', 0x03: 'sr', 0x05: 'dp', 0x07: 'indl', 0x09: 'imm', 0x0d: 'abs', 0x0f: 'long',
  0x11: 'indy', 0x12: 'ind', 0x13: 'sriy', 0x15: 'dpx', 0x17: 'indly', 0x19: 'absy', 0x1d: 'absx', 0x1f: 'longx',
}
const OTHER = new Map<number, [string, Mode]>()
const def = (name: string, ops: [number, Mode][]) =>
  ops.forEach(([o, m]) => OTHER.set(o, [name, m]))
for (const [base, name] of [
  [0x00, 'ASL'],
  [0x20, 'ROL'],
  [0x40, 'LSR'],
  [0x60, 'ROR'],
] as const)
  def(name, [
    [base + 6, 'dp'],
    [base + 0xe, 'abs'],
    [base + 0x16, 'dpx'],
    [base + 0x1e, 'absx'],
    [base + 0xa, 'acc'],
  ])
// prettier-ignore
{
def('DEC', [[0xc6, 'dp'], [0xce, 'abs'], [0xd6, 'dpx'], [0xde, 'absx'], [0x3a, 'acc']])
def('INC', [[0xe6, 'dp'], [0xee, 'abs'], [0xf6, 'dpx'], [0xfe, 'absx'], [0x1a, 'acc']])
def('TSB', [[0x04, 'dp'], [0x0c, 'abs']])
def('TRB', [[0x14, 'dp'], [0x1c, 'abs']])
def('BIT', [[0x24, 'dp'], [0x2c, 'abs'], [0x34, 'dpx'], [0x3c, 'absx'], [0x89, 'imm']])
def('LDX', [[0xa2, 'imm'], [0xa6, 'dp'], [0xae, 'abs'], [0xb6, 'dpy'], [0xbe, 'absy']])
def('LDY', [[0xa0, 'imm'], [0xa4, 'dp'], [0xac, 'abs'], [0xb4, 'dpx'], [0xbc, 'absx']])
def('STX', [[0x86, 'dp'], [0x8e, 'abs'], [0x96, 'dpy']])
def('STY', [[0x84, 'dp'], [0x8c, 'abs'], [0x94, 'dpx']])
def('STZ', [[0x64, 'dp'], [0x74, 'dpx'], [0x9c, 'abs'], [0x9e, 'absx']])
def('CPX', [[0xe0, 'imm'], [0xe4, 'dp'], [0xec, 'abs']])
def('CPY', [[0xc0, 'imm'], [0xc4, 'dp'], [0xcc, 'abs']])
}
/** CLC SEC CLI SEI CLD SED CLV: [flag, value]. */
const FLAG_OPS: Record<number, ['c' | 'i' | 'dec' | 'v', boolean]> = {
  0x18: ['c', false],
  0x38: ['c', true],
  0x58: ['i', false],
  0x78: ['i', true],
  0xd8: ['dec', false],
  0xf8: ['dec', true],
  0xb8: ['v', false],
}
const INDEX_OPS = new Set(['LDX', 'LDY', 'STX', 'STY', 'CPX', 'CPY'])

export class Cpu65816 {
  a = 0
  x = 0
  y = 0
  s = 0x1ff
  d = 0
  db = 0
  pb = 0
  pc = 0
  n = false
  v = false
  z = false
  c = false
  i = true
  dec = false
  /** True when the accumulator and memory ops are 8 bit. */
  m8 = true
  /** True when X and Y are 8 bit. */
  x8 = true
  private emu = true
  /** Set by STP / WAI; step() is then a no-op, the owner reads the flags. */
  stopped = false
  waiting = false
  /** The last ea() stays inside bank 0 / 16 bits (direct page, stack relative). */
  private wrap16 = false

  constructor(readonly bus: Bus) {}

  /** Emulation flag. Setting it true applies the invariant XCE applies. */
  get e(): boolean {
    return this.emu
  }
  set e(v: boolean) {
    this.emu = v
    if (v) {
      this.m8 = this.x8 = true
      this.x &= 0xff
      this.y &= 0xff
      this.s = 0x100 | (this.s & 0xff)
    }
  }

  get p(): number {
    return (
      (+this.n << 7) |
      (+this.v << 6) |
      (+this.m8 << 5) |
      (+this.x8 << 4) |
      (+this.dec << 3) |
      (+this.i << 2) |
      (+this.z << 1) |
      +this.c
    )
  }
  set p(p: number) {
    this.n = !!(p & 0x80)
    this.v = !!(p & 0x40)
    this.m8 = this.e || !!(p & 0x20)
    this.x8 = this.e || !!(p & 0x10)
    this.dec = !!(p & 8)
    this.i = !!(p & 4)
    this.z = !!(p & 2)
    this.c = !!(p & 1)
    if (this.x8) {
      this.x &= 0xff
      this.y &= 0xff
    }
  }

  private rd(a: number): number {
    return this.bus.read(a & 0xffffff) & 0xff
  }
  private wr(a: number, v: number): void {
    this.bus.write(a & 0xffffff, v & 0xff)
  }
  private next(a: number): number {
    return this.wrap16 ? (a & 0xff0000) | ((a + 1) & 0xffff) : (a + 1) & 0xffffff
  }
  private rdN(a: number, wide: boolean): number {
    return wide ? this.rd(a) | (this.rd(this.next(a)) << 8) : this.rd(a)
  }
  private wrN(a: number, v: number, wide: boolean): void {
    this.wr(a, v)
    if (wide) this.wr(this.next(a), v >> 8)
  }
  /** 16-bit RMW stores the high byte first, as the 65816 bus does (#593). */
  private wrRmw(a: number, v: number, wide: boolean): void {
    if (wide) this.wr(this.next(a), v >> 8)
    this.wr(a, v)
  }
  private fetch(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v |= this.rd((this.pb << 16) | ((this.pc + i) & 0xffff)) << (8 * i)
    this.pc = (this.pc + n) & 0xffff
    return v
  }
  /**
   * `old` stack ops (6502 heritage) wrap inside page 1 in emulation mode; the
   * 65816 additions (PEA PEI PER PHD PLD PLB JSL RTL) let S walk out of the
   * page and are re-pinned to page 1 after the instruction.
   * Rule: Clark ("Investigating the 65C816's Operation") and WDC documentation,
   * confirmed by Snes9x, win over SingleStepTests. Sources: Clark sec. 5.11
   * and appendix; Snes9x cpuaddr.h:412-414 and cpuops.cpp:2947-2955.
   * Two vector sets disagree and are listed as exceptions in
   * test/suite/support/singleStep.ts: `(dp,X)` pointer wrap (upstream
   * SingleStepTests/65816 issue 3) and JSR (a,X) push wrap (issues 6, 7).
   * PHB and PHK are 65816 additions too; treating them as `old` is harmless
   * because of the post-step S pin.
   */
  private push(v: number, n = 1, old = true): void {
    for (let i = n - 1; i >= 0; i--) {
      this.wr(this.s, v >> (8 * i))
      this.s = old && this.e ? 0x100 | ((this.s - 1) & 0xff) : (this.s - 1) & 0xffff
    }
  }
  private pull(n = 1, old = true): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      this.s = old && this.e ? 0x100 | ((this.s + 1) & 0xff) : (this.s + 1) & 0xffff
      v |= this.rd(this.s) << (8 * i)
    }
    return v
  }
  private nz(v: number, wide: boolean): number {
    v &= wide ? 0xffff : 0xff
    this.z = v === 0
    this.n = (v & (wide ? 0x8000 : 0x80)) !== 0
    return v
  }
  private setA(v: number): void {
    this.a = this.m8 ? (this.a & 0xff00) | (v & 0xff) : v & 0xffff
  }

  /** Direct page address of `off + idx`; indexed forms wrap in the page in emulation mode when DL is 0. */
  private dpEa(off: number, idx = 0): number {
    if (this.e && (this.d & 0xff) === 0) return this.d | ((off + idx) & 0xff)
    return (this.d + off + idx) & 0xffff
  }
  private dpPtr(loc: number, n: 2 | 3, wrapE: boolean): number {
    const pageWrap = wrapE && this.e && (this.d & 0xff) === 0
    let v = 0
    for (let i = 0; i < n; i++)
      v |= this.rd(pageWrap ? (loc & 0xff00) | ((loc + i) & 0xff) : (loc + i) & 0xffff) << (8 * i)
    return v
  }

  /** Effective address of a memory operand; also consumes its operand bytes. */
  private ea(mode: Mode): number {
    const dbase = this.db << 16
    this.wrap16 = mode === 'dp' || mode === 'dpx' || mode === 'dpy' || mode === 'sr'
    switch (mode) {
      case 'dp':
        return this.dpEa(this.fetch(1))
      case 'dpx':
        return this.dpEa(this.fetch(1), this.x)
      case 'dpy':
        return this.dpEa(this.fetch(1), this.y)
      case 'abs':
        return dbase + this.fetch(2)
      case 'absx':
        return (dbase + this.fetch(2) + this.x) & 0xffffff
      case 'absy':
        return (dbase + this.fetch(2) + this.y) & 0xffffff
      case 'long':
        return this.fetch(3)
      case 'longx':
        return (this.fetch(3) + this.x) & 0xffffff
      case 'idx':
        return dbase + this.dpPtr(this.dpEa(this.fetch(1), this.x), 2, true)
      case 'ind':
        return dbase + this.dpPtr(this.dpEa(this.fetch(1)), 2, true)
      case 'indy':
        return (dbase + this.dpPtr(this.dpEa(this.fetch(1)), 2, true) + this.y) & 0xffffff
      case 'indl':
        return this.dpPtr((this.d + this.fetch(1)) & 0xffff, 3, false)
      case 'indly':
        return (this.dpPtr((this.d + this.fetch(1)) & 0xffff, 3, false) + this.y) & 0xffffff
      case 'sr':
        return (this.s + this.fetch(1)) & 0xffff
      case 'sriy': {
        const p = (this.s + this.fetch(1)) & 0xffff
        return (dbase + (this.rd(p) | (this.rd((p + 1) & 0xffff) << 8)) + this.y) & 0xffffff
      }
    }
    throw new Error(`mode ${mode}`)
  }

  /** Per-nibble decimal add/subtract; `sub` expects the complemented operand and corrects downwards. */
  private bcd(a: number, v: number, wide: boolean, sub: boolean): number {
    const bits = wide ? 16 : 8
    let carry = +this.c
    let result = 0
    for (let sh = 0; sh < bits; sh += 4) {
      let t = ((a >> sh) & 0xf) + ((v >> sh) & 0xf) + carry
      if (sh === bits - 4) {
        // V comes from the last nibble before its decimal correction.
        const r = result | (t << sh)
        this.v = (~(a ^ v) & (a ^ r) & (1 << (bits - 1))) !== 0
      }
      carry = +(t > 0xf)
      if (sub) {
        if (!carry) t -= 6
      } else if (t > 9) {
        t += 6
        carry = +(t > 0xf)
      }
      result |= (t & 0xf) << sh
    }
    this.c = !!carry
    return result
  }

  private alu(name: string, v: number, wide: boolean): void {
    const mask = wide ? 0xffff : 0xff
    const a = this.a & mask
    switch (name) {
      case 'ORA':
        this.setA(this.nz(a | v, wide))
        break
      case 'AND':
        this.setA(this.nz(a & v, wide))
        break
      case 'EOR':
        this.setA(this.nz(a ^ v, wide))
        break
      case 'LDA':
        this.setA(this.nz(v, wide))
        break
      case 'CMP':
        this.c = a >= v
        this.nz(a - v, wide)
        break
      default: {
        const b = name === 'SBC' ? ~v & mask : v
        if (this.dec) {
          this.setA(this.nz(this.bcd(a, b, wide, name === 'SBC'), wide))
          break
        }
        const r = a + b + +this.c
        this.c = r > mask
        this.v = (~(a ^ b) & (a ^ r) & (wide ? 0x8000 : 0x80)) !== 0
        this.setA(this.nz(r, wide))
      }
    }
  }
  private shift(name: string, v: number, wide: boolean): number {
    const top = wide ? 0x8000 : 0x80
    const cin = +this.c
    let r: number
    if (name === 'ASL' || name === 'ROL') {
      this.c = (v & top) !== 0
      r = (v << 1) | (name === 'ROL' ? cin : 0)
    } else {
      this.c = (v & 1) !== 0
      r = (v >> 1) | (name === 'ROR' && cin ? top : 0)
    }
    return this.nz(r, wide)
  }
  private branch(cond: boolean): void {
    const o = this.fetch(1)
    if (cond) this.pc = (this.pc + (o > 127 ? o - 256 : o)) & 0xffff
  }
  /** BRK / COP: 2-byte instructions; native mode also pushes the program bank. */
  private trap(vecNative: number, vecEmu: number): void {
    this.fetch(1)
    if (!this.e) this.push(this.pb)
    this.push(this.pc, 2)
    this.push(this.p)
    this.dec = false
    this.i = true
    this.pb = 0
    const vec = this.e ? vecEmu : vecNative
    this.pc = this.rd(vec) | (this.rd(vec + 1) << 8)
  }

  /**
   * Executes one instruction; a no-op while `waiting` or `stopped`. A bus whose
   * read or write throws leaves the machine half-executed: discard it.
   */
  step(): void {
    if (this.stopped || this.waiting) return
    this.wrap16 = false
    if (this.e) this.s = 0x100 | (this.s & 0xff)
    const addr = (this.pb << 16) | this.pc
    const op = this.rd(addr)
    this.bus.onInstruction?.(addr, op)
    this.pc = (this.pc + 1) & 0xffff
    this.exec(op)
    if (this.e) this.s = 0x100 | (this.s & 0xff)
  }

  private exec(op: number): void {
    const w = !this.m8
    const wx = !this.x8
    const g1 = G1_MODE[op & 0x1f]
    if (g1 && op !== 0x89) {
      const name = G1[op >> 5]
      if (g1 === 'imm') this.alu(name, this.fetch(w ? 2 : 1), w)
      else {
        const a = this.ea(g1)
        if (name === 'STA') this.wrN(a, this.a, w)
        else this.alu(name, this.rdN(a, w), w)
      }
      return
    }
    const o = OTHER.get(op)
    if (o) {
      const [name, mode] = o
      const wide = INDEX_OPS.has(name) ? wx : w
      if (name === 'STZ') this.wrN(this.ea(mode), 0, w)
      else if (name === 'STX' || name === 'STY')
        this.wrN(this.ea(mode), name === 'STX' ? this.x : this.y, wx)
      else if (mode === 'acc') {
        if (name === 'INC' || name === 'DEC')
          this.setA(this.nz(this.a + (name === 'INC' ? 1 : -1), w))
        else this.setA(this.shift(name, this.a & (w ? 0xffff : 0xff), w))
      } else {
        const a = mode === 'imm' ? -1 : this.ea(mode)
        const v = mode === 'imm' ? this.fetch(wide ? 2 : 1) : this.rdN(a, wide)
        switch (name) {
          case 'LDX':
            this.x = this.nz(v, wx)
            break
          case 'LDY':
            this.y = this.nz(v, wx)
            break
          case 'CPX':
          case 'CPY': {
            const r = name === 'CPX' ? this.x : this.y
            this.c = r >= v
            this.nz(r - v, wx)
            break
          }
          case 'BIT':
            this.z = (this.a & v & (wide ? 0xffff : 0xff)) === 0
            if (mode !== 'imm') {
              this.n = (v & (wide ? 0x8000 : 0x80)) !== 0
              this.v = (v & (wide ? 0x4000 : 0x40)) !== 0
            }
            break
          case 'TSB':
            this.z = (this.a & v) === 0
            this.wrRmw(a, v | this.a, w)
            break
          case 'TRB':
            this.z = (this.a & v) === 0
            this.wrRmw(a, v & ~this.a, w)
            break
          case 'INC':
          case 'DEC':
            this.wrRmw(a, this.nz(v + (name === 'INC' ? 1 : -1), w), w)
            break
          default:
            this.wrRmw(a, this.shift(name, v, w), w)
        }
      }
      return
    }
    if ((op & 0x1f) === 0x10) {
      // Bxx: bits 7-6 pick the flag (N V C Z), bit 5 the sense (clear / set).
      this.branch([this.n, this.v, this.c, this.z][op >> 6] === !!(op & 0x20))
      return
    }
    const flag = FLAG_OPS[op]
    if (flag) {
      this[flag[0]] = flag[1]
      return
    }
    switch (op) {
      case 0x80:
        this.branch(true)
        break
      case 0x82: {
        const o2 = this.fetch(2)
        this.pc = (this.pc + o2) & 0xffff
        break
      }
      case 0x4c:
        this.pc = this.fetch(2)
        break
      case 0x6c: {
        this.wrap16 = true
        this.pc = this.rdN(this.fetch(2), true)
        break
      }
      case 0x7c: {
        this.wrap16 = true
        this.pc = this.rdN((this.pb << 16) | ((this.fetch(2) + this.x) & 0xffff), true)
        break
      }
      case 0x5c: {
        const t = this.fetch(3)
        this.pb = t >>> 16
        this.pc = t & 0xffff
        break
      }
      case 0xdc: {
        const p = this.fetch(2)
        const t = this.rd(p) | (this.rd((p + 1) & 0xffff) << 8) | (this.rd((p + 2) & 0xffff) << 16)
        this.pb = t >>> 16
        this.pc = t & 0xffff
        break
      }
      case 0x20: {
        const t = this.fetch(2)
        this.push(this.pc - 1, 2)
        this.pc = t
        break
      }
      case 0xfc: {
        const p = this.fetch(2)
        // A 65816 addition: its push does not wrap in emulation mode (Clark appendix).
        this.push(this.pc - 1, 2, false)
        this.wrap16 = true
        this.pc = this.rdN((this.pb << 16) | ((p + this.x) & 0xffff), true)
        break
      }
      case 0x22: {
        const t = this.fetch(3)
        this.push(this.pb, 1, false)
        this.push(this.pc - 1, 2, false)
        this.pb = t >>> 16
        this.pc = t & 0xffff
        break
      }
      case 0x60:
        this.pc = (this.pull(2) + 1) & 0xffff
        break
      case 0x6b: {
        const r = this.pull(3, false)
        this.pc = (r + 1) & 0xffff
        this.pb = r >>> 16
        break
      }
      case 0x40:
        this.p = this.pull()
        this.pc = this.pull(2)
        if (!this.e) this.pb = this.pull()
        break
      case 0x00:
        this.trap(0xffe6, 0xfffe)
        break
      case 0x02:
        this.trap(0xffe4, 0xfff4)
        break
      case 0x42:
        // The signature byte is skipped, not read: no bus access on hardware.
        this.pc = (this.pc + 1) & 0xffff
        break
      case 0xcb:
        this.waiting = true
        break
      case 0xdb:
        this.stopped = true
        break
      case 0x48:
        this.push(this.a, w ? 2 : 1)
        break
      case 0x68:
        this.setA(this.nz(this.pull(w ? 2 : 1), w))
        break
      case 0xda:
        this.push(this.x, wx ? 2 : 1)
        break
      case 0xfa:
        this.x = this.nz(this.pull(wx ? 2 : 1), wx)
        break
      case 0x5a:
        this.push(this.y, wx ? 2 : 1)
        break
      case 0x7a:
        this.y = this.nz(this.pull(wx ? 2 : 1), wx)
        break
      case 0x08:
        this.push(this.p)
        break
      case 0x28:
        this.p = this.pull()
        break
      case 0x0b:
        this.push(this.d, 2, false)
        break
      case 0x2b:
        this.d = this.nz(this.pull(2, false), true)
        break
      case 0x4b:
        this.push(this.pb)
        break
      case 0x8b:
        this.push(this.db)
        break
      case 0xab:
        this.db = this.nz(this.pull(1, false), false)
        break
      case 0xf4:
        this.push(this.fetch(2), 2, false)
        break
      case 0xd4: {
        const loc = (this.d + this.fetch(1)) & 0xffff
        this.push(this.dpPtr(loc, 2, false), 2, false)
        break
      }
      case 0x62: {
        const o2 = this.fetch(2)
        this.push(this.pc + o2, 2, false)
        break
      }
      case 0xc2:
        this.p = this.p & ~this.fetch(1)
        break
      case 0xe2:
        this.p = this.p | this.fetch(1)
        break
      case 0xea:
        break
      case 0xfb: {
        // XCE: swap carry and emulation. Entering emulation narrows registers and pins S to page 1.
        const ne = this.c
        this.c = this.e
        this.e = ne // the setter narrows registers and pins S when entering emulation
        break
      }
      case 0xaa:
        this.x = this.nz(wx ? this.a : this.a & 0xff, wx)
        break
      case 0xa8:
        this.y = this.nz(wx ? this.a : this.a & 0xff, wx)
        break
      case 0x8a:
        this.setA(this.nz(this.x, w))
        break
      case 0x98:
        this.setA(this.nz(this.y, w))
        break
      case 0x9b:
        this.y = this.nz(this.x, wx)
        break
      case 0xbb:
        this.x = this.nz(this.y, wx)
        break
      case 0xba:
        this.x = this.nz(wx ? this.s : this.s & 0xff, wx)
        break
      case 0x9a:
        // The e-mode branch here and in TCS is redundant with the post-step S pin (audit #646 F10).
        this.s = this.e ? 0x100 | (this.x & 0xff) : this.x & 0xffff
        break
      case 0x5b:
        this.d = this.nz(this.a, true)
        break
      case 0x7b:
        this.a = this.nz(this.d, true)
        break
      case 0x1b:
        this.s = this.e ? 0x100 | (this.a & 0xff) : this.a & 0xffff
        break
      case 0x3b:
        this.a = this.nz(this.s, true)
        break
      case 0xeb:
        this.a = ((this.a & 0xff) << 8) | (this.a >> 8)
        this.nz(this.a, false)
        break
      case 0xe8:
        this.x = this.nz(this.x + 1, wx)
        break
      case 0xca:
        this.x = this.nz(this.x - 1, wx)
        break
      case 0xc8:
        this.y = this.nz(this.y + 1, wx)
        break
      case 0x88:
        this.y = this.nz(this.y - 1, wx)
        break
      case 0x54:
      case 0x44: {
        // MVN / MVP: one byte per step; the instruction repeats until A wraps to $FFFF.
        const dst = this.fetch(1)
        const src = this.fetch(1)
        const step = op === 0x54 ? 1 : -1
        const mask = this.x8 ? 0xff : 0xffff
        this.db = dst
        this.wr((dst << 16) | this.y, this.rd((src << 16) | this.x))
        this.x = (this.x + step) & mask
        this.y = (this.y + step) & mask
        this.a = (this.a - 1) & 0xffff
        if (this.a !== 0xffff) this.pc = (this.pc - 3) & 0xffff
        break
      }
      default:
        throw new Error(`unhandled opcode $${op.toString(16)}`)
    }
  }
}
