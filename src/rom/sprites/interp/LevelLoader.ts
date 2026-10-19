/**
 * LevelLoader.ts -- the level state a sprite reads, produced by running the
 * ROM's OWN level loader on the core instead of copying it from anywhere.
 *
 * Sequence (each step the game's own code): put the level number in $0E/$0F,
 * run the pointer and sprite-header loader (CODE_05D8B7, SMWDisX
 * bank_05.asm:7227, entered mid-routine: it ends in the RTL of CODE_05D796;
 * Layer 1/2 data pointers, sprite memory $1692, buoyancy $190E), then Mario's
 * entrance setup (CODE_00A635, bank_00.asm:4913), with the GM11 work around it
 * (bank_00.asm:2645-2649 layer position copy, 2652-2656 screen setup), then the level-data loader
 * (CODE_05801E, bank_05.asm:20-70: header parse CODE_0584E3, called at line
 * 428, for $5B/$5D/$64; tileset slope pointer CODE_0581FB, line 253; then every
 * object of Layer 1 expanded into the Map16 tables at $7E:C800/$7F:C800).
 * Hardware registers are the bus stubs; nothing is read from an emulator capture.
 *
 * The fixed entries and the GM11 spans between them are checked instruction by instruction (SITES: the calls by their targets), and the jump that leads into
 * the mid-routine entry by its target (an entry that exists is not an entry that is reached),
 * and the run is guarded like the sprite runner's (no BRK/COP, no leaving ROM).
 * A ROM that differs, as the corpus hacks do, is refused with a reason rather
 * than run on a guess; the caller then has no loaded image.
 *
 * Evidence scope: vanilla, one level at a time; exercised by the grader in
 * test/suite/unit/sprites/spriteGrade.captures.test.ts.
 */
import {
  callSubroutine,
  describe,
  nativeReset,
  Refusal,
  runUntil,
  type CallResult,
} from '../../cpu/call'
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { bytesAt, mapperProblem } from './Guards'
import { smwMachine } from './Machine'
import { withSeed, type SeedOverride, type SpriteSeed } from './SpriteSeed'

/**
 * Instruction cap for the whole load (all five steps). The loader runs on the
 * Theia RPC thread (map-sprites.ts), so a ROM that passes the shapes and loops
 * must be refused quickly. Vanilla's worst level over all 512 level numbers is
 * 276,864 steps (max over levels 0-511, one run, 2026-10-07), so this is ~7x headroom.
 */
export const LOADER_TOTAL_CAP = 2_000_000

export type LevelLoad =
  { ok: true; wram: Uint8Array; steps: number } | { ok: false; reason: string }

// Entries the loader runs, by their 16-bit address within bank $05 or $00 (compared with what the ROM's own
// call and jump operands name; see SITES).
const POINTER_LOADER = 0x05d8b7
const HEADER_LOADER = 0xd796 // CODE_05D796, whose sublevel branch ends in the jump into the pointer loader
const ENTRANCE_SETUP = 0xa635
const DATA_LOADER = 0x801e
const SUBLEVEL_JUMP = 0x05d83b // the jump into the pointer loader
const OVERWORLD_PATH = (SUBLEVEL_JUMP + 3) & 0xffff // derived: where CODE_05D796's overworld branch jumps, the instruction after that jump
const LEVEL_NUMBER_DP = 0x0e // the cell the loader writes the level number to, and the pointer loader reads
const SUBLEVEL_FLAG = 0x141a // SublevelCount, which the loader sets and CODE_05D796 tests
const SCREEN_UPDATE = 0xf6db // UpdateScreenPosition, which the screen setup calls

// 65816 opcodes, named once; each site below checks one instruction.
const PHB = 0x8b
const PHP = 0x08
const REP = 0xc2
const LDA_IMM = 0xa9
const LDA_DP = 0xa5
const LDA_ABS = 0xad
const JSR = 0x20
const JSL = 0x22
const JMP = 0x4c
const CLC = 0x18
const STZ_ABS = 0x9c
const BNE = 0xd0

/**
 * One instruction the loader relies on, checked on its own: its opcode and, where the loader is bound to
 * it, its operand (a call or jump target, or a cell), read from the ROM. No run of more than one
 * instruction is stated, so no ROM bytes are held here (rom-interpretation.md stock-code exception, #1030).
 * `bank` is the bank a long call must name ($80 mirrors ignored unless `bankExact`). `lands` is, for a
 * relative branch, the opcode the instruction its displacement reaches must carry (the distance is read, not stated). Everything between the sites is not
 * compared: the routines run from the ROM's own bytes, and the runner refuses a stray return or a budget overrun.
 */
export interface Site {
  name: string
  at: number
  op: number
  /** Operand the instruction must carry, little endian. */
  operand?: { value: number; size: 1 | 2 }
  bank?: number
  bankExact?: boolean
  lands?: number
}

export const LOADER_SITES: readonly Site[] = [
  // GM11LoadLevel's three calls, in the order the loader makes them (bank_00.asm:2644, 2651, 2657).
  { name: 'GM11 call JSL CODE_05D796 at $00:96F4', at: 0x0096f4, op: JSL, operand: { value: HEADER_LOADER, size: 2 }, bank: 5 }, // prettier-ignore
  { name: 'GM11 call JSR CODE_00A635 at $00:9705', at: 0x009705, op: JSR, operand: { value: ENTRANCE_SETUP, size: 2 } }, // prettier-ignore
  { name: 'GM11 call JSL CODE_05801E at $00:9716', at: 0x009716, op: JSL, operand: { value: DATA_LOADER, size: 2 }, bank: 5 }, // prettier-ignore
  // The screen setup (bank_00.asm:2652) opens with a load, not a hook: a hack that replaces it (Seven Vanilla
  // Levels does) is code a sequence that ran the original span would misread. Its calls are followed by the run.
  { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: 0x009708, op: LDA_IMM }, // prettier-ignore
  // The span ends in the call to UpdateScreenPosition, in bank 0 itself (a $80 mirror is another return bank).
  { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: 0x009708 + 10, op: JSL, operand: { value: SCREEN_UPDATE, size: 2 }, bank: 0, bankExact: true }, // prettier-ignore
  // CODE_05D796 (bank_05.asm:7079-7093): it opens with the PHB that CODE_05D8B7's PLB pairs with, reads the
  // sublevel flag the loader sets, and its sublevel branch is the jump into the pointer loader, the overworld
  // branch the jump past it. Single instructions at their offsets; the routine itself is not run.
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796, op: PHB },
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796 + 5, op: STZ_ABS },
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796 + 21, op: LDA_ABS, operand: { value: SUBLEVEL_FLAG, size: 2 } }, // prettier-ignore
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796 + 26, op: JMP, operand: { value: OVERWORLD_PATH, size: 2 } }, // prettier-ignore
  // The sublevel branch ends in JMP CODE_05D8B7 (bank_05.asm:7162).
  { name: 'jump into the pointer loader at $05:D83B', at: SUBLEVEL_JUMP, op: JMP, operand: { value: POINTER_LOADER & 0xffff, size: 2 } }, // prettier-ignore
  // CODE_05D8B7 opens with REP and reads the level number from the cell the loader writes (bank_05.asm:7228-7229).
  { name: 'pointer loader at $05:D8B7', at: POINTER_LOADER, op: REP },
  { name: 'pointer loader at $05:D8B7', at: POINTER_LOADER + 5, op: CLC },
  { name: 'pointer loader at $05:D8B7', at: POINTER_LOADER + 2, op: LDA_DP, operand: { value: LEVEL_NUMBER_DP, size: 1 } }, // prettier-ignore
  // The entrance setup opens with a load (bank_00.asm:4914) and the data loader with PHP (bank_05.asm:21).
  { name: 'Mario entrance setup at $00:A635', at: ENTRANCE_SETUP, op: LDA_ABS },
  { name: 'Mario entrance setup at $00:A635', at: ENTRANCE_SETUP + 9, op: BNE, lands: LDA_ABS },
  { name: 'level data loader at $05:801E', at: 0x05801e, op: PHP },
]

/** Whether the instruction at site `s` is the one the loader knows (opcode, operand, bank, branch landing). */
function siteHolds(rom: RomFile, s: Site): boolean {
  const n =
    1 + (s.operand?.size ?? (s.lands === undefined ? 0 : 1)) + (s.bank === undefined ? 0 : 1)
  const b = bytesAt(rom, s.at, n)
  if (!b || b[0] !== s.op) return false
  if (s.operand) {
    const v = s.operand.size === 2 ? (b[2]! << 8) | b[1]! : b[1]!
    if (v !== s.operand.value) return false
  }
  if (s.lands !== undefined) {
    const dest = (s.at & 0xff0000) | ((s.at + 2 + ((b[1]! << 24) >> 24)) & 0xffff)
    if (bytesAt(rom, dest, 1)?.[0] !== s.lands) return false
  }
  if (s.bank === undefined) return true
  return (s.bankExact ? b[n - 1]! : b[n - 1]! & 0x7f) === s.bank
}

/** The first loader site whose instruction is not the one this loader knows, or null. */
export function loaderShapeProblem(rom: RomFile): string | null {
  const mapper = mapperProblem(rom)
  if (mapper) return mapper
  const bad = LOADER_SITES.find(s => !siteHolds(rom, s))
  return bad ? `${bad.name} is not the vanilla shape; the loader will not run it` : null
}

/** RNGCalc (rammap.asm), the 16-bit GetRand state. */
export const RNG_CALC = 0x148b

/**
 * The 128 KB WRAM after the ROM has loaded `level` (the 9-bit level number, e.g.
 * 0x105). RNGCalc ($148B/C) starts at `rng` (power-on zero) and is left as the loader's
 * own GetRand calls advance it; SpriteRunner.ts runs one more GetRand when it is still zero.
 */
export function loadLevelState(rom: RomFile, level: number, rng = 0): LevelLoad {
  const problem = loaderShapeProblem(rom)
  if (problem) return { ok: false, reason: problem }
  const { bus, cpu } = smwMachine(rom)
  const w = bus.wram
  // RNGCalc ($148B/C) as an earlier load left it: the loader calls GetRand (SmashLanding.ts).
  w[RNG_CALC] = rng & 0xff
  w[RNG_CALC + 1] = rng >> 8
  // SublevelCount ($141A) nonzero is a sublevel entry: it skips the
  // overworld-only intro branches that would overwrite the sprite memory setting.
  w[SUBLEVEL_FLAG] = 1
  w[LEVEL_NUMBER_DP] = level & 0xff
  w[LEVEL_NUMBER_DP + 1] = (level >> 8) & 0xff
  let steps = 0
  // One loader step: `go` gets the steps left in the total cap and returns how the step ended.
  const step = (name: string, go: (room: number) => CallResult) => {
    const room = LOADER_TOTAL_CAP - steps
    const r: CallResult = room > 0 ? go(room) : { kind: 'budget', steps: 0 }
    steps += r.steps
    if (r.kind === 'returned') return null
    if (r.kind === 'budget') return `${name} did not return within the loader's total of ${LOADER_TOTAL_CAP} steps` // prettier-ignore
    return describe(r, LOADER_TOTAL_CAP)
  }
  const run = (name: string, entry: number, kind: 'jsr' | 'jsl', db: number, extra?: number[]) =>
    step(name, room => callSubroutine(cpu, entry, { kind, maxSteps: room, regs: { db }, extra }))
  // Runs the ROM's own inline GM11 bytes from `from` until PC reaches `to` (bank 0): the spans of
  // GM11LoadLevel (bank_00.asm:2645-2649, 2652-2656) are not subroutines, so there is no return frame.
  const span = (name: string, from: number, to: number) =>
    step(name, room => {
      nativeReset(cpu)
      cpu.pb = 0
      cpu.pc = from
      // Like callSubroutine: arriving at `to` on any other S, or popping above the start S, is a
      // wrong-kind or stray return (RTS from a JSL frame, RTL from a JSR frame), not a finished span.
      const s0 = cpu.s
      const unbalanced = (c: Cpu65816): CallResult => ({ kind: 'unbalanced', s: c.s, expected: s0, pb: c.pb, expectedPb: 0, steps: 0 }) // prettier-ignore
      // A return to `to` in another bank (RTS from a hook in bank $05) is refused by name, as
      // callSubroutine refuses a return into the wrong bank.
      const wrongBank = (c: Cpu65816): CallResult => ({ kind: 'refused', reason: `returned to $00:${to.toString(16).toUpperCase()} in bank $${c.pb.toString(16).toUpperCase().padStart(2, '0')}; the call frame was not unwound`, at: (c.pb << 16) | c.pc, steps: 0 }) // prettier-ignore
      return runUntil(
        cpu,
        room,
        k => k.pb === 0 && k.pc === to && k.s === s0,
        k =>
          k.pc === to && k.pb !== 0
            ? wrongBank(k)
            : k.s > s0 || (k.pb === 0 && k.pc === to)
              ? unbalanced(k)
              : null,
      )
    })
  try {
    // CODE_05D8B7 is entered mid-routine, after CODE_05D796's PHB; its PLB needs that byte.
    // GM11LoadLevel's order (bank_00.asm:2644-2657): the header loader, the layer position copy
    // (2645-2649), [UploadLevelMusic, not modelled], CODE_00A635 (the per-level timers and Mario's
    // entrance state), the screen setup (2652-2656, ending in UpdateScreenPosition), then CODE_05801E.
    // That one ends with PLP, RTL; it saves its own DB use via the JSL caller.
    const bad =
      run('level pointer loader', POINTER_LOADER, 'jsl', 0x05, [0x05]) ??
      span('layer position copy', 0x0096f8, 0x009702) ??
      run('Mario entrance setup', ENTRANCE_SETUP, 'jsr', 0x00) ??
      span('screen position setup', 0x009708, 0x009716) ??
      run('level data loader', 0x05801e, 'jsl', 0x05)
    if (bad) return { ok: false, reason: bad }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
  return { ok: true, wram: w, steps }
}

/** $18B8 ActivateClusterSprite and the 20 ClusterSpriteNumber cells from $1892 (rammap.asm:1872, 1855). */
const NO_CLUSTER_SPRITES: Record<number, number> = Object.fromEntries([
  [0x18b8, 0],
  ...Array.from({ length: 20 }, (_, i) => [0x1892 + i, 0]),
])

/**
 * A seed for `level` with the ROM-run level state when the loader accepts the
 * ROM, else a generic seed that records why in `loadRefusal` (the model then
 * reports `seedSource: 'generic'` with that reason).
 *
 * The level's cluster sprites do not run (#809), as the runner already keeps
 * its twelve slots empty: the sprite loop calls them after the slots while
 * ActivateClusterSprite is set (CODE_01808C, SMWDisX bank_01.asm:128-130),
 * so their OAM would read as the tested sprite's (map $101's castle flames
 * fill 124-127, and 123 as an overflow copy when a flame's X is $F0 or more,
 * CODE_02FA16, bank_02.asm:16221-16278). Their numbers are cleared too, in
 * case the sprite itself sets the flag. The clear belongs beside the slot
 * clear in SpriteRunner.load; it is here because that file is mid-change
 * (#798), so a seed built without levelSeed still runs them.
 */
export function levelSeed(rom: RomFile, level: number, over: SeedOverride = {}): SpriteSeed {
  const l = loadLevelState(rom, level)
  // These cells win over `over.ram`; a caller can still set them on the result through withSeed.
  const ram = { ...over.ram, ...NO_CLUSTER_SPRITES }
  return withSeed(l.ok ? { ...over, ram, loaded: l.wram } : { ...over, ram, loadRefusal: l.reason })
}
