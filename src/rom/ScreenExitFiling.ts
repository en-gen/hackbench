/**
 * Whether the ROM's screen-exit handler still files exits the stock way, found by running it.
 * The exit graph keeps the LAST exit written for a screen (#957) only if the handler (extended
 * object $00, CODE_0DA512, SMWDisX bank_0D.asm:1416-1439) stores each exit under
 * `X = _A & $1F` with a plain STA, `ExitTableHigh,X = _B & 1` and `UseSecondaryExit = _B >> 1`.
 * No byte pattern is compared: the handler runs on the 65816 core and its WRAM effects are read
 * back, so any code with those effects passes and any other is named. The entry comes from the
 * ROM's own extended-object dispatch, not from a constant.
 *
 * Evidence scope: the behaviour checked is the eight (_A, _B, byte) cases below plus a second
 * write to one screen; synthetic ROMs in test/suite/unit/ScreenExitFiling.synthetic.test.ts.
 */
import { callSubroutine, describe as describeResult } from './cpu/call'
import { smwMachine } from './sprites/interp/Machine'
import { ADDR_EXTENDED_DISPATCH, readLongPointer } from './objectHandlers/romData'
import { hex6 } from './hex'
import { romByte } from './sprites/interp/SpriteBus'
import { cachedByVersion, type RomFile } from './RomFile'

// WRAM addresses from SMW_U.sym: Layer1DataPtr, LvlLoadObjNo, _A, _B, ExitTableLow/High, UseSecondaryExit.
const PTR = 0x65
const OBJ_NO = 0x5a
const A = 0x0a
const B = 0x0b
const LOW = 0x19b8
const HIGH = 0x19d8
const SECONDARY = 0x1b93
/** Where the test stream lives: WRAM bank $7E, clear of every address above. */
const STREAM = 0x7e4000
const BUDGET = 200
/** SEP #$30 (bank_0D.asm:1057): A, X and Y 8-bit. The handler is entered with the P that this sets. */
const SEP_IMM_AXY8 = 0x30
/** P after the reset the game's code runs under ($34: IRQ off), with the dispatcher's SEP applied. */
const P_BASE = 0x34
const DISPATCH_JSL_AT = 0x0da10b

interface PathStep {
  at: number
  /** One instruction: opcode and operands, each compared to the ROM singly. */
  bytes: readonly number[]
  what: string
  /** Index of a bank byte, compared with bit 7 masked: a FastROM mirror is the same bank. */
  bankAt?: number
}

/**
 * Every instruction from the level loader's choice of the extended branch to the JSL that indexes
 * the handler table, in execution order (SMWDisX bank_05.asm:794-802, bank_0D.asm:1051-1060;
 * ExecutePtrLong bank_00.asm:864, SMW_U.sym $0086FA). Not read, and why: the code before the LDA
 * at $0586C5 only sets loader state, and a change there skips or repeats the whole object load,
 * not this handler; ExecutePtrLong's own body is shared by every dispatch in the game and is
 * reached only through the checked JSL target; the JMP/RTS after each return run after the
 * handler. A byte that diverts earlier is a byte in this list.
 */
const DISPATCH_PATH: readonly PathStep[] = [
  { at: 0x0586c5, bytes: [0xa5, 0x5a], what: 'LDA LvlLoadObjNo, the extended-object test' },
  { at: 0x0586c7, bytes: [0xd0, 0x06], what: 'BNE past the extended branch' },
  { at: 0x0586c9, bytes: [0x20, 0xe3, 0x86], what: 'JSR LevLoadExtObj' },
  { at: 0x0586e3, bytes: [0xe2, 0x30], what: 'LevLoadExtObj SEP #$30' },
  { at: 0x0586e5, bytes: [0x22, 0x00, 0xa1, 0x0d], what: 'JSL CODE_0DA100', bankAt: 3 },
  { at: 0x0da100, bytes: [0xe2, 0x30], what: 'CODE_0DA100 SEP #$30' },
  { at: 0x0da102, bytes: [0x20, 0x06, 0xa1], what: 'JSR CODE_0DA106' },
  { at: 0x0da105, bytes: [0x6b], what: 'RTL' },
  { at: 0x0da106, bytes: [0xe2, SEP_IMM_AXY8], what: 'the dispatcher SEP #$30 (8-bit registers)' },
  { at: 0x0da108, bytes: [0xa5, 0x59], what: 'LDA LvlLoadObjSize, the extended number' },
  { at: 0x0da10a, bytes: [0xaa], what: 'TAX, the table index' },
  {
    at: DISPATCH_JSL_AT,
    bytes: [0x22, 0xfa, 0x86, 0x00],
    what: 'JSL ExecutePtrLong, the routine that reads the handler table',
    bankAt: 3,
  },
]

const SENTINEL = 0xee

// Screen field with its high bits set (masked by $1F), flags in every combination, extra byte values.
const CASES: readonly (readonly [a: number, b: number, d: number])[] = [
  [0x00, 0x00, 0x11],
  [0x03, 0x01, 0x22],
  [0x1f, 0x02, 0x33],
  [0x25, 0x03, 0xff],
  [0xff, 0x00, 0x00],
  [0xe7, 0x1f, 0x5a],
  [0x10, 0xfe, 0x81],
  [0x08, 0xff, 0x7f],
]

const FILING_CACHE = new WeakMap<RomFile, { version: number; value: string | null }>()

/** Why the handler is not the stock filing, or null when it files exits as modelled. Once per ROM version. */
export function screenExitFilingMismatch(rom: RomFile): string | null {
  return cachedByVersion(FILING_CACHE, rom, () => runFilingCheck(rom))
}

function runFilingCheck(rom: RomFile): string | null {
  const entry = readLongPointer(rom, ADDR_EXTENDED_DISPATCH)
  if (entry === null) return 'the extended-object dispatch is unreadable'
  // The table is three-byte entries only if the path above ends in the JSL with the table right after it.
  if (DISPATCH_JSL_AT + 4 !== ADDR_EXTENDED_DISPATCH)
    return 'the extended-object dispatch table is not where the JSL leaves it'
  for (const step of DISPATCH_PATH) {
    const got = rom.readAt(step.at, step.bytes.length)
    for (let i = 0; i < step.bytes.length; i++) {
      const bank = i === step.bankAt
      if (!got || (bank ? got[i]! & 0x7f : got[i]) !== step.bytes[i])
        return `the extended-object dispatch path differs at $${hex6(step.at + i)}: ${step.what}, so this check cannot tell which handler runs`
    }
  }
  if (romByte(rom, entry) === null)
    return `the extended-object $00 entry $${hex6(entry)} is not in the ROM image`
  try {
    const { bus, cpu } = smwMachine(rom)
    const w = bus.wram
    const run = (a: number, b: number, d: number): string | null => {
      w[PTR] = STREAM & 0xff
      w[PTR + 1] = (STREAM >> 8) & 0xff
      w[PTR + 2] = STREAM >> 16
      w[A] = a
      w[B] = b
      w[0x4000] = d
      const before = w.slice()
      const r = callSubroutine(cpu, entry, {
        kind: 'jsr',
        maxSteps: BUDGET,
        regs: { p: P_BASE | SEP_IMM_AXY8 },
      })
      if (r.kind !== 'returned') return describeResult(r, BUDGET) ?? r.kind
      const x = a & 0x1f
      const want = new Map<number, number>([
        [OBJ_NO, d],
        [LOW + x, d],
        [HIGH + x, b & 1],
        [SECONDARY, b >> 1],
        [PTR, (STREAM + 1) & 0xff],
      ])
      for (let i = 0; i < w.length; i++) {
        if (i >= 0x100 && i < 0x200) continue // the call's own return frame
        const expected = want.get(i) ?? before[i]
        if (w[i] !== expected)
          return `it wrote WRAM $${hex6(0x7e0000 + i)} as $${w[i]!.toString(16)}`
      }
      return null
    }
    w.fill(SENTINEL, LOW, LOW + 0x40)
    for (const [a, b, d] of CASES) {
      const bad = run(a, b, d)
      if (bad)
        return `Screen exits (extended object $00 at $${hex6(entry)}) are not filed per screen: ${bad}.`
    }
    // Last write wins: each run asserts the exact table bytes, so a refiled screen proves the overwrite.
    const again = run(0x07, 0x00, 0x44) ?? run(0x07, 0x01, 0x55)
    return again
      ? `Screen exits (extended object $00 at $${hex6(entry)}) do not keep the last exit written for a screen: ${again}.`
      : null
  } catch (e) {
    return `Screen exits could not be run: ${e instanceof Error ? e.message : String(e)}.`
  }
}
