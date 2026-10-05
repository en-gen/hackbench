/**
 * Cpu65816.ts -- SPIKE: a concrete (not abstract) 65816 core over WRAM + a cart,
 * to measure whether a sprite's own routines can be RUN instead of hand-described.
 * Not wired to anything; see docs/ideas/sprite-gfx-interpreter.md.
 *
 * Differs from src/rom/objectHandlers/interpret.ts on purpose: that one tracks
 * UNKNOWN values and refuses on them, which suits a level loader whose inputs
 * are mostly dead. A sprite's main routine reads Mario, the frame counter and
 * Map16 on its way to the draw call, so here every byte is concrete (zero until
 * seeded) and the run is judged by its OAM output, not by "no unknowns".
 *
 * Native mode only (E=0): CallSpriteMain is entered that way. Decimal ADC/SBC
 * and the system opcodes refuse, and the refusal names the opcode, because that
 * list is the measurement. Register space ($2000-$5FFF) reads 0 and its writes
 * are counted as hardware touches, never performed.
 */
import type { RomFile } from '../RomFile'

export class Refusal extends Error {}

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
def('DEC', [
  [0xc6, 'dp'],
  [0xce, 'abs'],
  [0xd6, 'dpx'],
  [0xde, 'absx'],
  [0x3a, 'acc'],
])
def('INC', [
  [0xe6, 'dp'],
  [0xee, 'abs'],
  [0xf6, 'dpx'],
  [0xfe, 'absx'],
  [0x1a, 'acc'],
])
def('TSB', [
  [0x04, 'dp'],
  [0x0c, 'abs'],
])
def('TRB', [
  [0x14, 'dp'],
  [0x1c, 'abs'],
])
def('BIT', [
  [0x24, 'dp'],
  [0x2c, 'abs'],
  [0x34, 'dpx'],
  [0x3c, 'absx'],
  [0x89, 'imm'],
])
def('LDX', [
  [0xa2, 'imm'],
  [0xa6, 'dp'],
  [0xae, 'abs'],
  [0xb6, 'dpy'],
  [0xbe, 'absy'],
])
def('LDY', [
  [0xa0, 'imm'],
  [0xa4, 'dp'],
  [0xac, 'abs'],
  [0xb4, 'dpx'],
  [0xbc, 'absx'],
])
def('STX', [
  [0x86, 'dp'],
  [0x8e, 'abs'],
  [0x96, 'dpy'],
])
def('STY', [
  [0x84, 'dp'],
  [0x8c, 'abs'],
  [0x94, 'dpx'],
])
def('STZ', [
  [0x64, 'dp'],
  [0x74, 'dpx'],
  [0x9c, 'abs'],
  [0x9e, 'absx'],
])
def('CPX', [
  [0xe0, 'imm'],
  [0xe4, 'dp'],
  [0xec, 'abs'],
])
def('CPY', [
  [0xc0, 'imm'],
  [0xc4, 'dp'],
  [0xcc, 'abs'],
])
const INDEX_OPS = new Set(['LDX', 'LDY', 'STX', 'STY', 'CPX', 'CPY'])

export interface RunResult {
  steps: number
  /** Opcode byte -> times executed. */
  ops: Map<number, number>
  /** JSL/JML long targets, in first-seen order. */
  longCalls: Set<number>
  /** Writes into $2000-$5FFF (PPU, DMA, APU ports): what cannot be replayed. */
  hwWrites: number
  refusal: { reason: string; at: number } | null
}

export class Cpu {
  readonly wram = new Uint8Array(0x20000)
  a = 0
  x = 0
  y = 0
  s = 0x1ff
  d = 0
  db = 1
  pb = 1
  pc = 0
  n = false
  v = false
  z = false
  c = false
  dec = false
  m8 = true
  x8 = true
  /** Called for every WRAM write, for OAM capture. */
  onWrite: ((wramAddr: number) => void) | null = null
  hw = 0
  /** WRAM offsets already written by this run; a read of one that is not here is an INPUT. */
  written = new Uint8Array(0x20000)
  /** Inputs: WRAM offsets read before the run wrote them (seeds and implicit zeros alike). */
  extReads = new Set<number>()
  /** Writes to $4202-$4206 feed the CPU's multiply/divide unit; reads of its result are modelled. */
  private mul = { a: 0, b: 0, dividend: 0, quot: 0, rem: 0 }
  /** Addresses of instructions that wrote register space. */
  hwAt = new Set<number>()
  /** Debug: every instruction address executed, when set. */
  trace: number[] | null = null
  /** Address of the instruction being executed (valid inside onWrite). */
  at = 0
  private s0 = 0
  private header: number
  constructor(private rom: RomFile) {
    this.header = rom.hasHeader ? rom.buffer.length - rom.romSize : 0
    if (rom.mapMode === 'hirom') throw new Refusal('HiROM image: LoROM only in this spike')
  }

  rd(a: number): number {
    a &= 0xffffff
    const bank = a >>> 16
    const lo = a & 0xffff
    let w = -1
    if (bank === 0x7e) w = lo
    else if (bank === 0x7f) w = 0x10000 + lo
    else if ((bank & 0x7f) < 0x40 && lo < 0x2000) w = lo
    if (w >= 0) {
      if (!this.written[w]) this.extReads.add(w)
      return this.wram[w]
    }
    if ((bank & 0x7f) < 0x40 && lo >= 0x4214 && lo <= 0x4217) {
      const m = this.mul
      return [m.quot & 0xff, m.quot >> 8, m.rem & 0xff, m.rem >> 8][lo - 0x4214]
    }
    if (lo < 0x8000) return 0
    const o = (bank & 0x7f) * 0x8000 + (lo & 0x7fff)
    return o < this.rom.romSize ? this.rom.buffer[o + this.header] : 0
  }
  wr(a: number, v: number): void {
    a &= 0xffffff
    const bank = a >>> 16
    const lo = a & 0xffff
    let w = -1
    if (bank === 0x7e) w = lo
    else if (bank === 0x7f) w = 0x10000 + lo
    else if ((bank & 0x7f) < 0x40 && lo < 0x2000) w = lo
    else if ((bank & 0x7f) < 0x40 && lo >= 0x2000 && lo < 0x6000) {
      this.hw++
      this.hwAt.add(this.at)
      const m = this.mul
      v &= 0xff
      if (lo === 0x4202) m.a = v
      else if (lo === 0x4203) {
        m.b = v
        m.rem = m.a * v
      } // WRMPYB starts the multiply; RDMPY is $4216/7
      else if (lo === 0x4204) m.dividend = (m.dividend & 0xff00) | v
      else if (lo === 0x4205) m.dividend = (m.dividend & 0xff) | (v << 8)
      else if (lo === 0x4206) {
        m.quot = v ? Math.floor(m.dividend / v) : 0xffff
        m.rem = v ? m.dividend % v : m.dividend
      }
    }
    if (w >= 0) {
      this.wram[w] = v & 0xff
      this.written[w] = 1
      this.onWrite?.(w)
    }
  }
  private rdN(a: number, wide: boolean): number {
    return wide ? this.rd(a) | (this.rd(a + 1) << 8) : this.rd(a)
  }
  private wrN(a: number, v: number, wide: boolean): void {
    this.wr(a, v)
    if (wide) this.wr(a + 1, v >> 8)
  }
  private fetch(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v |= this.rd((this.pb << 16) | ((this.pc + i) & 0xffff)) << (8 * i)
    this.pc = (this.pc + n) & 0xffff
    return v
  }
  private push(v: number, n = 1): void {
    for (let i = n - 1; i >= 0; i--) {
      this.wr(this.s, v >> (8 * i))
      this.s = (this.s - 1) & 0xffff
    }
  }
  private pull(n = 1): number {
    let v = 0
    for (let i = 0; i < n; i++) {
      this.s = (this.s + 1) & 0xffff
      v |= this.rd(this.s) << (8 * i)
    }
    return v
  }
  private get P(): number {
    return (
      (+this.n << 7) |
      (+this.v << 6) |
      (+this.m8 << 5) |
      (+this.x8 << 4) |
      (+this.dec << 3) |
      (+this.z << 1) |
      +this.c
    )
  }
  private set P(p: number) {
    this.n = !!(p & 0x80)
    this.v = !!(p & 0x40)
    this.m8 = !!(p & 0x20)
    this.x8 = !!(p & 0x10)
    this.dec = !!(p & 8)
    this.z = !!(p & 2)
    this.c = !!(p & 1)
    if (this.x8) {
      this.x &= 0xff
      this.y &= 0xff
    }
  }
  private nz(v: number, wide: boolean): number {
    v &= wide ? 0xffff : 0xff
    this.z = v === 0
    this.n = (v & (wide ? 0x8000 : 0x80)) !== 0
    return v
  }
  private dpAddr(o: number): number {
    return (this.d + o) & 0xffff
  }
  private ptr(a: number, n: 2 | 3): number {
    return this.rdN(a, true) | (n === 3 ? this.rd(a + 2) << 16 : 0)
  }

  /** Effective address of a memory operand; also consumes its operand bytes. */
  private ea(mode: Mode): number {
    const dbase = this.db << 16
    switch (mode) {
      case 'dp':
        return this.dpAddr(this.fetch(1))
      case 'dpx':
        return this.dpAddr(this.fetch(1) + this.x)
      case 'dpy':
        return this.dpAddr(this.fetch(1) + this.y)
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
        return dbase + this.ptr(this.dpAddr(this.fetch(1) + this.x), 2)
      case 'ind':
        return dbase + this.ptr(this.dpAddr(this.fetch(1)), 2)
      case 'indy':
        return (dbase + this.ptr(this.dpAddr(this.fetch(1)), 2) + this.y) & 0xffffff
      case 'indl':
        return this.ptr(this.dpAddr(this.fetch(1)), 3)
      case 'indly':
        return (this.ptr(this.dpAddr(this.fetch(1)), 3) + this.y) & 0xffffff
      case 'sr':
        return (this.s + this.fetch(1)) & 0xffff
      case 'sriy':
        return (dbase + this.ptr((this.s + this.fetch(1)) & 0xffff, 2) + this.y) & 0xffffff
    }
    throw new Refusal(`mode ${mode}`)
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
        // ADC, SBC
        if (this.dec) throw new Refusal('decimal-mode arithmetic')
        const b = name === 'SBC' ? ~v & mask : v
        const r = a + b + +this.c
        this.c = r > mask
        this.v = (~(a ^ b) & (a ^ r) & (wide ? 0x8000 : 0x80)) !== 0
        this.setA(this.nz(r, wide))
      }
    }
  }
  private setA(v: number): void {
    this.a = this.m8 ? (this.a & 0xff00) | (v & 0xff) : v & 0xffff
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

  /**
   * Run `entry` as a JSR (or JSL) callee until it returns over the frame this
   * call pushed. `ops` is the executed-opcode census.
   */
  run(entry: number, kind: 'jsr' | 'jsl', budget = 400_000): RunResult {
    const res: RunResult = {
      steps: 0,
      ops: new Map(),
      longCalls: new Set(),
      hwWrites: 0,
      refusal: null,
    }
    this.s0 = this.s
    this.push(0xffffff, kind === 'jsl' ? 3 : 2)
    this.pb = entry >>> 16
    this.pc = entry & 0xffff
    const hw0 = this.hw
    let at = entry
    this.at = entry
    try {
      for (;;) {
        if (++res.steps > budget) throw new Refusal('step budget')
        at = this.at = (this.pb << 16) | this.pc
        this.trace?.push(at)
        const op = this.fetch(1)
        res.ops.set(op, (res.ops.get(op) ?? 0) + 1)
        if (this.exec(op, res)) break
      }
    } catch (e) {
      if (!(e instanceof Refusal)) throw e
      res.refusal = { reason: e.message, at }
    }
    res.hwWrites = this.hw - hw0
    this.s = this.s0
    return res
  }

  /** Executes one instruction; true when the callee returned over the entry frame. */
  private exec(op: number, res: RunResult): boolean {
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
      return false
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
            this.wrN(a, v | this.a, w)
            break
          case 'TRB':
            this.z = (this.a & v) === 0
            this.wrN(a, v & ~this.a, w)
            break
          case 'INC':
          case 'DEC':
            this.wrN(a, this.nz(v + (name === 'INC' ? 1 : -1), w), w)
            break
          default:
            this.wrN(a, this.shift(name, v, w), w)
        }
      }
      return false
    }
    switch (op) {
      case 0x10:
        this.branch(!this.n)
        break
      case 0x30:
        this.branch(this.n)
        break
      case 0x50:
        this.branch(!this.v)
        break
      case 0x70:
        this.branch(this.v)
        break
      case 0x90:
        this.branch(!this.c)
        break
      case 0xb0:
        this.branch(this.c)
        break
      case 0xd0:
        this.branch(!this.z)
        break
      case 0xf0:
        this.branch(this.z)
        break
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
      case 0x6c:
        this.pc = this.rdN(this.fetch(2), true)
        break
      case 0x7c:
        this.pc = this.rdN((this.pb << 16) | ((this.fetch(2) + this.x) & 0xffff), true)
        break
      case 0x5c:
      case 0xdc: {
        const t = op === 0x5c ? this.fetch(3) : this.ptr(this.fetch(2), 3)
        res.longCalls.add(t)
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
        const t = this.rdN((this.pb << 16) | ((this.fetch(2) + this.x) & 0xffff), true)
        this.push(this.pc - 1, 2)
        this.pc = t
        break
      }
      case 0x22: {
        const t = this.fetch(3)
        res.longCalls.add(t)
        this.push((this.pb << 16) | ((this.pc - 1) & 0xffff), 3)
        this.pb = t >>> 16
        this.pc = t & 0xffff
        break
      }
      case 0x60:
      case 0x6b: {
        const ret = this.pull(op === 0x60 ? 2 : 3)
        if (this.s === this.s0) return true
        this.pc = (ret + 1) & 0xffff
        if (op === 0x6b) this.pb = ret >>> 16
        break
      }
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
        this.push(this.P)
        break
      case 0x28:
        this.P = this.pull()
        break
      case 0x0b:
        this.push(this.d, 2)
        break
      case 0x2b:
        this.d = this.nz(this.pull(2), true)
        break
      case 0x4b:
        this.push(this.pb)
        break
      case 0x8b:
        this.push(this.db)
        break
      case 0xab:
        this.db = this.nz(this.pull(), false)
        break
      case 0xf4:
        this.push(this.fetch(2), 2)
        break
      case 0xd4:
        this.push(this.rdN(this.dpAddr(this.fetch(1)), true), 2)
        break
      case 0x62: {
        const o2 = this.fetch(2)
        this.push(this.pc + o2, 2)
        break
      }
      case 0xc2:
        this.P = this.P & ~this.fetch(1)
        break
      case 0xe2:
        this.P = this.P | this.fetch(1)
        break
      case 0x18:
        this.c = false
        break
      case 0x38:
        this.c = true
        break
      case 0xd8:
        this.dec = false
        break
      case 0xf8:
        this.dec = true
        break
      case 0xb8:
        this.v = false
        break
      case 0x78:
      case 0x58:
      case 0xea:
        break // SEI, CLI, NOP: no interrupts here
      case 0xaa:
        this.x = this.nz(wx ? this.a & 0xff : this.a, wx)
        break
      case 0xa8:
        this.y = this.nz(wx ? this.a & 0xff : this.a, wx)
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
        this.x = this.nz(this.s, wx)
        break
      case 0x9a:
        this.s = this.x & 0xffff
        break
      case 0x5b:
        this.d = this.nz(this.a, true)
        break
      case 0x7b:
        this.a = this.nz(this.d, true)
        break
      case 0x1b:
        this.s = this.a & 0xffff
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
        // MVN / MVP: operands are dst bank, src bank
        const dst = this.fetch(1)
        const src = this.fetch(1)
        const step = op === 0x54 ? 1 : -1
        for (let n = (this.a & 0xffff) + 1; n > 0; n--) {
          this.wr((dst << 16) | this.y, this.rd((src << 16) | this.x))
          this.x = (this.x + step) & 0xffff
          this.y = (this.y + step) & 0xffff
        }
        this.a = 0xffff
        this.db = dst
        break
      }
      default:
        throw new Refusal(`opcode $${op.toString(16).padStart(2, '0')}`)
    }
    return false
  }
}
