/**
 * The bounded L1 object-handler interpreter (en-gen/hackbench#351), on
 * synthetic carts only, so every refusal rule is proven where CI runs.
 *
 * Each refusal sits beside a control that differs by as little as possible
 * and completes, so a rule that refuses everything cannot pass either.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  createGrid,
  expandMapOwned,
  expandObject,
  TILE_EMPTY,
} from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import { OWNER_NONE, makeCursor } from '../../../src/rom/objectHandlers/cursor'
import { STANDARD_HANDLERS } from '../../../src/rom/objectHandlers/dispatch'
import {
  ADDR_TILESET_DISPATCH,
  STANDARD_HANDLER_COUNT,
} from '../../../src/rom/objectHandlers/romData'
import { fingerprint } from '../../../src/rom/Fingerprint'
import {
  interpret,
  horizontalPlacement,
  applyWrites,
  type InterpretResult,
  type InterpretOptions,
  type InterpretEnv,
  type Placement,
} from '../../../src/rom/objectHandlers/interpret'

const CODE = 0x0d8000
const DISPATCH = 0x0d9000
const off = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)
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
function cart(code: number[], extra: [number, number[]][] = [], size = 0x80000): RomFile {
  const bytes = new Uint8Array(size)
  bytes.set(code, off(CODE))
  for (const [a, b] of extra) bytes.set(b, off(a))
  return RomFile.fromBytes('synthetic', bytes)
}

/** Screen 1, row 2, column 0; tileset 0; size as given. */
const place = (size = 0): Placement => horizontalPlacement('standard', 1, size, 16, 2)
const BASE = 0x7ec800 + 0x1b0
/** Tests enter the handler directly, so the entry frame is a JSR's. */
const run = (
  rom: RomFile,
  size = 0,
  opts: InterpretOptions = {},
  env: InterpretEnv = { tileset: 0 },
  at: Placement = place(size),
): InterpretResult => interpret(rom, CODE, at, env, { entryCall: 'jsr', ...opts })
const values = (r: InterpretResult): number[] => {
  expect(r.refusal).toBeNull()
  return r.writes.map(w => w.value)
}

const RTS = 0x60
const STA_PTR_Y = [0x97, 0x6b] // STA [Map16LowPtr],Y
const LDY_POS = [0xa4, 0x57]
const PUT = [...STA_PTR_Y, 0xc8] // STA [Map16LowPtr],Y; INY
/** `Bxx` over a marker write: `mark` lands iff the branch is not taken. */
const unlessBranch = (op: number, mark: number) => [op, 0x05, 0xa9, mark, ...PUT]
const REP = (f: number) => [0xc2, f]
const SEP = (f: number) => [0xe2, f]

/** [name, refusing code, control code, reason, refusing opts, control opts, cart size] */
type Pair = [string, number[], number[], RegExp, InterpretOptions?, InterpretOptions?, number?]
// prettier-ignore
const PAIRS: Pair[] = [
  ['an opcode outside the allowed set', [0xea, RTS], [0x18, RTS], /opcode \$EA/],
  ['an unknown value at a branch', [0xa5, 0x20, 0xf0, 0, RTS], [0xa5, 0x59, 0xf0, 0, RTS], /branch/],
  ['an unknown X index', [0xa6, 0x20, 0xbf, 0, 0x80, 0x0d, RTS], [0xa6, 0x59, 0xbf, 0, 0x80, 0x0d, RTS], /index X/],
  ['an unknown Y index', [0xa4, 0x20, 0xa9, 1, ...STA_PTR_Y, RTS], [...LDY_POS, 0xa9, 1, ...STA_PTR_Y, RTS], /index Y/],
  ['an unknown value written to the buffer', [...LDY_POS, 0xa5, 0x20, ...STA_PTR_Y, RTS], [...LDY_POS, 0xa5, 0x59, ...STA_PTR_Y, RTS], /unknown value/],
  ['a pointer with an unknown byte', [0xa0, 0, 0xb7, 0x20, RTS], [0xa0, 0, 0xb7, 0x6b, RTS], /pointer/],
  // [$FF] reads $FF, $100, $101 in native mode; a wrap to $00/$01 would find known bytes.
  ['a pointer at $FF that reads $100',
    [0xa9, 0, 0x85, 0xfd, 0xa9, 0x80, 0x85, 0xfe, 0xa9, 0x0d, 0x85, 0xff, 0x85, 0, 0x85, 1, 0xa0, 0, 0xb7, 0xff, RTS],
    [0xa9, 0, 0x85, 0xfd, 0xa9, 0x80, 0x85, 0xfe, 0xa9, 0x0d, 0x85, 0xff, 0x85, 0, 0x85, 1, 0xa0, 0, 0xb7, 0xfd, RTS],
    /unmodelled RAM \$7E0100/],
  ['a read of unmodelled RAM', [0xad, 0x00, 0x01, RTS], [0xad, 0x28, 0x19, RTS], /unmodelled RAM/],
  ['a long read of SRAM ($70:0000) on a 4 MB cart',
    [0xa2, 0, 0xbf, 0x00, 0x00, 0x70, RTS], [0xa2, 0, 0xbf, 0x00, 0x80, 0x70, RTS], /unmodelled address \$700000/,
    {}, {}, 0x400000],
  ['a write outside the tile buffer', [0xa9, 1, 0x8d, 0x34, 0x12, RTS], [0xa9, 1, 0x8d, 0xa1, 0x1b, RTS], /write outside/],
  ['a buffer pointer below Map16TilesLow',
    [0xa9, 0, 0x85, 0x6b, 0xa9, 0xc7, 0x85, 0x6c, 0xa0, 0xf0, 0xa9, 1, ...STA_PTR_Y, RTS],
    [0xa9, 0, 0x85, 0x6b, 0xa9, 0xc8, 0x85, 0x6c, 0xa0, 0xf0, 0xa9, 1, ...STA_PTR_Y, RTS], /write outside/],
  ['a buffer pointer past Map16TilesLow, at $7F0000',
    [0xa9, 0xff, 0x85, 0x6b, 0x85, 0x6c, 0xa9, 0x7e, 0x85, 0x6d, 0xa0, 1, 0xa9, 1, ...STA_PTR_Y, RTS],
    [0xa9, 0xff, 0x85, 0x6b, 0x85, 0x6c, 0xa9, 0x7e, 0x85, 0x6d, 0xa0, 0, 0xa9, 1, ...STA_PTR_Y, RTS],
    /outside the tile buffer at \$7F0000/],
  ['a 16-bit direct-page write that reaches $100',
    [...REP(0x20), 0xa9, 0x34, 0x12, 0x85, 0xff, ...SEP(0x20), RTS],
    [...REP(0x20), 0xa9, 0x34, 0x12, 0x85, 0xfe, ...SEP(0x20), RTS], /at \$000100/],
  ['a write into the direct page through a long pointer',
    [0xa9, 0x10, 0x85, 0x6b, 0xa9, 0, 0x85, 0x6c, 0xa9, 0x7e, 0x85, 0x6d, 0xa0, 0, 0xa9, 1, ...STA_PTR_Y, RTS],
    [0xa9, 0x10, 0x85, 0x6b, 0xa9, 0, 0x85, 0x6c, 0xa9, 0x7e, 0x85, 0x6d, 0xa0, 0, 0xa9, 1, 0x85, 0x10, RTS],
    /direct page at \$7E0010/],
  ["a write to the loader's Layer1DataPtr", [0xa9, 0, 0x85, 0x65, RTS], [0xa9, 0, 0x85, 0x64, RTS], /Layer1DataPtr/],
  ['an absolute write through an unknown DB',
    [0xa9, 1, 0x8d, 0x00, 0xc9, RTS],
    [0xa9, 0x7e, 0x48, 0xab, 0xa9, 1, 0x8d, 0x00, 0xc9, RTS], /unknown data bank/],
  ['a return over pushed data', [0x48, RTS], [0x48, 0x68, RTS], /pushed data/],
  // JSR sub; RTS; sub: RTL (or RTS).
  ['an RTL that pops a JSR frame', [0x20, lo(CODE + 4), hi(CODE + 4), RTS, 0x6b], [0x20, lo(CODE + 4), hi(CODE + 4), RTS, RTS], /RTL returns from a JSR/],
  ['an RTS out of an entry reached by JSL', [RTS], [0x6b], /RTS returns from a JSL/, { entryCall: 'jsl' }, { entryCall: 'jsl' }],
  ['REP/SEP of flags other than M and X', [...SEP(0x08), RTS], [...SEP(0x30), RTS], /REP\/SEP/],
  ['the step budget', [0x4c, lo(CODE), hi(CODE)], [RTS], /step budget/, { stepBudget: 1000 }, { stepBudget: 1000 }],
  // Write the same cell 16 times: X counts down from $0F.
  ['the write budget',
    [...LDY_POS, 0xa2, 0x0f, 0xa9, 1, ...STA_PTR_Y, 0xca, 0x10, 0xfb, RTS],
    [...LDY_POS, 0xa2, 0x0f, 0xa9, 1, ...STA_PTR_Y, 0xca, 0x10, 0xfb, RTS], /write budget/,
    { writeBudget: 15 }, { writeBudget: 16 }],
  ['execution that leaves ROM', [0x4c, 0x00, 0x10], [0x4c, lo(CODE + 3), hi(CODE + 3), RTS], /left ROM/],
  // REP #$30; LDA #len; LDX #$C800; LDY #$D000; MVN; SEP #$30; RTS
  ['the step budget inside a block move',
    [...REP(0x30), 0xa9, 0xff, 0x0f, 0xa2, 0x00, 0xc8, 0xa0, 0x00, 0xd0, 0x54, 0x7e, 0x7e, ...SEP(0x30), RTS],
    [...REP(0x30), 0xa9, 0x10, 0x00, 0xa2, 0x00, 0xc8, 0xa0, 0x00, 0xd0, 0x54, 0x7e, 0x7e, ...SEP(0x30), RTS],
    /step budget/, { stepBudget: 1000 }, { stepBudget: 1000 }],
  ['a block move outside the tile buffer',
    [...REP(0x30), 0xa9, 1, 0, 0xa2, 0x00, 0xc8, 0xa0, 0x10, 0xc9, 0x54, 0x7d, 0x7d, ...SEP(0x30), RTS],
    [...REP(0x30), 0xa9, 1, 0, 0xa2, 0x00, 0xc8, 0xa0, 0x10, 0xc9, 0x54, 0x7e, 0x7e, ...SEP(0x30), RTS], /block move/],
  ['a block move from unmodelled RAM',
    [...REP(0x30), 0xa9, 1, 0, 0xa2, 0x00, 0x01, 0xa0, 0x10, 0xc9, 0x54, 0x7e, 0x7e, ...SEP(0x30), RTS],
    [...REP(0x30), 0xa9, 1, 0, 0xa2, 0x00, 0xc8, 0xa0, 0x10, 0xc9, 0x54, 0x7e, 0x7e, ...SEP(0x30), RTS], /unmodelled RAM/],
  // An unknown operand must null the flags, not leave the old carry standing.
  ['a CMP of an unknown accumulator, then BCC',
    [0x38, 0xa5, 0x20, 0xc9, 0x00, 0x90, 0, RTS], [0x38, 0xa5, 0x59, 0xc9, 0x00, 0x90, 0, RTS], /branch/],
  ['a CMP against an unknown operand, then BCC',
    [0x38, 0xa9, 1, 0xa2, 0, 0xdf, 0x20, 0x00, 0x7e, 0x90, 0, RTS],
    [0x38, 0xa9, 1, 0xa2, 0, 0xdf, 0x59, 0x00, 0x7e, 0x90, 0, RTS], /branch/],
  ['an ADC of an unknown operand, then BCC',
    [0x18, 0xa9, 1, 0x65, 0x20, 0x90, 0, RTS], [0x18, 0xa9, 1, 0x65, 0x59, 0x90, 0, RTS], /branch/],
]

describe('interpret: refusal rules, each beside a control that completes', () => {
  it.each(PAIRS)('refuses %s', (_name, bad, good, reason, badOpts, goodOpts, size) => {
    expect(run(cart(bad, [], size), 0, badOpts).refusal?.reason).toMatch(reason)
    expect(run(cart(good, [], size), 0, goodOpts).refusal).toBeNull()
  })

  it('refuses execution in the $0000-$7FFF half of a ROM-backed bank', () => {
    const big = new Uint8Array(0x240000)
    big.set([0x4c, 0x00, 0x00], 0x200000) // at $40:8000: JMP $0000
    const r = interpret(RomFile.fromBytes('big', big), 0x408000, place(), { tileset: 0 })
    expect(r.refusal?.reason).toMatch(/left ROM at \$400000/)
  })

  it('treats the entry as JSL-called by default, as the loader calls it', () => {
    const plain = (code: number[]) => interpret(cart(code), CODE, place(), { tileset: 0 })
    expect(plain([RTS]).refusal?.reason).toMatch(/RTS returns from a JSL/)
    expect(plain([0x6b]).refusal).toBeNull()
  })
})

describe('interpret: placement and named inputs', () => {
  it('places an object on the lower half of a later screen', () => {
    const p = horizontalPlacement('standard', 0x35, 0x12, 35, 20)
    expect(p).toEqual({
      rawA: 0x60 | 0x10 | 4,
      rawB: 0x53,
      size: 0x12,
      objNo: 0x35,
      pos: 0x43,
      screen: 2,
      lowPtr: 0x7ec800 + 2 * 0x1b0 + 0x100,
      highPtr: 0x7fc800 + 2 * 0x1b0 + 0x100,
    })
    // The loader bytes reach the handler: LDA _A, LDA _B, then a write at the position.
    const r = run(
      cart([...LDY_POS, 0xa5, 0x0a, ...PUT, 0xa5, 0x0b, ...PUT, RTS]),
      0,
      {},
      undefined,
      p,
    )
    expect(values(r)).toEqual([0x74, 0x53])
    const grid = Array.from({ length: 27 }, () => new Array(48).fill(0x25))
    applyWrites(grid, r.writes)
    expect([grid[20][35], grid[20][36]]).toEqual([0x74, 0x53])
  })

  it('folds the high byte into the tile as its page', () => {
    const grid = Array.from({ length: 27 }, () => new Array(32).fill(0x25))
    applyWrites(grid, [
      { addr: BASE + 0x23, value: 0x42 },
      { addr: BASE + 0x23 + 0x10000, value: 0x01 },
    ])
    expect(grid[2][19]).toBe(0x142)
  })

  const flags = [
    0xad,
    0x27,
    0x1f,
    ...PUT,
    0xad,
    0x28,
    0x1f,
    ...PUT,
    0xad,
    0x29,
    0x1f,
    ...PUT,
    0xad,
    0x2a,
    0x1f,
    ...PUT,
  ]
  it('reads the switch palace flags in SwitchBlockFlags order', () => {
    const rom = cart([...LDY_POS, ...flags, RTS])
    expect(values(run(rom))).toEqual([0, 0, 0, 0])
    const green = { green: true, yellow: false, blue: true, red: false }
    expect(values(run(rom, 0, {}, { tileset: 0, switchFlags: green }))).toEqual([1, 0, 1, 0])
  })

  it('reads game state as 0 unless the caller names it', () => {
    const rom = cart([...LDY_POS, 0xad, 0xce, 0x13, ...PUT, 0xad, 0x31, 0x19, ...PUT, RTS]) // MidwayFlag, tileset
    expect(values(run(rom, 0, {}, { tileset: 3 }))).toEqual([0, 3])
    expect(values(run(rom, 0, {}, { tileset: 3, ram: new Map([[0x13ce, 1]]) }))).toEqual([1, 3])
  })

  it('indexes item memory by $1BA1, which INC and DEC abs move (bank_0D.asm:1535-1555)', () => {
    // INC $1BA1; LDA $1BA1; ASL; ASL; TAY; _8/_9 = $19F8; LDA (_8),Y; write; DEC $1BA1; LDA $1BA1; write
    // prettier-ignore
    const rom = cart([0xee, 0xa1, 0x1b, 0xad, 0xa1, 0x1b, 0x0a, 0x0a, 0xa8,
      0xa9, 0xf8, 0x85, 0x08, 0xa9, 0x19, 0x85, 0x09, 0xb1, 0x08, ...LDY_POS, ...PUT,
      0xce, 0xa1, 0x1b, 0xad, 0xa1, 0x1b, ...PUT, RTS])
    // Screen 1, so $1BA1 goes 1 -> 2 -> 1 and the byte read is $19F8 + 8.
    expect(values(run(rom, 0, {}, { tileset: 0, ram: new Map([[0x19f8 + 8, 0x77]]) }))).toEqual([
      0x77, 1,
    ])
    expect(values(run(rom))).toEqual([0, 1])
  })
})

describe('interpret: arithmetic, flags, widths and block moves', () => {
  it('computes carry the way the 65816 does', () => {
    // Each probe leaves C, then LDA #0 : ADC #0 writes it as 0 or 1.
    const carry = [0xa9, 0x00, 0x69, 0x00, ...PUT]
    // prettier-ignore
    const r = run(cart([...LDY_POS,
      0x18, 0xa9, 0xff, 0x69, 0x01, ...carry, // $FF + 1 carries
      0x18, 0xa9, 0xfe, 0x69, 0x01, ...carry, // $FE + 1 does not
      0x38, 0xa9, 0x00, 0xe9, 0x01, ...carry, // 0 - 1 borrows: C clear
      0x38, 0xa9, 0x05, 0xe9, 0x03, ...carry, // 5 - 3 does not: C set
      0x38, 0xa9, 0x03, 0xe9, 0x03, ...carry, // 3 - 3 = 0 does not borrow either
      0x18, 0xa9, 0x05, 0xe9, 0x03, 0x85, 0x20, ...carry, // C clear borrows one more: 5 - 3 - 1
      0xa5, 0x20, ...PUT,
      0xa2, 0x05, 0xe0, 0x05, ...carry, // CPX equal sets C
      0xa2, 0x04, 0xe0, 0x05, ...carry, // CPX below clears C
      0xa9, 0x01, 0x4a, ...carry, // LSR shifts bit 0 into C
      0xa9, 0x80, 0x0a, ...carry, // ASL shifts bit 7 into C
      RTS]))
    expect(values(r)).toEqual([1, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1])
  })

  it('takes BCC on carry clear and falls through on carry set', () => {
    const r = run(
      cart([...LDY_POS, 0x18, ...unlessBranch(0x90, 0xa0), 0x38, ...unlessBranch(0x90, 0xa1), RTS]),
    )
    expect(values(r)).toEqual([0xa1])
  })

  it('sets N, Z and the ASL carry from 16 bits when M is clear', () => {
    // prettier-ignore
    const r = run(cart([...LDY_POS,
      ...REP(0x20), 0xa9, 0x00, 0x80, ...SEP(0x20), ...unlessBranch(0x10, 0xa1), // $8000: N set
      ...REP(0x20), 0xa9, 0x00, 0x01, ...SEP(0x20), ...unlessBranch(0xf0, 0xa2), // $0100: Z clear
      ...REP(0x20), 0xa9, 0x00, 0x80, 0x0a, ...SEP(0x20), ...unlessBranch(0x90, 0xa3), // ASL $8000: C set
      RTS]))
    expect(values(r)).toEqual([0xa1, 0xa2, 0xa3])
  })

  it('decodes X-width immediates, truncates X on SEP #$10, and moves B:A on TAX', () => {
    // prettier-ignore
    const r = run(cart([
      ...SEP(0x20), ...REP(0x10), 0xa2, 0x28, 0x12, ...SEP(0x10), // LDX #$1228 (3 bytes), then X = $28
      0xbd, 0x00, 0x19, ...LDY_POS, ...PUT, // LDA $1900,X reads $1928: the screen
      ...REP(0x30), 0xa9, 0x28, 0x19, ...SEP(0x20), 0xaa, // A = $28 with B = $19; TAX with 16-bit X
      0xbd, 0x00, 0x00, ...SEP(0x10), ...LDY_POS, 0xc8, ...PUT, // LDA $0000,X reads $1928 again
      RTS]))
    expect(values(r)).toEqual([1, 1])
  })

  it('pulls a 16-bit accumulator low byte first', () => {
    // LDA #$34; PHA; LDA #$12; PHA; REP #$20; PLA; STA [$6B],Y (16-bit) -> $12 then $34
    // prettier-ignore
    const r = run(cart([...LDY_POS, 0xa9, 0x34, 0x48, 0xa9, 0x12, 0x48, ...REP(0x20), 0x68, ...STA_PTR_Y, ...SEP(0x20), RTS]))
    expect(values(r)).toEqual([0x12, 0x34])
  })

  it('reads abs,Y', () => {
    expect(values(run(cart([0xa0, 0x03, 0xb9, 0x25, 0x19, ...LDY_POS, ...PUT, RTS])))).toEqual([1])
  })

  it('copies inside the buffer and leaves X, Y and DB as MVN does', () => {
    // REP #$30; LDA #1; LDX #$C800; LDY #$C910; MVN $7E,$7E; SEP #$30; TXA; STA [$6B],Y;
    // PHB; PLB; BEQ over a marker.
    // prettier-ignore
    const r = run(cart([...REP(0x30), 0xa9, 1, 0, 0xa2, 0x00, 0xc8, 0xa0, 0x10, 0xc9, 0x54, 0x7e, 0x7e,
      ...SEP(0x30), 0x8a, ...STA_PTR_Y, 0x8b, 0xab, ...unlessBranch(0xf0, 0xa5), RTS]))
    expect(r.writes).toEqual([
      { addr: 0x7ec910, value: 0x25 },
      { addr: 0x7ec911, value: 0x25 },
      { addr: BASE + 0x12, value: 0x02 }, // X = $C802, Y = $C912 after the copy
      { addr: BASE + 0x12, value: 0xa5 }, // DB = $7E, so PLB leaves Z clear
    ])
  })
})

// A stand-in for the stock ExecutePtrLong: the interpreter never executes these
// bytes, it recognizes their fingerprint and applies the modelled effect.
const SIG = Array.from({ length: 36 }, (_, i) => (i * 37 + 11) & 0xff)
const SIG_OPTS = { dispatchFingerprint: fingerprint(Uint8Array.from(SIG)) ?? '' }

describe('interpret: inline-table dispatch (ExecutePtrLong)', () => {
  const TARGET = 0x0d8100
  // LDY $57; LDA idx; JSL DISPATCH; dl <null>, dl TARGET. The JSL sits at CODE+4.
  const body = (lda: number[]) => [...lda, 0x22, lo(DISPATCH), hi(DISPATCH), 0x0d, 0, 0, 0, lo(TARGET), hi(TARGET), 0x0d] // prettier-ignore
  // TARGET writes A, then _0, _3, _4, _5 and the carry, one per column.
  // prettier-ignore
  const target: [number, number[]] = [TARGET, [
    ...PUT, 0xa5, 0x00, ...PUT, 0xa5, 0x03, ...PUT, 0xa5, 0x04, ...PUT, 0xa5, 0x05, ...PUT,
    0xa9, 0x00, 0x69, 0x00, ...PUT, RTS,
  ]]
  const withSig = (sig: number[], lda = [0xa9, 0x01]) =>
    cart([...LDY_POS, ...body(lda)], [target, [DISPATCH, sig]])

  it('dispatches through the inline table and leaves the routine`s side effects', () => {
    const r = run(withSig(SIG), 0, SIG_OPTS)
    expect(r.dispatches).toEqual([TARGET])
    // A = target bits 8-15, _0 = target low, _3/_4 = return address high/bank
    // (JSL at CODE+4 pushes CODE+7), _5 = the caller's Y, carry clear. Y is
    // restored, so the first write lands at the object position.
    expect(values(r)).toEqual([0x81, 0x00, 0x80, 0x0d, 0x20, 0x00])
    expect(r.writes[0].addr).toBe(BASE + 0x20)
  })

  it('refuses an unknown dispatch index', () => {
    expect(run(withSig(SIG, [0xa5, 0x20]), 0, SIG_OPTS).refusal?.reason).toMatch(/dispatch index/)
  })

  it('refuses when any one of the 36 pinned bytes differs', () => {
    const passed: number[] = []
    for (let i = 0; i < SIG.length; i++) {
      const sig = SIG.slice()
      sig[i] ^= 0x01
      const r = run(withSig(sig), 0, SIG_OPTS)
      if (!/JSL/.test(r.refusal?.reason ?? '')) passed.push(i)
    }
    expect(passed).toEqual([])
  })

  it('refuses a table entry that is not ROM', () => {
    const r = run(withSig(SIG, [0xa9, 0x00]), 0, SIG_OPTS) // index 0: the zero entry, $00:0000
    expect(r.refusal?.reason).toMatch(/not ROM/)
  })
})

// Helpers written from bank_0D.asm:1635-1651 and 1996-2031, 2107-2115. Tile values are invented.
/** The handler bytes only; `staircase` puts them in a cart at CODE. */
function staircaseCode(org: number, step = 0x04, stop = 0x07, ret = RTS): number[] {
  const a = new Asm(org)
  a.b(...LDY_POS, 0xa2, 0x03, 0x86, 0x02).call(0x20, 'save') // LDX #3; STX _2
  a.b(0xa5, 0x59, 0x4a, 0x4a, 0x4a, 0x4a, 0x85, 0x00, 0xe6, 0x00).call(0x4c, 'lips')
  a.at('fill').call(0x20, 'page0').b(0xa9, 0x11).call(0x20, 'write').b(0xca)
  a.at('loop').b(0xe0, stop).br(0xd0, 'fill') // CPX #stop; BNE fill
  for (const t of [0x21, 0x22, 0x23, 0x24]) a.call(0x20, 'page1').b(0xa9, t).call(0x20, 'write')
  a.b(0xca, 0xca, 0xca, 0xca, 0xa5, 0x00).br(0xf0, 'done')
  a.at('lips')
  for (const t of [0x31, 0x32, 0x33, 0x34]) a.call(0x20, 'page1').b(0xa9, t).call(0x20, 'merge')
  a.call(0x20, 'restore').call(0x20, 'row')
  a.b(0xa5, 0x02, 0x18, 0x69, step, 0x85, 0x02, 0xa6, 0x02, 0xc6, 0x00).br(0x10, 'more')
  a.at('done').b(ret)
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
  // CODE_0DABFD (bank_0D.asm:2388-2410): add DATA_0DABFA[i] when the cell's low byte is DATA_0DABF7[i].
  a.at('merge').b(0x85, 0x0c, 0x8a, 0x48, 0xa2, 0x02, 0xb7, 0x6b)
  a.at('mloop')
    .call(0xdf, 'mtab')
    .b(0x0d)
    .br(0xf0, 'mhit')
    .b(0xca)
    .br(0x10, 'mloop')
    .call(0x4c, 'mmiss')
  a.at('mhit').b(0xa5, 0x0c, 0x18).call(0x7f, 'mdelta').b(0x0d, 0x85, 0x0c)
  a.at('mmiss').b(0x68, 0xaa, 0xa5, 0x0c).call(0x4c, 'write')
  a.at('mtab').b(0x3f, 0x01, 0x03)
  a.at('mdelta').b(0x01, 0x03, 0x04)
  a.at('row').b(0xa5, 0x57, 0x18, 0x69, 0x10, 0x85, 0x57, 0xa8).br(0x90, 'rdone')
  a.b(0xa5, 0x6c, 0x69, 0x00, 0x85, 0x6c, 0x85, 0x6f, 0x85, 0x05)
  a.at('rdone').b(RTS)
  return a.build()
}

/** Row -> the columns, relative to the object at column 16, holding the first lip tile ($131). */
const lips = (grid: number[][]): Map<number, number[]> => {
  const out = new Map<number, number[]>()
  grid.forEach((row, y) =>
    row.forEach((t, x) => t === 0x131 && out.set(y, [...(out.get(y) ?? []), x - 16])),
  )
  return out
}

const staircase = (step?: number, stop?: number): RomFile => cart(staircaseCode(CODE, step, stop))

describe('interpret: a CODE_0DADEB-shaped staircase (bank_0D.asm:2671, #342)', () => {
  // They run inline, as the stock ones do. Tile values are invented.
  function lipColumns(rom: RomFile, size: number): Map<number, number[]> {
    const r = run(rom, size)
    expect(r.refusal).toBeNull()
    const grid = Array.from({ length: 27 }, () => new Array(48).fill(0x25))
    applyWrites(grid, r.writes)
    return lips(grid)
  }

  it('steps four columns right per row, one lip per row', () => {
    // prettier-ignore
    expect(lipColumns(staircase(), 0x30)).toEqual(new Map([[2, [0]], [3, [4]], [4, [8]], [5, [12]]]))
  })

  it('draws a different shape when the ADC #$04 step is mutated', () => {
    // prettier-ignore
    expect(lipColumns(staircase(0x08), 0x10)).toEqual(new Map([[2, [0]], [3, [8]]]))
  })

  it('draws a different shape when the CPX #$07 stop is mutated', () => {
    // prettier-ignore
    expect(lipColumns(staircase(0x04, 0x06), 0x10)).toEqual(new Map([[2, [0]], [3, [5]]]))
  })
})

describe('the expander draws CODE_0DADEB from the interpreter (#342)', () => {
  const HANDLER = 0x0dadeb
  const PIPES = 0x0dab3e // object $12's routine; the size's low nibble picks the variant
  const CLOUD = 0x12
  const VARIANT = 5 // low nibble of size $E5
  const SCREENS = 3
  const RTL = 0x6b
  const LOADER = 0x0586ea // LevLoadNrmObj: SEP #$30; JSL CODE_0DA40F; RTS (bank_05.asm:805-808)
  const ENTRY = 0x0da40f
  const SIG_AT = 0x0d9800
  const STUB = 0x0d8800 // a dispatch target that is not the handler
  const loaderBytes = (operand = [lo(ENTRY), hi(ENTRY), 0x0d]) => [0xe2, 0x30, 0x22, ...operand, 0x60] // prettier-ignore

  /** A cart whose object $12 reaches `code` at $0DADEB as pipe variant 5. */
  function slopeCart(code: number[], extra: [number, number[]][] = [], bank = 0x0d): RomFile {
    const table = new Array(STANDARD_HANDLER_COUNT * 3).fill(0)
    table.splice((CLOUD - 1) * 3, 3, lo(PIPES), hi(PIPES), 0x0d)
    const variants = new Array(30).fill(0)
    variants.splice(VARIANT * 3, 3, lo(HANDLER), hi(HANDLER), bank)
    return cart(code, [
      [HANDLER, code],
      [ADDR_TILESET_DISPATCH, [lo(DISPATCH), hi(DISPATCH), 0x0d]],
      [DISPATCH + 10, table],
      [PIPES + 18, variants],
      ...extra,
    ])
  }
  /** A cart the production entry can walk: loader JSL, then ENTRY dispatching to `to` through the stand-in. */
  function prodCart({
    to = HANDLER,
    bank = 0x0d,
    variantBank = bank,
    loader = loaderBytes(),
  } = {}): RomFile {
    // prettier-ignore
    const entry = [0xa9, 0, 0x22, lo(SIG_AT), hi(SIG_AT), 0x0d, lo(to), hi(to), bank]
    const handler = staircaseCode(HANDLER, undefined, undefined, RTL)
    return slopeCart(handler, [[ENTRY, entry], [SIG_AT, SIG], [LOADER, loader], [STUB, [RTL]]], variantBank) // prettier-ignore
  }
  const obj = (size: number): LevelObject => ({ type: 'standard', objectNumber: CLOUD, settings: size, x: 16, y: 2 }) as LevelObject // prettier-ignore
  /** Expand one object, entering the interpreter at the handler (the synthetic cart has no ExecutePtrLong). */
  function expand(
    rom: RomFile,
    size: number,
    options?: InterpretOptions,
    prefill?: (g: number[][]) => void,
  ) {
    // prettier-ignore
    const unverified: string[] = []
    const grid = createGrid(SCREENS)
    prefill?.(grid)
    expandObject(grid, obj(size), rom, 0, null, OWNER_NONE, undefined, { vertical: false, unverified, entry: HANDLER, options }) // prettier-ignore
    return { grid, unverified }
  }
  /** Expand one object through the production entry: the loader's JSL and the ROM's own dispatch. */
  function expandProd(rom: RomFile, size: number) {
    const unverified: string[] = []
    const grid = createGrid(SCREENS)
    expandObject(grid, obj(size), rom, 0, null, OWNER_NONE, undefined, { vertical: false, unverified, options: SIG_OPTS }) // prettier-ignore
    return { grid, unverified }
  }
  /** What the port draws for the same object, straight from the port. */
  function port(rom: RomFile, size: number): number[][] {
    const grid = createGrid(SCREENS)
    const cur = makeCursor(grid, rom, 0, 16, 2, CLOUD, size)
    cur.handlerAddr = PIPES
    STANDARD_HANDLERS[PIPES](cur)
    return grid
  }
  const STAIRS = new Map([
    [2, [0]],
    [3, [4]],
    [4, [8]],
    [5, [12]],
  ]) // size $35: four lips
  const good = (step?: number, stop?: number) => slopeCart(staircaseCode(HANDLER, step, stop))

  it('draws the staircase the handler bytes describe, not the port, and marks nothing', () => {
    const r = expand(good(), 0x35)
    expect(lips(r.grid)).toEqual(STAIRS)
    expect(r.unverified).toEqual([])
    expect(r.grid).not.toEqual(port(good(), 0x35))
  })

  it('goes red when the ADC #$04 step is mutated', () => {
    // prettier-ignore
    expect(lips(expand(good(0x08), 0x15).grid)).toEqual(new Map([[2, [0]], [3, [8]]]))
  })

  it('goes red when a lip tile immediate is mutated', () => {
    const code = staircaseCode(HANDLER)
    code[code.indexOf(0x31)] = 0x35 // the first LDA #lip
    const { grid } = expand(slopeCart(code), 0x35)
    expect(lips(grid).size).toBe(0)
    expect(grid[2][16]).toBe(0x135)
  })

  it('goes red when the CPX #$07 fill stop is mutated', () => {
    // prettier-ignore
    expect(lips(expand(good(0x04, 0x06), 0x15).grid)).toEqual(new Map([[2, [0]], [3, [5]]]))
  })

  // CODE_0DABFD (bank_0D.asm:2388-2410) reads the cell's low byte before it writes the lip.
  // Low byte $3F/$01/$03 adds 1/3/4 to the lip, whatever page the cell was on.
  it.each([
    [0x3f, 1],
    [0x01, 3],
    [0x03, 4],
  ])('merges a lip into the low byte %i already there: base + %i', (low, add) => {
    for (const page of [0, 0x100]) {
      const { grid } = expand(good(), 0x35, undefined, g => (g[2][16] = page | low))
      expect(grid[2][16], `page ${page >> 8}`).toBe(0x100 | (0x31 + add))
    }
    expect(expand(good(), 0x35).grid[2][16]).toBe(0x131) // an empty cell merges nothing
  })

  it('places the object where the raw run puts it, at its column and row', () => {
    const raw = run(good(), 0, {}, undefined, horizontalPlacement('standard', CLOUD, 0x35, 16, 2))
    const grid = createGrid(SCREENS)
    applyWrites(grid, raw.writes)
    expect(expand(good(), 0x35).grid).toEqual(grid)
  })

  it('draws the port and says why when the interpreter refuses', () => {
    const bad = staircaseCode(HANDLER)
    bad.splice(2, 0, 0xea) // NOP: outside the allowed opcodes
    const r = expand(slopeCart(bad), 0x35)
    expect(r.grid).toEqual(port(slopeCart(bad), 0x35))
    expect(r.grid.flat().some(t => t !== TILE_EMPTY)).toBe(true) // never blank
    expect(r.unverified).toHaveLength(1)
    expect(r.unverified[0]).toMatch(/\$0DADEB .*not verified.*opcode \$EA.* at \$0DADED/)
  })

  it('does not mark a refusal-free run, so the note is not always on', () => {
    expect(expand(good(), 0x15).unverified).toEqual([])
  })

  it('records the object as the owner of every cell the interpreter drew, and no other', () => {
    const grid = createGrid(SCREENS)
    const owners = grid.map(row => new Array<number>(row.length).fill(OWNER_NONE))
    expandObject(grid, obj(0x35), good(), 0, owners, 7, undefined, { vertical: false, unverified: [], entry: HANDLER }) // prettier-ignore
    const drawn = grid.flatMap((row, y) =>
      row.flatMap((t, x) => (t === TILE_EMPTY ? [] : [[y, x]])),
    )
    expect(drawn.length).toBeGreaterThan(8)
    for (const [y, x] of drawn) expect(owners[y][x], `cell ${x},${y}`).toBe(7)
    expect(owners.flat().filter(o => o === 7)).toHaveLength(drawn.length)
  })

  it('refuses a vertical level rather than placing it as a horizontal one', () => {
    const unverified: string[] = []
    const grid = createGrid(SCREENS)
    expandObject(grid, obj(0x15), good(), 0, null, OWNER_NONE, undefined, { vertical: true, unverified, entry: HANDLER }) // prettier-ignore
    expect(unverified[0]).toMatch(/vertical/)
  })

  it('the production entry refuses a cart without ExecutePtrLong, draws the port and notes it', () => {
    const unverified: string[] = []
    const { grid } = expandMapOwned([obj(0x35)], SCREENS, good(), 0, false, undefined, undefined, undefined, unverified) // prettier-ignore
    expect(unverified.join(' ')).toMatch(/\$0DADEB .*not verified/)
    expect(grid).toEqual(port(good(), 0x35))
  })

  describe('through the production entry', () => {
    it('draws from the interpreter when the loader and the dispatch both reach the handler', () => {
      const r = expandProd(prodCart(), 0x35)
      expect(lips(r.grid)).toEqual(STAIRS)
      expect(r.unverified).toEqual([])
    })

    it('draws the port and says so when the dispatch reaches another routine', () => {
      const rom = prodCart({ to: STUB })
      const r = expandProd(rom, 0x35)
      expect(r.unverified).toHaveLength(1)
      expect(r.unverified[0]).toMatch(/dispatch reaches \$0D8800/)
      expect(r.grid).toEqual(port(rom, 0x35))
    })

    it.each([
      ['$8DADEB', 'dispatch and pipe variant', 0x8d, 0x8d],
      ['$8DADEB', 'dispatch only', 0x8d, 0x0d],
      ['$8DADEB', 'pipe variant only', 0x0d, 0x8d],
    ])('reads %s as $0DADEB: %s', (_form, _where, bank, variantBank) => {
      const r = expandProd(prodCart({ bank, variantBank }), 0x35)
      expect(lips(r.grid)).toEqual(STAIRS)
      expect(r.unverified).toEqual([])
    })

    it('draws the port, not a blank, when a $8D-form dispatch is refused', () => {
      const bad = prodCart({ bank: 0x8d, to: STUB })
      expect(
        expandProd(bad, 0x35)
          .grid.flat()
          .some(t => t !== TILE_EMPTY),
      ).toBe(true)
    })

    it('accepts the loader JSL in its $8D mirror', () => {
      const rom = prodCart({ loader: loaderBytes([lo(ENTRY), hi(ENTRY), 0x8d]) })
      expect(expandProd(rom, 0x35).unverified).toEqual([])
    })

    it('refuses when any byte of the loader routine differs, drawing the port and noting it', () => {
      const stock = loaderBytes()
      const passed: number[] = []
      for (let i = 0; i < stock.length; i++) {
        const loader = stock.slice()
        loader[i] ^= 0x01 // a JSL operand byte, the JSL opcode, or the SEP/RTS around it
        const rom = prodCart({ loader })
        const r = expandProd(rom, 0x35)
        const drawsPort = JSON.stringify(r.grid) === JSON.stringify(port(rom, 0x35))
        if (!/loader/.test(r.unverified[0] ?? '') || !drawsPort) passed.push(i)
      }
      expect(passed).toEqual([])
    })

    it('refuses a cart where the loader routine is absent', () => {
      const r = expandProd(prodCart({ loader: [0, 0, 0, 0, 0, 0, 0] }), 0x35)
      expect(r.unverified[0]).toMatch(/loader/)
    })
  })
})
