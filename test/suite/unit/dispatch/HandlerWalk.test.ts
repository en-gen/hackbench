/**
 * The handler walk, proved to decode rather than to remember.
 *
 * The walk's whole value is that it reports what the CART's bytes reach, so
 * every claim here either plants a byte and shows the answer moves, or
 * plants one and shows the walk stops. A test that only asserts the vanilla
 * answer would pass just as well against a lookup table.
 *
 * Nothing is written to disk: `RomFile.writeAt` mutates the loaded buffer.
 *
 * Evidence scope: synthetic carts for the decoder, plus
 * `Super Mario World (USA).vanilla.sfc` for the two real-handler cases.
 * Static reads only; no emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  walkHandler,
  DEFAULT_INSN_BUDGET,
  DEFAULT_PROBE_BUDGET,
  DEFAULT_PROBE_DEPTH,
} from '../../../../src/rom/dispatch/HandlerWalk'

const ROM_DIR = resolve(__dirname, '../../../roms')
const VANILLA = 'Super Mario World (USA).vanilla.sfc'
const romPresent = existsSync(resolve(ROM_DIR, VANILLA))
const freshRom = () => RomFile.load(resolve(ROM_DIR, VANILLA))

/** A 4 MB LoROM cart of `NOP`s that code can be planted into. */
function blankRom(): RomFile {
  const bytes = new Uint8Array(0x400000).fill(0xea)
  bytes[0x7fd5] = 0x20 // LoROM map mode, so RomFile maps addresses
  return RomFile.fromBytes('synthetic.sfc', bytes)
}

const AT = 0x038000
const TARGET = 0x039000
const OTHER = 0x039100
const watch = new Map([
  [TARGET, 'wanted'],
  [OTHER, 'other'],
])
const run = (rom: RomFile, at = AT, opts = {}) => walkHandler(rom, at, { watch, ...opts })

/** `JSR abs` to a 16-bit target in the current bank. */
const jsr = (t: number) => [0x20, t & 0xff, (t >> 8) & 0xff]
/** `JSL long`. */
const jsl = (t: number) => [0x22, t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff]
const RTS = [0x60]

describe('the walk reaches what the bytes call', () => {
  it('reports a direct JSR to a watched routine', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(TARGET), ...RTS])
    expect([...run(rom).reached.keys()]).toEqual(['wanted'])
  })

  it('follows the JSR operand, not the address it happened to hold', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(TARGET), ...RTS])
    rom.writeAt(AT + 1, [OTHER & 0xff, (OTHER >> 8) & 0xff])
    expect([...run(rom).reached.keys()]).toEqual(['other'])
  })

  it('matches a JSL across the $80 bank mirror', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...jsl(TARGET | 0x800000), ...RTS])
    expect([...run(rom).reached.keys()]).toEqual(['wanted'])
  })

  it('descends into a called routine up to the depth budget', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(0x039200), ...RTS])
    rom.writeAt(0x039200, [...jsr(0x039300), ...RTS])
    rom.writeAt(0x039300, [...jsr(TARGET), ...RTS])
    expect([...run(rom).reached.keys()]).toEqual(['wanted'])
    expect([...run(rom, AT, { callDepth: 1 }).reached.keys()]).toEqual([])
    expect(run(rom, AT, { callDepth: 1 }).stops.has('callDepth')).toBe(true)
  })

  it('takes both sides of a conditional branch', () => {
    const rom = blankRom()
    //  BNE +3 : JSR wanted : RTS  |  + JSR other : RTS
    rom.writeAt(AT, [0xd0, 0x04, ...jsr(TARGET), ...RTS, ...jsr(OTHER), ...RTS])
    expect([...run(rom).reached.keys()].sort()).toEqual(['other', 'wanted'])
  })

  it('refuses to enter a blocked address, so one side can be cut', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0xd0, 0x04, ...jsr(TARGET), ...RTS, ...jsr(OTHER), ...RTS])
    const cut = walkHandler(rom, AT, { watch, blocked: new Set([AT + 6]) })
    expect([...cut.reached.keys()]).toEqual(['wanted'])
  })

  it('stops at a blocked address reached by falling into it', () => {
    // The two sides of a branch usually rejoin. Refusing only to QUEUE a
    // blocked target leaves the cut open through the fall-through, which is
    // how a split that has already converged reports both routines.
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(TARGET), ...jsr(OTHER), ...RTS])
    const cut = walkHandler(rom, AT, { watch, blocked: new Set([AT + 3]) })
    expect([...cut.reached.keys()]).toEqual(['wanted'])
  })

  it('follows a backward BRA and a backward BRL', () => {
    // `BRA`'s displacement is one signed byte, and reading it unsigned
    // lands the walk in the middle of another routine. `BRL`'s is two
    // bytes and needs no sign extension, but it still has to land.
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(TARGET), ...RTS]) // the destination
    rom.writeAt(AT + 0x10, [0x80, 0xee]) // BRA -18
    expect([...run(rom, AT + 0x10).reached.keys()]).toEqual(['wanted'])
    rom.writeAt(AT + 0x20, [0x82, 0xdd, 0xff]) // BRL -35
    expect([...run(rom, AT + 0x20).reached.keys()]).toEqual(['wanted'])
  })

  it('follows BRA, BRL, JMP abs and JML long', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0x80, 0x02, 0x60, 0x60, 0x82, 0xfa, 0x00]) // BRA +2 ; BRL +250
    rom.writeAt(AT + 0x101, [0x4c, 0x00, 0x92]) // JMP $9200
    rom.writeAt(0x039200, [0x5c, 0x00, 0x93, 0x03]) // JML $039300
    rom.writeAt(0x039300, [...jsr(TARGET), ...RTS])
    expect([...run(rom).reached.keys()]).toEqual(['wanted'])
  })
})

describe('the walk stops rather than decoding data as code', () => {
  it('stops at an RTS, so a dw table after it is never decoded', () => {
    const rom = blankRom()
    // `JSR $2022` is what the planted table decodes to if the RTS is ignored.
    rom.writeAt(AT, [...RTS, 0x20, 0x00, 0x90, 0x22, 0x00, 0x91, 0x03])
    expect([...run(rom).reached.keys()]).toEqual([])
    expect(run(rom).instructionsDecoded).toBe(1)
  })

  it('stops after a call whose callee reaches no return', () => {
    const rom = blankRom()
    // $039400 ends in JML [abs], the shape of ExecutePtr: control leaves
    // and the bytes after the call site are its argument, not code.
    rom.writeAt(0x039400, [0xdc, 0x00, 0x00])
    rom.writeAt(AT, [...jsl(0x039400), ...jsr(TARGET), ...RTS])
    const r = run(rom)
    expect([...r.reached.keys()]).toEqual([])
    expect(r.stops.has('nonReturningCall')).toBe(true)
  })

  it('continues past the same call once its callee can return', () => {
    // One byte apart from the test above, so that one is about the probe
    // and not about the call being unreachable.
    const rom = blankRom()
    rom.writeAt(0x039400, [0x6b])
    rom.writeAt(AT, [...jsl(0x039400), ...jsr(TARGET), ...RTS])
    const r = run(rom)
    expect([...r.reached.keys()]).toEqual(['wanted'])
    expect(r.stops.has('nonReturningCall')).toBe(false)
  })

  it('probes through a nested call, so a wrapper does not hide it', () => {
    const rom = blankRom()
    rom.writeAt(0x039400, [0xdc, 0x00, 0x00]) // never returns
    rom.writeAt(0x039500, [...jsl(0x039400), 0x6b]) // wrapper: call then RTL
    rom.writeAt(AT, [...jsl(0x039500), ...jsr(TARGET), ...RTS])
    const r = run(rom)
    // The wrapper's own RTL is unreachable, because control left at the
    // inner call. A probe that only looked for an RTL byte would say yes.
    expect(r.stops.has('nonReturningCall')).toBe(true)
    expect([...r.reached.keys()]).toEqual([])
  })

  it('reads a recursive callee as returning rather than looping forever', () => {
    // A cycle THROUGH a call is assumed to come back, which is what a
    // recursive subroutine does. A cycle inside one probe is not: see
    // "a loop that never leaves the callee is not a return" below.
    const rom = blankRom()
    rom.writeAt(0x039400, [...jsl(0x039400), 0x6b])
    rom.writeAt(AT, [...jsl(0x039400), ...jsr(TARGET), ...RTS])
    expect([...run(rom).reached.keys()]).toEqual(['wanted'])
  })

  it('stops at a computed jump instead of guessing its table', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0x7c, 0x00, 0x90, ...jsr(TARGET), ...RTS])
    const r = run(rom)
    expect([...r.reached.keys()]).toEqual([])
    expect(r.stops.has('computedJump')).toBe(true)
  })

  it('stops when the address is not backed by ROM', () => {
    const rom = blankRom()
    const r = walkHandler(rom, 0x7e0000, { watch })
    expect(r.stops.has('unreadable')).toBe(true)
  })

  it('terminates on a self-branching loop instead of spinning', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0x80, 0xfe]) // BRA to itself
    const r = run(rom)
    expect(r.instructionsDecoded).toBeLessThan(10)
  })

  it('stops at the instruction budget on a straight run of NOPs', () => {
    // A blank cart is 4 MB of $EA, so nothing terminates the path.
    const r = run(blankRom(), 0x038000, { insnBudget: 50 })
    expect(r.stops.has('insnBudget')).toBe(true)
    expect(r.instructionsDecoded).toBeLessThanOrEqual(50)
    expect(DEFAULT_INSN_BUDGET).toBeGreaterThan(50)
  })
})

describe('instruction lengths follow the M and X flags', () => {
  /** `REP`/`SEP` the flags, then an immediate, then the call under test.
   *  If the immediate is sized wrong the call is decoded at the wrong
   *  offset and the watched routine is missed. */
  function afterImmediate(prefix: number[], immediate: number[]) {
    const rom = blankRom()
    rom.writeAt(AT, [...prefix, ...immediate, ...jsr(TARGET), ...RTS])
    return [...run(rom).reached.keys()]
  }

  it('reads LDA #imm as two bytes in 8-bit A and three in 16-bit', () => {
    expect(afterImmediate([0xe2, 0x20], [0xa9, 0x20])).toEqual(['wanted'])
    expect(afterImmediate([0xc2, 0x20], [0xa9, 0x00, 0x90])).toEqual(['wanted'])
  })

  it('reads LDX #imm as two bytes in 8-bit X and three in 16-bit', () => {
    expect(afterImmediate([0xe2, 0x10], [0xa2, 0x20])).toEqual(['wanted'])
    expect(afterImmediate([0xc2, 0x10], [0xa2, 0x00, 0x90])).toEqual(['wanted'])
  })

  it('starts in 8-bit, which is how sprite handlers are entered', () => {
    expect(afterImmediate([], [0xa9, 0x20])).toEqual(['wanted'])
  })

  it('mis-sizes nothing when REP and SEP touch only the other flag', () => {
    // REP #$10 widens X only; LDA #imm must stay two bytes.
    expect(afterImmediate([0xc2, 0x10], [0xa9, 0x20])).toEqual(['wanted'])
  })
})

describe('the accumulator source is read, not assumed', () => {
  /** `LDY SpriteNumber,X : LDA table,Y : AND #mask : BNE` - the shape the
   *  routine reader looks for. */
  const bitTest = (table: number, mask: number) => [
    0xb4,
    0x9e,
    0xb9,
    table & 0xff,
    (table >> 8) & 0xff,
    0x29,
    mask,
    0xd0,
    0x00,
  ]

  it('reports the table and mask a branch tests', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...bitTest(0x88f0, 0x40), ...RTS])
    const [branch] = run(rom).branches
    expect(branch.accumulator).toEqual({
      kind: 'tableBitTest',
      table: 0x0388f0,
      mask: 0x40,
      bySpriteNumber: true,
    })
  })

  it('follows the mask byte in the cart', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...bitTest(0x88f0, 0x40), ...RTS])
    rom.writeAt(AT + 6, [0x01])
    const [branch] = run(rom).branches
    expect(branch.accumulator).toMatchObject({ mask: 0x01 })
  })

  it('does not claim the index is SpriteNumber when Y was loaded elsewhere', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...bitTest(0x88f0, 0x40), ...RTS])
    rom.writeAt(AT, [0xa0, 0x00]) // LDY #$00 in place of LDY SpriteNumber,X
    const [branch] = run(rom).branches
    expect(branch.accumulator).toMatchObject({ bySpriteNumber: false })
  })

  it('forgets the source across an instruction it cannot model', () => {
    const rom = blankRom()
    // An INC A between the load and the AND: the value is no longer the
    // table byte, so claiming a bit test on it would be a fabrication.
    rom.writeAt(AT, [0xb4, 0x9e, 0xb9, 0xf0, 0x88, 0x1a, 0x29, 0x40, 0xd0, 0x00, ...RTS])
    const [branch] = run(rom).branches
    expect(branch.accumulator.kind).toBe('unknown')
  })

  it('reports an immediate the cart holds', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0xa9, 0x5d, 0xd0, 0x00, ...RTS])
    expect(run(rom).branches[0].accumulator).toEqual({ kind: 'immediate', value: 0x5d })
  })
})

/**
 * Instruction lengths, swept over the whole opcode table.
 *
 * The first version of this file tested two immediates and left the other
 * 254 entries to be right by inspection. A later mutation sweep found that
 * `MVN`, `MVP`, `PEA` and `BIT #imm` could all be given the wrong length
 * without a single test noticing. One wrong length desyncs the decoder for
 * the rest of the path, which is the failure that produces a confident
 * wrong answer rather than a refusal.
 */
describe('every opcode is decoded at its real length', () => {
  /** Opcodes whose own behaviour ends or diverts the path, so they cannot
   *  be followed by the probe instruction. Each is covered below.
   *
   *  The sweep runs over the other 243, but its oracle cannot fail for ten
   *  of them: the eight conditional branches, `BRA` and `BRL` all compute
   *  their own next address from a literal, and `REP`/`SEP` add a literal
   *  2, so the table entry is never read. Measured by mutating all 256
   *  entries one at a time against the full suite: 23 survive, and those
   *  23 are exactly the entries no code path consults.
   *  `docs/sprites/sprite-gfx-routine-reading.md` section 8 lists them. */
  const CONTROL = new Set([
    0x20,
    0x22, // JSR, JSL
    0x4c,
    0x5c, // JMP abs, JML long
    0x6c,
    0x7c,
    0xdc,
    0xfc, // computed jumps
    0x40,
    0x60,
    0x6b, // RTI, RTS, RTL
    0xcb,
    0xdb, // WAI, STP
  ])

  /** Lengths for the 8-bit-M, 8-bit-X state the walk starts in. Written
   *  out independently of the implementation's table, which is the point:
   *  a shared constant would agree with itself. */
  const LEN8: readonly number[] = [
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    3, 2, 4, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    1, 2, 2, 2, 3, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 3, 2, 2, 2, 1, 3, 1, 1, 4, 3, 3, 4,
    1, 2, 3, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    2, 2, 3, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 2, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 1, 3, 3, 3, 4, 2, 2, 2, 2, 3, 2, 2, 2, 1, 3, 1, 1, 3, 3, 3, 4,
  ]

  /** Plant `<opcode> <zero operands> : JSR wanted : RTS` and require BOTH
   *  that the call is reached and that exactly three instructions were
   *  decoded. Reach alone can survive a length error that realigns by
   *  accident; the count cannot. */
  function decodesAtLength(op: number, len: number) {
    const rom = blankRom()
    rom.writeAt(AT, [op, ...Array(len - 1).fill(0x00), ...jsr(TARGET), ...RTS])
    const r = run(rom)
    return { reached: [...r.reached.keys()], decoded: r.instructionsDecoded }
  }

  it('leaves only the 13 diverting opcodes out of the sweep', () => {
    expect(LEN8.length).toBe(256)
    expect(256 - CONTROL.size).toBe(243)
  })

  it('finds the next instruction after every one of the other 243', () => {
    const wrong: string[] = []
    for (let op = 0; op < 256; op++) {
      if (CONTROL.has(op)) continue
      const { reached, decoded } = decodesAtLength(op, LEN8[op])
      if (reached.length !== 1 || reached[0] !== 'wanted' || decoded !== 3) {
        wrong.push(`$${op.toString(16).padStart(2, '0')} reached=${reached} decoded=${decoded}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it('goes red when a length is wrong, in either direction', () => {
    // The sweep above only means something if it can fail. `PEA` is three
    // bytes; laying the call out as though it were two, or four, must be
    // caught both times.
    expect(decodesAtLength(0xf4, 3).reached).toEqual(['wanted'])
    expect(decodesAtLength(0xf4, 2).reached).toEqual([])
    expect(decodesAtLength(0xf4, 4).reached).toEqual([])
  })
})

describe('flag-width immediates widen with their flag', () => {
  /** Every opcode whose operand is an accumulator-width immediate. The
   *  8-bit sweep above cannot tell these apart from a fixed 2, which is
   *  how `BIT #imm` sat at the wrong width without a test noticing. */
  const M_IMMEDIATES: ReadonlyArray<readonly [string, number]> = [
    ['ORA', 0x09],
    ['AND', 0x29],
    ['EOR', 0x49],
    ['ADC', 0x69],
    ['BIT', 0x89],
    ['LDA', 0xa9],
    ['CMP', 0xc9],
    ['SBC', 0xe9],
  ]
  /** And every index-width one. */
  const X_IMMEDIATES: ReadonlyArray<readonly [string, number]> = [
    ['LDY', 0xa0],
    ['LDX', 0xa2],
    ['CPY', 0xc0],
    ['CPX', 0xe0],
  ]

  const withWidth = (prefix: number[], op: number, operand: number[]) => {
    const rom = blankRom()
    rom.writeAt(AT, [...prefix, op, ...operand, ...jsr(TARGET), ...RTS])
    const r = run(rom)
    return { reached: [...r.reached.keys()], decoded: r.instructionsDecoded }
  }

  it.each(M_IMMEDIATES)('%s #imm is 2 bytes under SEP #$20 and 3 under REP #$20', (_n, op) => {
    expect(withWidth([0xe2, 0x20], op, [0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
    expect(withWidth([0xc2, 0x20], op, [0x00, 0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
  })

  it.each(X_IMMEDIATES)('%s #imm is 2 bytes under SEP #$10 and 3 under REP #$10', (_n, op) => {
    expect(withWidth([0xe2, 0x10], op, [0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
    expect(withWidth([0xc2, 0x10], op, [0x00, 0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
  })

  it('does not widen an M immediate when only X was widened, or the reverse', () => {
    // A single shared "16-bit" flag would pass everything above and fail
    // here, which is the mistake this pair exists to catch.
    expect(withWidth([0xc2, 0x10], 0xa9, [0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
    expect(withWidth([0xc2, 0x20], 0xa2, [0x00])).toEqual({ reached: ['wanted'], decoded: 4 })
  })
})

describe('the diverting opcodes divert', () => {
  const probe = (body: number[]) => {
    const rom = blankRom()
    rom.writeAt(AT, body)
    return run(rom)
  }

  it.each([
    ['RTI', 0x40],
    ['RTS', 0x60],
    ['RTL', 0x6b],
    ['WAI', 0xcb],
    ['STP', 0xdb],
  ])('%s ends the path before the next instruction', (_name, op) => {
    const r = probe([op as number, ...jsr(TARGET), ...RTS])
    expect([...r.reached.keys()]).toEqual([])
    expect(r.instructionsDecoded).toBe(1)
  })

  it.each([
    ['JMP (abs)', [0x6c, 0x00, 0x90]],
    ['JMP (abs,X)', [0x7c, 0x00, 0x90]],
    ['JML [abs]', [0xdc, 0x00, 0x90]],
    ['JSR (abs,X)', [0xfc, 0x00, 0x90]],
  ])('%s stops with computedJump', (_name, insn) => {
    const r = probe([...(insn as number[]), ...jsr(TARGET), ...RTS])
    expect([...r.reached.keys()]).toEqual([])
    expect(r.stops.has('computedJump')).toBe(true)
  })
})

describe('flag state is part of the decode position', () => {
  it('decodes one address twice when two paths reach it under different M', () => {
    // Keying `visited` on the address alone would decode the join point
    // once and lose the other instruction stream entirely.
    const rom = blankRom()
    //  BNE +2 ; REP #$20 ; join: LDA #imm ; JSR wanted ; RTS
    //  Not taken: 8-bit A, so LDA #$20 is two bytes and the JSR lands.
    //  Taken:    16-bit A, so it is three and the JSR is read one late.
    rom.writeAt(AT, [0xd0, 0x02, 0xc2, 0x20, 0xa9, 0x20, ...jsr(TARGET), ...RTS])
    const r = run(rom)
    expect([...r.reached.keys()]).toEqual(['wanted'])
    // Both decodes of the join happened: the 8-bit one found the call, the
    // 16-bit one ran on into the NOP field and hit the budget.
    expect(r.instructionsDecoded).toBeGreaterThan(4)
  })
})

describe('Y provenance', () => {
  /** `LDY SpriteNumber,X`, the given filler, then the bit test. */
  const withFiller = (filler: number[]) => {
    const rom = blankRom()
    rom.writeAt(AT, [0xb4, 0x9e, ...filler, 0xb9, 0xf0, 0x88, 0x29, 0x40, 0xd0, 0x00, ...RTS])
    return run(rom).branches[0].accumulator
  }

  it('keeps the claim across an instruction that does not touch Y', () => {
    expect(withFiller([0xea])).toMatchObject({ bySpriteNumber: true })
  })

  it.each([
    ['LDY #imm', [0xa0, 0x00]],
    ['LDY dp', [0xa4, 0x00]],
    ['LDY dp,X', [0xb4, 0x00]],
    ['LDY abs', [0xac, 0x00, 0x90]],
    ['LDY abs,X', [0xbc, 0x00, 0x90]],
    ['TAY', [0xa8]],
    ['INY', [0xc8]],
    ['DEY', [0x88]],
    ['PLY', [0x7a]],
    ['TXY', [0x9b]],
  ])('drops the claim after %s', (_name, filler) => {
    expect(withFiller(filler as number[])).toMatchObject({ bySpriteNumber: false })
  })

  it('does NOT drop the claim after TYX, which writes X and not Y', () => {
    // $9B is TXY and $BB is TYX. Swapping the two here once meant a real
    // TXY went unnoticed while a harmless TYX threw the claim away.
    expect(withFiller([0xbb])).toMatchObject({ bySpriteNumber: true })
  })

  it('drops the claim across a call, whose callee may reload Y', () => {
    const rom = blankRom()
    rom.writeAt(0x039400, [0x60])
    rom.writeAt(AT, [0xb4, 0x9e, ...jsr(0x9400), 0xb9, 0xf0, 0x88, 0x29, 0x40, 0xd0, 0x00, ...RTS])
    expect(run(rom).branches[0].accumulator).toMatchObject({ bySpriteNumber: false })
  })
})

describe('the accumulator source distinguishes its load forms', () => {
  const after = (insn: number[]) => {
    const rom = blankRom()
    rom.writeAt(AT, [...insn, 0xd0, 0x00, ...RTS])
    return run(rom).branches[0].accumulator
  }

  it.each([
    ['LDA abs', [0xad, 0xf0, 0x88], false],
    ['LDA abs,X', [0xbd, 0xf0, 0x88], false],
    ['LDA abs,Y', [0xb9, 0xf0, 0x88], true],
  ])('reports %s as a table read', (_name, insn, byY) => {
    expect(after(insn as number[])).toEqual({ kind: 'table', addr: 0x0388f0, indexedByY: byY })
  })

  it('reports LDA long as unknown, because its bank is not the PC bank', () => {
    expect(after([0xaf, 0xf0, 0x88, 0x01]).kind).toBe('unknown')
  })
})

describe.skipIf(!romPresent)('against a real handler', () => {
  /** `GenericSprGfxRt2`, bank_01.asm:2393: PHB PHK PLB JSR SubSprGfx2Entry1. */
  const GENERIC_SPR_GFX_RT2 = 0x0190b2
  const SUB_SPR_GFX_2_ENTRY_1 = 0x019f0d

  it('finds SubSprGfx2Entry1 behind the bank-1 trampoline', () => {
    const rom = freshRom()
    const r = walkHandler(rom, GENERIC_SPR_GFX_RT2, {
      watch: new Map([[SUB_SPR_GFX_2_ENTRY_1, 'sub2']]),
      callDepth: 0,
    })
    expect([...r.reached.keys()]).toEqual(['sub2'])
  })

  it('loses it when the trampoline JSR operand is repointed', () => {
    const rom = freshRom()
    // callDepth 0 so the assertion is about THIS JSR's operand and not
    // about whatever the repointed routine happens to call in turn.
    rom.writeAt(GENERIC_SPR_GFX_RT2 + 4, [0x00, 0x90])
    const r = walkHandler(rom, GENERIC_SPR_GFX_RT2, {
      watch: new Map([[SUB_SPR_GFX_2_ENTRY_1, 'sub2']]),
      callDepth: 0,
    })
    expect([...r.reached.keys()]).toEqual([])
  })
})

/**
 * The return probe, which decides whether the bytes after a call are code.
 *
 * Every failure mode here is the probe being UNCERTAIN. The design rule is
 * that it must refuse rather than assume: a refusal drops `spriteGfxRoutine`
 * back to the frozen floor, while a wrong "it returns" decodes an inline
 * argument table as instructions and answers confidently.
 */
describe('the return probe refuses instead of guessing', () => {
  /** `A: JSR B ; JML [$0000]` - A cannot return.
   *  `B: JSR A ; RTS`         - B returns only if A does, which it does not.
   *  Seeding the memo with an optimistic "returns" to break the cycle, and
   *  then letting a nested probe commit ITS verdict on top of that seed, is
   *  how the same address came back true or false by call order. */
  const orderedPair = (first: number, second: number) => {
    const A = 0x039400
    const B = 0x039500
    const rom = blankRom()
    rom.writeAt(A, [...jsr(B), 0xdc, 0x00, 0x00])
    rom.writeAt(B, [...jsr(A), ...RTS])
    //  BNE +4 ; JSR first ; RTS  |  + JSR second ; JSR wanted ; RTS
    rom.writeAt(AT, [0xd0, 0x04, ...jsr(first), ...RTS, ...jsr(second), ...jsr(TARGET), ...RTS])
    return [...run(rom).reached.keys()]
  }

  it('gives the same verdict whichever of a mutually recursive pair is asked first', () => {
    expect(orderedPair(0x039400, 0x039500)).toEqual(orderedPair(0x039500, 0x039400))
  })

  it('and that verdict is the right one: neither of the pair returns', () => {
    // Without this, the test above passes just as well if both orders are
    // wrong together.
    expect(orderedPair(0x039400, 0x039500)).toEqual([])
  })

  it('refuses a callee that outruns the probe budget', () => {
    // A blank cart is $EA all the way down, so the probe finds no return
    // and no dead end either: it runs out of states.
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    const r = run(rom, AT, { callDepth: 0, probeBudget: 20 })
    expect([...r.reached.keys()]).toEqual([])
    expect(r.stops.has('probeBudget')).toBe(true)
    expect(r.stops.has('nonReturningCall')).toBe(false)
  })

  it('still decides a callee that fits inside the budget', () => {
    // Bytes apart from the case above, so that one is about the budget and
    // not about the call being undecidable.
    const rom = blankRom()
    rom.writeAt(0x03a00a, [...RTS])
    rom.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    const r = run(rom, AT, { callDepth: 0, probeBudget: 20 })
    expect([...r.reached.keys()]).toEqual(['wanted'])
    expect(r.stops.has('probeBudget')).toBe(false)
  })

  it('counts branch sides against that budget, not straight-line length', () => {
    // Two instructions to a dead end along the fall-through, and an
    // endless NOP field on the taken side. A budget measuring how far the
    // callee runs would decide this at once; one measuring distinct
    // states never finishes exploring, so it refuses.
    const rom = blankRom()
    rom.writeAt(0x03a000, [0xd0, 0x03, 0xdc, 0x00, 0x00])
    rom.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    expect(run(rom, AT, { callDepth: 0, probeBudget: 1000 }).stops.has('probeBudget')).toBe(true)

    // The same dead end with the branch taken out is decided immediately,
    // so the refusal above is about the second side and not about the
    // callee being undecidable.
    const straight = blankRom()
    straight.writeAt(0x03a000, [0xea, 0xea, 0xdc, 0x00, 0x00])
    straight.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    const r = run(straight, AT, { callDepth: 0, probeBudget: 1000 })
    expect(r.stops.has('probeBudget')).toBe(false)
    expect(r.stops.has('nonReturningCall')).toBe(true)
  })

  /** A chain of `n` distinct `JSL`s, each to the next, ending in a computed
   *  jump. Only the probe follows it: the walk's own descent is cut off. */
  function callChain(n: number): RomFile {
    const rom = blankRom()
    const slot = (i: number) => ((0x10 + Math.floor(i / 4000)) << 16) | (0x8000 + (i % 4000) * 8)
    for (let i = 0; i < n; i++) rom.writeAt(slot(i), [...jsl(slot(i + 1)), 0x6b])
    rom.writeAt(slot(n), [0xdc, 0x00, 0x00])
    rom.writeAt(AT, [...jsl(slot(0)), ...jsr(TARGET), ...RTS])
    return rom
  }

  it('refuses a call chain deeper than its recursion bound', () => {
    const shallow = walkHandler(callChain(3), AT, { watch, callDepth: 0, probeDepth: 8 })
    expect(shallow.stops.has('nonReturningCall')).toBe(true)
    expect(shallow.stops.has('probeDepth')).toBe(false)

    const deep = walkHandler(callChain(20), AT, { watch, callDepth: 0, probeDepth: 8 })
    expect([...deep.reached.keys()]).toEqual([])
    expect(deep.stops.has('probeDepth')).toBe(true)
  })

  it('bounds itself by default, instead of throwing out of the map build', () => {
    // 5000 nested calls overflowed the JS stack with a `RangeError` that
    // propagated through `readGfxRoutines` into the build.
    const r = walkHandler(callChain(5000), AT, { watch, callDepth: 0 })
    expect(r.stops.has('probeDepth')).toBe(true)
    expect(DEFAULT_PROBE_DEPTH).toBeLessThan(5000)
    expect(DEFAULT_PROBE_BUDGET).toBeGreaterThan(0)
  })

  /** `LDA #$00 : RTS` in 8-bit A, and `LDA #$0060 : JML [$0000]` in 16-bit:
   *  the same six bytes return under one flag state and not the other. */
  const FLAG_SPLIT_CALLEE = [0xa9, 0x00, 0x60, 0xdc, 0x00, 0x00]

  it('keys the probe memo on M and X, not on the address alone', () => {
    const rom = blankRom()
    rom.writeAt(0x03a000, FLAG_SPLIT_CALLEE)
    //  BNE +9 ; SEP #$20 ; JSR callee ; JSR other  ; RTS
    //  taken:   REP #$20 ; JSR callee ; JSR wanted ; RTS
    rom.writeAt(AT, [
      0xd0,
      0x09,
      0xe2,
      0x20,
      ...jsr(0xa000),
      ...jsr(OTHER),
      ...RTS,
      0xc2,
      0x20,
      ...jsr(0xa000),
      ...jsr(TARGET),
      ...RTS,
    ])
    const r = run(rom, AT, { callDepth: 0 })
    // 8-bit side: the callee returns, so `other` is reached. 16-bit side:
    // it does not, so `wanted` is not. An address-only memo hands the
    // second caller the first's answer and one of the two flips.
    expect([...r.reached.keys()]).toEqual(['other'])
    expect(r.stops.has('nonReturningCall')).toBe(true)
  })

  it.each([
    ['8-bit A, where the callee returns', [0xe2, 0x20], ['wanted']],
    ['16-bit A, where it does not', [0xc2, 0x20], []],
  ])('probes a nested call with the flags in force at it: %s', (_n, prefix, expected) => {
    // The deciding call is two levels down, so this pins the flags the
    // probe hands to its own recursion and not only the ones the walk
    // hands to the outermost probe.
    const rom = blankRom()
    rom.writeAt(0x03a000, FLAG_SPLIT_CALLEE)
    rom.writeAt(0x03a100, [...jsr(0xa000), 0x6b]) // wrapper: call, then RTL
    rom.writeAt(AT, [...(prefix as number[]), ...jsl(0x03a100), ...jsr(TARGET), ...RTS])
    expect([...run(rom, AT, { callDepth: 0 }).reached.keys()]).toEqual(expected)
  })

  it('does not read a loop that never leaves the callee as a return', () => {
    // `BRA` to itself. The probe's repeated-state check breaks the loop
    // WITHOUT setting a return, which is the difference between
    // "terminates" and "comes back".
    const rom = blankRom()
    rom.writeAt(0x03a000, [0x80, 0xfe])
    rom.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    const r = run(rom, AT, { callDepth: 0 })
    expect([...r.reached.keys()]).toEqual([])
    expect(r.stops.has('nonReturningCall')).toBe(true)
    expect(r.stops.has('probeBudget')).toBe(false)
  })

  it.each([
    ['RTS', 0x60],
    ['RTL', 0x6b],
    ['RTI', 0x40],
  ])('counts %s as a way back, in the probe and not only in the walk', (_n, op) => {
    // `callDepth: 0` means the walk never decodes the callee itself, so
    // the only thing that can see this byte is the probe.
    const rom = blankRom()
    rom.writeAt(0x03a000, [op as number])
    rom.writeAt(AT, [...jsr(0xa000), ...jsr(TARGET), ...RTS])
    const r = run(rom, AT, { callDepth: 0 })
    expect([...r.reached.keys()]).toEqual(['wanted'])
    expect(r.stops.has('nonReturningCall')).toBe(false)
  })
})

describe('a bank mirror is one address, everywhere it is keyed', () => {
  /** $03:9400 and $83:9400 are one body. Three separate places fold the
   *  bank bit: the visited-state key, the `blocked` set as it is built, and
   *  the `blocked` lookup. Each is pinned on its own, because dropping any
   *  one of them leaves the other two making the claim look covered. */
  const BODY = 0x039400
  const MIRROR = 0x839400

  it('decodes one body once when two spellings of it are reached', () => {
    const rom = blankRom()
    rom.writeAt(BODY, [0xea, 0xea, 0x6b]) // NOP NOP RTL
    rom.writeAt(AT, [...jsl(BODY), ...jsl(MIRROR), ...jsr(TARGET), ...RTS])
    const r = run(rom)
    expect([...r.reached.keys()]).toEqual(['wanted'])
    // JSL, the body's three, the second JSL, nothing for the mirror, then
    // JSR and RTS. Unfolded, the body is decoded a second time.
    expect(r.instructionsDecoded).toBe(7)
  })

  it('blocks a mirror-spelled address the caller asked to cut', () => {
    const rom = blankRom()
    rom.writeAt(AT, [...jsr(TARGET), ...jsr(OTHER), ...RTS])
    const cut = walkHandler(rom, AT, { watch, blocked: new Set([(AT + 3) | 0x800000]) })
    expect([...cut.reached.keys()]).toEqual(['wanted'])
  })

  it('blocks a plainly spelled address reached through its mirror', () => {
    const rom = blankRom()
    rom.writeAt(BODY, [...jsr(OTHER), ...RTS])
    rom.writeAt(AT, [...jsr(TARGET), 0x5c, 0x00, 0x94, 0x83]) // JML $839400
    const cut = walkHandler(rom, AT, { watch, blocked: new Set([BODY]) })
    expect([...cut.reached.keys()]).toEqual(['wanted'])
  })
})

describe('a reached call reports what the accumulator held at it', () => {
  it('names an immediate loaded in front of the call', () => {
    const rom = blankRom()
    rom.writeAt(AT, [0xa9, 0x02, ...jsr(TARGET), ...RTS])
    expect(run(rom).reached.get('wanted')).toEqual({
      at: AT + 2,
      accumulator: { kind: 'immediate', value: 0x02 },
    })
  })

  it('does not name one when the bytes in front only look like an LDA #imm', () => {
    // `LDA $07A9` is `AD A9 07`: three bytes whose last two are $A9 $07, so
    // reading two bytes back from the call site sees an immediate that was
    // never executed. The decoder knows it is a table read.
    const rom = blankRom()
    rom.writeAt(AT, [0xad, 0xa9, 0x07, ...jsr(TARGET), ...RTS])
    expect(run(rom).reached.get('wanted')!.accumulator.kind).toBe('table')
  })
})
