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
 * The fixed GM11 calls and single instructions at the resolved entries are checked (loaderSites); the GM11
 * spans between them are run on the core, not checked. The targets of the calls and of the jump that leads
 * into the mid-routine entry are followed (an entry that exists is not an entry that is reached), and the
 * run is guarded like the sprite runner's (no BRK/COP, no leaving ROM).
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

// Fixed places of the GM11 sequence and of the sublevel jump (bank_00.asm:2644-2657, bank_05.asm:7162). Every
// other address the loader enters (the header loader, the entrance setup, the data loader, the pointer loader)
// and every cell it seeds is read from the operands found here, never stated.
const HEADER_CALL = 0x0096f4
/** The music upload call (bank_00.asm:2650): between the two spans, neither checked nor run. */
const MUSIC_CALL = 0x009702
const ENTRANCE_CALL = 0x009705
const SCREEN_SETUP = 0x009708
const SCREEN_UPDATE_CALL = SCREEN_SETUP + 10
const DATA_CALL = 0x009716
/**
 * The two inline GM11 spans the loader runs from the ROM's bytes, as [from, to) in bank 0 (bank_00.asm:2645-2649,
 * 2652-2656): each starts where the instruction before it ends and ends at the next call, so the checked
 * sites and the run start and stop at the same places.
 */
export const GM11_SPANS = {
  layerCopy: [HEADER_CALL + 4, MUSIC_CALL],
  screenSetup: [SCREEN_SETUP, DATA_CALL],
} as const
const JUMP_OFFSET = 26 // the JMP in CODE_05D796's prologue, from its entry (bank_05.asm:7093)
const PROLOGUE_END = JUMP_OFFSET + 3 // the instruction after that JMP, where the sublevel branch continues
const WRAM_END = 0x2000 // the cells the loader seeds must lie in work RAM ($0000-$1FFF)

/** Names the sublevel jump into the pointer loader at the address the header loader's overworld jump implies. */
const nameJump = (at: number): string => `jump into the pointer loader at ${hexAt(at)}`
const NAME_HEADER_CALL = 'GM11 call JSL CODE_05D796 at $00:96F4'
const NAME_ENTRANCE_CALL = 'GM11 call JSR CODE_00A635 at $00:9705'
const NAME_DATA_CALL = 'GM11 call JSL CODE_05801E at $00:9716'
/** A 24-bit address as `$BB:AAAA`. */
const hexAt = (a: number): string =>
  `$${(a >> 16).toString(16).toUpperCase().padStart(2, '0')}:${(a & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`

// Names of the routines the ROM's calls reach, built from the address the check actually ran at (a hack
// may have moved a routine); the label says which vanilla routine it stands for.
/** Names the header loader at the address its call resolved to, so a refusal points at the moved code. */
const nameHeader = (at: number): string => `CODE_05D796-equivalent header loader at ${hexAt(at)}`
/** Names the pointer loader at the address the sublevel jump resolved to, so a refusal points at the moved code. */
const namePointer = (at: number): string => `CODE_05D8B7-equivalent pointer loader at ${hexAt(at)}`
/** Names the entrance setup at the address its call resolved to, so a refusal points at the moved code. */
const nameEntrance = (at: number): string => `CODE_00A635-equivalent entrance setup at ${hexAt(at)}`
/** Names the data loader at the address its call resolved to, so a refusal points at the moved code. */
const nameData = (at: number): string => `CODE_05801E-equivalent data loader at ${hexAt(at)}`

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

// Unchecked, as on develop (follow-up filed by Planning): the music upload call at $00:9702 (JSR UploadLevelMusic,
// SMWDisX bank_00.asm:2650) between the layer position copy and the entrance call is not modelled, and
// CODE_05D796's screen-exit code from $05:D7B3 to the jump at $05:D83B (bank_05.asm:7095-7162) is skipped, because
// the loader enters CODE_05D8B7 with the level number already in place; that code would overwrite it from the
// exit tables.

/**
 * One instruction the loader relies on, checked on its own: its opcode and, where the loader is bound to
 * it, its operand, read from the ROM. No run of more than one instruction is stated, so no ROM bytes are
 * held here (per .claude/rules/rom-interpretation.md, block-collision use: the level loader checks single
 * named instructions, no stored byte runs, #1081; the routines are run per the #1030 stock-code exception). Every
 * instruction between the sites is run on the core or, for the two gaps above, unchecked as on develop.
 * `bank` is the bank a long call must name ($80 mirrors ignored unless `bankExact`). `lands` is, for a
 * relative branch, the opcode the instruction its displacement reaches must carry (the distance is read,
 * not stated). Operands that name an entry or a cell are not compared: they are read and followed (`entriesOf`).
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

/** The entries and cells the ROM's own calls and jump name, as 24-bit addresses and cell numbers. */
interface Entries {
  header: number
  headerBank: number
  entrance: number
  data: number
  dataBank: number
  pointer: number
  /** The sublevel jump into the pointer loader. */
  jump: number
  /** The cell the pointer loader reads the level number from. */
  levelCell: number
  /** The cell the header loader's prologue tests (the sublevel flag). */
  sublevelCell: number
}

/** The operand of the instruction at `at` (and the bank byte of a long call), or null when its opcode is not `op`. */
function operandAt(
  rom: RomFile,
  at: number,
  op: number,
  size: 1 | 2 = 2,
): { value: number; bank: number } | null {
  const b = bytesAt(rom, at, 1 + size + (op === JSL ? 1 : 0))
  if (!b || b[0] !== op) return null
  return { value: size === 2 ? (b[2]! << 8) | b[1]! : b[1]!, bank: op === JSL ? b[3]! : 0 }
}

/** What the ROM's calls and jump name, or the name of the site whose instruction is not the expected one. */
function entriesOf(rom: RomFile): Entries | string {
  const head = operandAt(rom, HEADER_CALL, JSL)
  const ent = operandAt(rom, ENTRANCE_CALL, JSR)
  const data = operandAt(rom, DATA_CALL, JSL)
  if (!head) return NAME_HEADER_CALL
  if (!ent) return NAME_ENTRANCE_CALL
  if (!data) return NAME_DATA_CALL
  const headerBank = head.bank & 0x7f
  const dataBank = data.bank & 0x7f
  const header = (headerBank << 16) | head.value
  // The overworld JMP in the called header loader lands on the instruction after the sublevel jump (bank_05.asm:
  // 7093, 7162), so that jump is found from the routine the ROM reaches, not at a fixed address.
  const over = operandAt(rom, header + JUMP_OFFSET, JMP)
  if (!over) return nameHeader(header)
  const jump = (headerBank << 16) | ((over.value - 3) & 0xffff)
  const ptr = operandAt(rom, jump, JMP)
  if (!ptr) return nameJump(jump)
  const pointer = (headerBank << 16) | ptr.value
  const flag = operandAt(rom, header + 21, LDA_ABS)
  const level = operandAt(rom, pointer + 2, LDA_DP, 1)
  if (!flag) return nameHeader(header)
  if (!level) return namePointer(pointer)
  // The pointer loader's cell is a direct-page operand, taken as an absolute address because D = 0 (nativeReset).
  if (flag.value >= WRAM_END) return `${nameHeader(header)} (sublevel flag cell outside work RAM)`
  if (level.value + 1 >= WRAM_END)
    return `${namePointer(pointer)} (level number cell outside work RAM)`
  return {
    header,
    headerBank,
    entrance: ent.value,
    data: (dataBank << 16) | data.value,
    dataBank,
    pointer,
    jump,
    levelCell: level.value,
    sublevelCell: flag.value,
  }
}

/** The instructions the loader checks on `rom`, at the addresses its own calls name (the fixed ones first). */
export function loaderSites(rom: RomFile): Site[] {
  const sites: Site[] = [
    // GM11LoadLevel's three calls, in the order the loader makes them (bank_00.asm:2644, 2651, 2657).
    { name: NAME_HEADER_CALL, at: HEADER_CALL, op: JSL, bank: 5 },
    { name: NAME_ENTRANCE_CALL, at: ENTRANCE_CALL, op: JSR },
    { name: NAME_DATA_CALL, at: DATA_CALL, op: JSL, bank: 5 },
    // The screen setup (bank_00.asm:2652) opens with a load, not a hook, and ends in the call to
    // UpdateScreenPosition in bank 0 itself (a $80 mirror is another return bank). The rest is run.
    { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: SCREEN_SETUP, op: LDA_IMM }, // prettier-ignore
    { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: SCREEN_UPDATE_CALL, op: JSL, bank: 0, bankExact: true }, // prettier-ignore
    // The sublevel branch ends in JMP CODE_05D8B7 (bank_05.asm:7162).
  ]
  const e = entriesOf(rom)
  if (typeof e === 'string') return sites
  const h = nameHeader(e.header)
  const p = namePointer(e.pointer)
  const a = nameEntrance(e.entrance)
  // CODE_05D796 (bank_05.asm:7079-7093) opens with the PHB that CODE_05D8B7's PLB pairs with, tests the sublevel
  // flag the loader sets, and ends its overworld branch in a jump past the sublevel one. Its prologue is run
  // (loadLevelState); only single instructions are named here.
  sites.push(
    { name: h, at: e.header, op: PHB },
    { name: h, at: e.header + 5, op: STZ_ABS },
    { name: h, at: e.header + 21, op: LDA_ABS },
    { name: h, at: e.header + JUMP_OFFSET, op: JMP },
    { name: nameJump(e.jump), at: e.jump, op: JMP },
    // CODE_05D8B7 opens with REP and reads the level number from the cell the loader writes (bank_05.asm:7228-7229).
    { name: p, at: e.pointer, op: REP },
    { name: p, at: e.pointer + 2, op: LDA_DP },
    { name: p, at: e.pointer + 5, op: CLC },
    // The entrance setup opens with a load (bank_00.asm:4914), its first branch lands on one; the data loader opens with PHP.
    { name: a, at: e.entrance, op: LDA_ABS },
    { name: a, at: e.entrance + 9, op: BNE, lands: LDA_ABS },
    { name: nameData(e.data), at: e.data, op: PHP },
  )
  return sites
}

/** Whether the instruction at site `s` is the one the loader knows (opcode, operand, bank, branch landing). */
function siteHolds(rom: RomFile, s: Site): boolean {
  // A long call is four bytes: opcode, 16-bit target, bank.
  const n = s.bank !== undefined ? 4 : 1 + (s.operand?.size ?? (s.lands === undefined ? 0 : 1))
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
  return (s.bankExact ? b[3]! : b[3]! & 0x7f) === s.bank
}

/** The first loader site whose instruction is not the one this loader knows, or null. */
export function loaderShapeProblem(rom: RomFile): string | null {
  const mapper = mapperProblem(rom)
  if (mapper) return mapper
  const refuse = (name: string) => `${name} is not the vanilla shape; the loader will not run it`
  const bad = loaderSites(rom).find(s => !siteHolds(rom, s))
  if (bad) return refuse(bad.name)
  const e = entriesOf(rom)
  return typeof e === 'string' ? refuse(e) : null
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
  const e = entriesOf(rom) as Entries // an Entries: the shape check above passed
  const { bus, cpu } = smwMachine(rom)
  const w = bus.wram
  // RNGCalc ($148B/C) as an earlier load left it: the loader calls GetRand (SmashLanding.ts).
  w[RNG_CALC] = rng & 0xff
  w[RNG_CALC + 1] = rng >> 8
  // SublevelCount ($141A) nonzero is a sublevel entry: it skips the
  // overworld-only intro branches that would overwrite the sprite memory setting.
  w[e.sublevelCell] = 1
  w[e.levelCell] = level & 0xff
  w[e.levelCell + 1] = (level >> 8) & 0xff
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
  // CODE_05D796's prologue, run from its entry to the instruction after its overworld jump (where the sublevel
  // branch continues). Entered with 16-bit registers, which the prologue itself must narrow; leaving the
  // routine's own range (a hook) or leaving 16-bit registers behind is refused. The screen-exit code after it
  // (to the jump at $05:D83B) is not run, as on develop.
  const prologue = () =>
    step('CODE_05D796 prologue', room => {
      nativeReset(cpu, 0x04)
      cpu.pb = e.headerBank
      const lo = e.header & 0xffff
      cpu.pc = lo
      const s0 = cpu.s
      const arrive = lo + PROLOGUE_END
      const at = (c: Cpu65816) => `$${c.pb.toString(16).toUpperCase().padStart(2, '0')}:${c.pc.toString(16).toUpperCase().padStart(4, '0')}` // prettier-ignore
      const gone = (c: Cpu65816): CallResult | null =>
        c.pb !== e.headerBank || c.pc < lo || c.pc > arrive
          ? { kind: 'refused', reason: `CODE_05D796's prologue left its routine at ${at(c)}`, at: (c.pb << 16) | c.pc, steps: 0 } // prettier-ignore
          : null
      const r = runUntil(cpu, room, c => c.pb === e.headerBank && c.pc === arrive, gone)
      if (r.kind !== 'returned') return r
      const why = !(cpu.m8 && cpu.x8)
        ? "CODE_05D796's prologue did not narrow the registers to 8 bits"
        : cpu.s !== s0 - 1
          ? "CODE_05D796's prologue did not leave exactly its PHB on the stack"
          : null
      return why ? { kind: 'refused', reason: why, at: (cpu.pb << 16) | cpu.pc, steps: r.steps } : r
    })
  try {
    // CODE_05D8B7 is entered mid-routine, after CODE_05D796's PHB; its PLB needs that byte.
    // GM11LoadLevel's order (bank_00.asm:2644-2657): the header loader, the layer position copy
    // (2645-2649), [UploadLevelMusic, not modelled], CODE_00A635 (the per-level timers and Mario's
    // entrance state), the screen setup (2652-2656, ending in UpdateScreenPosition), then CODE_05801E.
    // That one ends with PLP, RTL; it saves its own DB use via the JSL caller.
    const bad =
      prologue() ??
      run('level pointer loader', e.pointer, 'jsl', e.pointer >> 16, [e.pointer >> 16]) ??
      span('layer position copy', ...GM11_SPANS.layerCopy) ??
      run('Mario entrance setup', e.entrance, 'jsr', 0x00) ??
      span('screen position setup', ...GM11_SPANS.screenSetup) ??
      run('level data loader', e.data, 'jsl', e.dataBank)
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
