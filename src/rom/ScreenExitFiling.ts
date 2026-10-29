/**
 * Whether the ROM's screen-exit handler still files exits the stock way, found by running the
 * game's own extended-object load. The exit graph keeps the LAST exit written for a screen (#957)
 * only if the handler (extended object $00, CODE_0DA512, SMWDisX bank_0D.asm:1416-1439) stores
 * each exit under `X = _A & $1F` with a plain STA, `ExitTableHigh,X = _B & 1` and
 * `UseSecondaryExit = _B >> 1`.
 *
 * Nothing about the code is stated: no byte, hash or instruction. The fixed entry is
 * LevLoadExtObj ($0586E3, bank_05.asm:800-803, the routine the loader calls for an extended
 * object), entered as a subroutine with only the state the loader reads seeded (the extended
 * number in LvlLoadObjSize, _A, _B, the Layer 1 pointer and its object bytes). The ROM's own
 * code then runs the dispatcher, ExecutePtrLong and the handler on the 65816 core under a step
 * budget, so a diversion anywhere on that path (a jump, a return, a moved table) shows up as
 * wrong WRAM, a refused instruction or a budget overrun. Only the WRAM effect is read back.
 * This is the fourth bounded exception in .claude/rules/rom-interpretation.md.
 *
 * Evidence scope: the eight (_A, _B, byte) cases below, supplemented by two writes to screen 7:
 * first (_B $00, byte $44), then (_B $01, byte $55); the second must overwrite the first, so
 * ExitTableLow,7 ends $55 and ExitTableHigh,7 ends 1;
 * synthetic carts in test/suite/unit/ScreenExitFiling.synthetic.test.ts, and the stock vanilla
 * and magic ROMs pass (one machine). Not modelled: the Layer 2 object stream reaches the same
 * handler through a different caller.
 */
import { callSubroutine, describe as describeResult } from './cpu/call'
import { smwMachine } from './sprites/interp/Machine'
import { hex6 } from './hex'
import { cachedByVersion, type RomFile } from './RomFile'

/** LevLoadExtObj (SMW_U.sym $0586E3): the loader's call for an extended object, entered as a subroutine. */
const LOADER_ENTRY = 0x0586e3
/** LvlLoadObjSize: the extended-object number the dispatcher indexes (bank_0D.asm:1058). Object $00 is the screen exit. */
const EXT_NO = 0x59

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

/** The uncached check: seeds the loader's inputs, runs the extended-object load path, and judges the WRAM it leaves. */
function runFilingCheck(rom: RomFile): string | null {
  try {
    const { bus, cpu } = smwMachine(rom)
    const w = bus.wram
    /** One handler run for an (_A, _B, byte) exit; null when WRAM holds exactly what a per-screen filing leaves, else the reason. */
    const run = (a: number, b: number, d: number): string | null => {
      w[PTR] = STREAM & 0xff
      w[PTR + 1] = (STREAM >> 8) & 0xff
      w[PTR + 2] = STREAM >> 16
      w[EXT_NO] = 0
      w[A] = a
      w[B] = b
      w[0x4000] = d
      const before = w.slice()
      // Entering at the game's own caller (LevLoadExtObj) puts the dispatcher, ExecutePtrLong and the
      // table on the run's path, so a diverted jump, a return or a moved table shows up as wrong WRAM,
      // a refused instruction or a budget overrun instead of needing bytes stated here to catch it
      // (exception 4, .claude/rules/rom-interpretation.md).
      const r = callSubroutine(cpu, LOADER_ENTRY, { kind: 'jsr', maxSteps: BUDGET })
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
        if (i < 6) continue // $00-$05: ExecutePtrLong's scratch (bank_00.asm:864-880)
        const expected = want.get(i) ?? before[i]
        if (w[i] !== expected)
          return `WRAM $${hex6(0x7e0000 + i)} holds $${w[i]!.toString(16)}, not the $${expected!.toString(16)} an exit filing leaves`
      }
      return null
    }
    w.fill(SENTINEL, LOW, LOW + 0x40)
    for (const [a, b, d] of CASES) {
      const bad = run(a, b, d)
      if (bad) return `Screen exits (extended object $00) are not filed per screen: ${bad}.`
    }
    // Last write wins: each run asserts the exact table bytes, so a refiled screen proves the overwrite.
    const again = run(0x07, 0x00, 0x44) ?? run(0x07, 0x01, 0x55)
    return again
      ? `Screen exits (extended object $00) do not keep the last exit written for a screen: ${again}.`
      : null
  } catch (e) {
    return `Screen exits could not be run: ${e instanceof Error ? e.message : String(e)}.`
  }
}
