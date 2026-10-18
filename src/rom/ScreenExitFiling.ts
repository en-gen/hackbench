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
import type { RomFile } from './RomFile'

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
/** The extended-object dispatcher's SEP and its JSL ExecutePtrLong (bank_0D.asm:1056-1060): one opcode byte each, compared singly. */
export const DISPATCH_SEP_AT = 0x0da106
export const DISPATCH_JSL_AT = 0x0da10b
const SEP = 0xe2
const JSL = 0x22
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

/** Why the handler is not the stock filing, or null when it files exits as modelled. */
export function screenExitFilingMismatch(rom: RomFile): string | null {
  const entry = readLongPointer(rom, ADDR_EXTENDED_DISPATCH)
  if (entry === null) return 'the extended-object dispatch is unreadable'
  // The table is three-byte entries only if the dispatcher still JSLs ExecutePtrLong with the table right after it.
  const shape =
    rom.readByte(DISPATCH_SEP_AT) === SEP &&
    rom.readByte(DISPATCH_JSL_AT) === JSL &&
    DISPATCH_JSL_AT + 4 === ADDR_EXTENDED_DISPATCH
  if (!shape) return 'the extended-object dispatch is not the long-pointer call this check reads'
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
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: BUDGET })
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
    // Last write wins: a second exit for the same screen replaces the first.
    const again = run(0x07, 0x00, 0x44) ?? run(0x07, 0x01, 0x55)
    if (again)
      return `Screen exits (extended object $00 at $${hex6(entry)}) are not filed per screen: ${again}.`
    return w[LOW + 7] === 0x55 && w[HIGH + 7] === 1
      ? null
      : `Screen exits (extended object $00 at $${hex6(entry)}) do not keep the last exit written for a screen.`
  } catch (e) {
    return `Screen exits could not be run: ${e instanceof Error ? e.message : String(e)}.`
  }
}
