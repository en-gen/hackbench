/**
 * The bounded L1 object-handler interpreter (en-gen/hackbench#664), on
 * synthetic carts only, so every refusal rule is proven where CI runs.
 *
 * Each refusal test has a control beside it that differs by one byte and
 * completes, so a rule that refuses everything cannot pass either.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { fingerprint } from '../../../src/rom/Fingerprint'
import {
  interpret,
  horizontalPlacement,
  applyWrites,
  type InterpretResult,
  type InterpretOptions,
} from '../../../src/rom/objectHandlers/interpret'

const CODE = 0x0d8000
const DISPATCH = 0x0d9000
const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const lo = (w: number): number => w & 0xff
const hi = (w: number): number => (w >> 8) & 0xff

/** A few-line assembler: bytes, labels, and 8-bit branch / 16-bit JSR fixups. */
class Asm {
  bytes: number[] = []
  labels = new Map<string, number>()
  fix: [number, string, 'rel' | 'abs'][] = []
  constructor(readonly org: number) {}
  get pc(): number {
    return this.org + this.bytes.length
  }
  at(name: string): this {
    this.labels.set(name, this.pc)
    return this
  }
  b(...bs: number[]): this {
    this.bytes.push(...bs)
    return this
  }
  br(op: number, label: string): this {
    this.fix.push([this.bytes.length + 1, label, 'rel'])
    return this.b(op, 0)
  }
  call(op: number, label: string): this {
    this.fix.push([this.bytes.length + 1, label, 'abs'])
    return this.b(op, 0, 0)
  }
  build(): number[] {
    for (const [i, label, kind] of this.fix) {
      const t = this.labels.get(label)
      if (t === undefined) throw new Error(label)
      if (kind === 'rel') this.bytes[i] = (t - (this.org + i + 1)) & 0xff
      else [this.bytes[i], this.bytes[i + 1]] = [lo(t), hi(t)]
    }
    return this.bytes
  }
}

/** A blank LoROM cart (all BRK, which is outside the allowed set) with `code` at CODE. */
function cart(code: number[], extra: [number, number[]][] = []): RomFile {
  const bytes = new Uint8Array(0x80000)
  bytes.set(code, off(CODE))
  for (const [a, b] of extra) bytes.set(b, off(a))
  return RomFile.fromBytes('synthetic', bytes)
}

/** Screen 0, row 2, column 0; tileset 0; size as given. */
const place = (size = 0) => horizontalPlacement('standard', 1, size, 0, 2)
const run = (rom: RomFile, size = 0, opts: InterpretOptions = {}): InterpretResult =>
  interpret(rom, CODE, place(size), { tileset: 0 }, opts)

const RTS = 0x60
const STA_PTR_Y = [0x97, 0x6b] // STA [Map16LowPtr],Y
const LDY_POS = [0xa4, 0x57]

describe('interpret: straight-line writes', () => {
  it('writes an immediate at the object position and completes', () => {
    const r = run(cart([...LDY_POS, 0xa9, 0x42, ...STA_PTR_Y, RTS]))
    expect(r.refusal).toBeNull()
    expect(r.writes).toEqual([{ addr: 0x7ec800 + 0x20, value: 0x42 }])
  })

  it('applyWrites folds the high byte into the tile as its page', () => {
    const grid = Array.from({ length: 27 }, () => new Array(32).fill(0x25))
    applyWrites(grid, [
      { addr: 0x7ec800 + 0x1b0 + 0x23, value: 0x42 },
      { addr: 0x7fc800 + 0x1b0 + 0x23, value: 0x01 },
    ])
    expect(grid[2][19]).toBe(0x142)
  })
})

describe('interpret: refusal rules, each beside a control that completes', () => {
  it('refuses an opcode outside the allowed set', () => {
    expect(run(cart([0xea, RTS])).refusal?.reason).toMatch(/opcode \$EA/)
    expect(run(cart([0x18, RTS])).refusal).toBeNull()
  })

  it('refuses an unknown value at a branch', () => {
    const body = (dp: number) => cart([0xa5, dp, 0xf0, 0x00, RTS]) // LDA dp; BEQ +0
    expect(run(body(0x20)).refusal?.reason).toMatch(/branch/)
    expect(run(body(0x59)).refusal).toBeNull()
  })

  it('refuses an unknown index', () => {
    const body = (dp: number) => cart([0xa6, dp, 0xbf, 0x00, 0x80, 0x0d, RTS]) // LDX dp; LDA long,X
    expect(run(body(0x20)).refusal?.reason).toMatch(/index/)
    expect(run(body(0x59)).refusal).toBeNull()
  })

  it('refuses an unknown value written to the tile buffer', () => {
    const body = (dp: number) => cart([...LDY_POS, 0xa5, dp, ...STA_PTR_Y, RTS])
    expect(run(body(0x20)).refusal?.reason).toMatch(/unknown value/)
    expect(run(body(0x59)).refusal).toBeNull()
  })

  it('refuses a pointer with an unknown byte', () => {
    const body = (dp: number) => cart([0xa0, 0x00, 0xb7, dp, RTS]) // LDY #0; LDA [dp],Y
    expect(run(body(0x20)).refusal?.reason).toMatch(/pointer/)
    expect(run(body(0x6b)).refusal).toBeNull()
  })

  it('refuses a read of unmodelled RAM', () => {
    const body = (a: number) => cart([0xad, lo(a), hi(a), RTS]) // LDA abs
    expect(run(body(0x0100)).refusal?.reason).toMatch(/unmodelled RAM/)
    expect(run(body(0x1928)).refusal).toBeNull()
  })

  it('refuses a write outside the tile buffer', () => {
    const body = (a: number) => cart([0xa9, 0x01, 0x8d, lo(a), hi(a), RTS]) // STA abs
    expect(run(body(0x1234)).refusal?.reason).toMatch(/write outside/)
    expect(run(body(0x1ba1)).refusal).toBeNull()
  })

  it('refuses a buffer pointer that has run below the buffer', () => {
    // LDA #page; STA $6C; LDY #$F0; LDA #1; STA [$6B],Y. $7EC7F0 is before Map16TilesLow.
    const body = (page: number) =>
      cart([0xa9, page, 0x85, 0x6c, 0xa0, 0xf0, 0xa9, 1, ...STA_PTR_Y, RTS])
    expect(run(body(0xc7)).refusal?.reason).toMatch(/write outside/)
    expect(run(body(0xc8)).refusal).toBeNull()
  })

  it('refuses a return over pushed data', () => {
    expect(run(cart([0x48, RTS])).refusal?.reason).toMatch(/return/) // PHA; RTS
    expect(run(cart([0x48, 0x68, RTS])).refusal).toBeNull() // PHA; PLA; RTS
  })

  it('refuses at the step budget and the write budget', () => {
    const spin = cart([0x4c, lo(CODE), hi(CODE)]) // JMP self
    expect(run(spin, 0, { stepBudget: 1000 }).refusal?.reason).toMatch(/step budget/)
    // Write the same cell 16 times: X counts down from $0F.
    const writes = cart([...LDY_POS, 0xa2, 0x0f, 0xa9, 1, ...STA_PTR_Y, 0xca, 0x10, 0xfb, RTS])
    expect(run(writes, 0, { writeBudget: 15 }).refusal?.reason).toMatch(/write budget/)
    expect(run(writes, 0, { writeBudget: 16 }).refusal).toBeNull()
  })

  it('refuses execution that leaves ROM', () => {
    expect(run(cart([0x4c, 0x00, 0x10])).refusal?.reason).toMatch(/left ROM/) // JMP $1000
    // $40:0000 is backed by a 2.25 MB cart but is not the code half of a bank.
    const big = new Uint8Array(0x240000)
    big.set([0x4c, 0x00, 0x00], 0x200000) // at $40:8000: JMP $0000
    const r = interpret(RomFile.fromBytes('big', big), 0x408000, place(), { tileset: 0 })
    expect(r.refusal?.reason).toMatch(/left ROM at \$400000/)
  })

  it('refuses REP/SEP of flags other than M and X', () => {
    expect(run(cart([0xe2, 0x08, RTS])).refusal?.reason).toMatch(/REP\/SEP/) // SEP #$08: decimal
    expect(run(cart([0xe2, 0x30, RTS])).refusal).toBeNull()
  })
})

describe('interpret: arithmetic, flags and block moves', () => {
  it('computes carry the way the 65816 does', () => {
    // Each probe leaves C, then LDA #0 : ADC #0 writes it as 0 or 1.
    const carry = [0xa9, 0x00, 0x69, 0x00, ...STA_PTR_Y, 0xc8]
    // prettier-ignore
    const r = run(cart([...LDY_POS,
      0x18, 0xa9, 0xff, 0x69, 0x01, ...carry, // $FF + 1 carries
      0x18, 0xa9, 0xfe, 0x69, 0x01, ...carry, // $FE + 1 does not
      0x38, 0xa9, 0x00, 0xe9, 0x01, ...carry, // 0 - 1 borrows: C clear
      0xa2, 0x05, 0xe0, 0x05, ...carry, // CPX equal sets C
      0xa2, 0x04, 0xe0, 0x05, ...carry, // CPX below clears C
      0xa9, 0x01, 0x4a, ...carry, // LSR shifts bit 0 into C
      0xa9, 0x80, 0x0a, ...carry, // ASL shifts bit 7 into C
      RTS]))
    expect(r.refusal).toBeNull()
    expect(r.writes.map(w => w.value)).toEqual([1, 0, 0, 1, 0, 1, 1])
  })

  it('refuses a block move outside the tile buffer, and copies inside it', () => {
    // REP #$30; LDA #1; LDX #src; LDY #$C910; MVN bank,bank; SEP #$30; RTS
    // prettier-ignore
    const mvn = (bank: number, src: number) =>
      cart([0xc2, 0x30, 0xa9, 1, 0, 0xa2, lo(src), hi(src), 0xa0, 0x10, 0xc9, 0x54, bank, bank, 0xe2, 0x30, RTS])
    expect(run(mvn(0x7e, 0x0100)).refusal?.reason).toMatch(/unmodelled RAM/)
    expect(run(mvn(0x7d, 0xc800)).refusal?.reason).toMatch(/block move/)
    const ok = run(mvn(0x7e, 0xc800))
    expect(ok.refusal).toBeNull()
    expect(ok.writes).toEqual([
      { addr: 0x7ec910, value: 0x25 },
      { addr: 0x7ec911, value: 0x25 },
    ])
  })
})

describe('interpret: inline-table dispatch (ExecutePtrLong)', () => {
  // A stand-in for the stock routine: the interpreter never executes these
  // bytes, it recognizes their fingerprint and applies the modelled effect.
  const SIG = Array.from({ length: 36 }, (_, i) => (i * 37 + 11) & 0xff)
  const opts = { dispatchFingerprint: fingerprint(Uint8Array.from(SIG))! }
  const TARGET = 0x0d8100
  // LDY $57; LDA #1; JSL DISPATCH; dl <null>, dl TARGET. The JSL sits at CODE+4.
  // prettier-ignore
  const body = [0xa9, 0x01, 0x22, lo(DISPATCH), hi(DISPATCH), 0x0d, 0, 0, 0, lo(TARGET), hi(TARGET), 0x0d]
  // TARGET writes A, then _0, _3, _4, _5 and the carry, one per column.
  const put = [...STA_PTR_Y, 0xc8]
  // prettier-ignore
  const target: [number, number[]] = [TARGET, [
    ...put, 0xa5, 0x00, ...put, 0xa5, 0x03, ...put, 0xa5, 0x04, ...put, 0xa5, 0x05, ...put,
    0xa9, 0x00, 0x69, 0x00, ...put, RTS,
  ]]
  const withSig = (sig: number[]) => cart([...LDY_POS, ...body], [target, [DISPATCH, sig]])

  it('dispatches through the inline table and leaves the routine`s side effects', () => {
    const r = run(withSig(SIG), 0, opts)
    expect(r.refusal).toBeNull()
    expect(r.dispatches).toEqual([TARGET])
    // A = target bits 8-15, _0 = target low, _3/_4 = return address high/bank
    // (JSL at CODE+4 pushes CODE+7), _5 = the caller's Y, carry clear. Y is
    // restored, so the first write lands at the object position.
    expect(r.writes.map(w => w.value)).toEqual([0x81, 0x00, 0x80, 0x0d, 0x20, 0x00])
    expect(r.writes[0].addr).toBe(0x7ec820)
  })

  it('refuses when any one of the 36 pinned bytes differs', () => {
    const passed: number[] = []
    for (let i = 0; i < SIG.length; i++) {
      const sig = SIG.slice()
      sig[i] ^= 0x01
      const r = run(withSig(sig), 0, opts)
      if (!/JSL/.test(r.refusal?.reason ?? '')) passed.push(i)
    }
    expect(passed).toEqual([])
  })

  it('refuses a table entry that is not ROM', () => {
    const b = body.slice()
    b[1] = 0x00 // index 0: the zero entry, $00:0000
    const r = run(cart([...LDY_POS, ...b], [target, [DISPATCH, SIG]]), 0, opts)
    expect(r.refusal?.reason).toMatch(/not ROM/)
  })
})

describe('interpret: a CODE_0DADEB-shaped staircase (bank_0D.asm:2671, #652)', () => {
  // Helpers written from bank_0D.asm:1635-1651 and 1996-2031, 2107-2115.
  // They run inline, as the stock ones do. Tile values are invented.
  function staircase(step = 0x04, stop = 0x07): RomFile {
    const a = new Asm(CODE)
    a.b(...LDY_POS, 0xa2, 0x03, 0x86, 0x02).call(0x20, 'save') // LDX #3; STX _2
    a.b(0xa5, 0x59, 0x4a, 0x4a, 0x4a, 0x4a, 0x85, 0x00, 0xe6, 0x00).call(0x4c, 'lips')
    a.at('fill').call(0x20, 'page0').b(0xa9, 0x11).call(0x20, 'write').b(0xca)
    a.at('loop').b(0xe0, stop).br(0xd0, 'fill') // CPX #stop; BNE fill
    for (const t of [0x21, 0x22, 0x23, 0x24]) a.call(0x20, 'page1').b(0xa9, t).call(0x20, 'write')
    a.b(0xca, 0xca, 0xca, 0xca, 0xa5, 0x00).br(0xf0, 'done')
    a.at('lips')
    for (const t of [0x31, 0x32, 0x33, 0x34]) a.call(0x20, 'page1').b(0xa9, t).call(0x20, 'write')
    a.call(0x20, 'restore').call(0x20, 'row')
    a.b(0xa5, 0x02, 0x18, 0x69, step, 0x85, 0x02, 0xa6, 0x02, 0xc6, 0x00).br(0x10, 'more')
    a.at('done').b(RTS)
    a.at('more').call(0x4c, 'loop')
    a.at('page0').b(0xa9, 0x00, 0x97, 0x6e, RTS)
    a.at('page1').b(0xa9, 0x01, 0x97, 0x6e, RTS)
    a.at('save').b(0xa5, 0x6b, 0x85, 0x04, 0xa5, 0x6c, 0x85, 0x05, RTS)
    a.at('restore').b(0xa5, 0x04, 0x85, 0x6b, 0x85, 0x6e, 0xa5, 0x05, 0x85, 0x6c, 0x85, 0x6f)
    a.b(0xad, 0x28, 0x19, 0x8d, 0xa1, 0x1b, RTS)
    a.at('write')
      .b(...STA_PTR_Y, 0xc8, 0x98, 0x29, 0x0f)
      .br(0xd0, 'wdone')
    a.b(0xa5, 0x6b, 0x18, 0x69, 0xb0, 0x85, 0x6b, 0x85, 0x6e, 0xa5, 0x6c, 0x69, 0x01, 0x85, 0x6c)
    a.b(0x85, 0x6f, 0xee, 0xa1, 0x1b, 0xa5, 0x57, 0x29, 0xf0, 0xa8)
    a.at('wdone').b(RTS)
    a.at('row').b(0xa5, 0x57, 0x18, 0x69, 0x10, 0x85, 0x57, 0xa8).br(0x90, 'rdone')
    a.b(0xa5, 0x6c, 0x69, 0x00, 0x85, 0x6c, 0x85, 0x6f, 0x85, 0x05)
    a.at('rdone').b(RTS)
    return cart(a.build())
  }

  /** Row -> the columns holding the first lip tile ($131). */
  function lipColumns(rom: RomFile, size: number): Map<number, number[]> {
    const r = run(rom, size)
    expect(r.refusal).toBeNull()
    const grid = Array.from({ length: 27 }, () => new Array(32).fill(0x25))
    applyWrites(grid, r.writes)
    const out = new Map<number, number[]>()
    grid.forEach((row, y) =>
      row.forEach((t, x) => t === 0x131 && out.set(y, [...(out.get(y) ?? []), x])),
    )
    return out
  }

  it('steps four columns right per row, one lip per row', () => {
    expect(lipColumns(staircase(), 0x30)).toEqual(
      new Map([
        [2, [0]],
        [3, [4]],
        [4, [8]],
        [5, [12]],
      ]),
    )
  })

  it('draws a different shape when the ADC #$04 step is mutated', () => {
    const base = run(staircase(), 0x20).writes
    expect(run(staircase(0x05), 0x20).writes).not.toEqual(base)
    expect(lipColumns(staircase(0x08), 0x10)).toEqual(
      new Map([
        [2, [0]],
        [3, [8]],
      ]),
    )
  })

  it('draws a different shape when the CPX #$07 stop is mutated', () => {
    expect(lipColumns(staircase(0x04, 0x06), 0x10)).toEqual(
      new Map([
        [2, [0]],
        [3, [5]],
      ]),
    )
  })
})
