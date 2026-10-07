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
 * (CODE_05801E, bank_05.asm:19-70: header parse CODE_0584E3, called at line
 * 428, for $5B/$5D/$64; tileset slope pointer CODE_0581FB, line 253; then every
 * object of Layer 1 expanded into the Map16 tables at $7E:C800/$7F:C800).
 * Hardware registers are the bus stubs; nothing is read from an emulator capture.
 *
 * The fixed entries and the GM11 spans between them are byte-checked, including the bytes that lead into
 * the mid-routine entry (an entry that exists is not an entry that is reached),
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
import type { RomFile } from '../../RomFile'
import { bytesAt, mapperProblem, shapeMatches } from './Guards'
import { smwMachine } from './Machine'
import { withSeed, type SeedOverride, type SpriteSeed } from './SpriteSeed'

/**
 * Instruction cap for the whole load (all five steps). The loader runs on the
 * Theia RPC thread (map-sprites.ts), so a ROM that passes the shapes and loops
 * must be refused quickly. Vanilla's worst level over all 512 level numbers is
 * 276,655 steps (one machine, 2026-10-06), so this is ~7x headroom.
 */
export const LOADER_TOTAL_CAP = 2_000_000

export type LevelLoad =
  { ok: true; wram: Uint8Array; steps: number } | { ok: false; reason: string }

/** The vanilla shapes the loader relies on; `null` matches any byte. */
const SHAPES: { name: string; at: number; want: (number | null)[] }[] = [
  // GM11LoadLevel's three calls, in the order the loader makes them (bank_00.asm:2644, 2651, 2657).
  { name: 'GM11 call JSL CODE_05D796 at $00:96F4', at: 0x0096f4, want: [0x22, 0x96, 0xd7, null] },
  // What GM11 runs between those calls (bank_00.asm:2645-2656): the layer-position copy loop, then
  // (after the music upload, which is not modelled) the screen setup. The loader runs both spans
  // from the ROM's bytes. A hook inserted there (Seven Vanilla Levels has a JSL at $00:9708) is
  // code a sequence that skipped it would miss.
  { name: 'GM11 layer position copy at $00:96F8', at: 0x0096f8, want: [0xa2, 0x07, 0xb5, 0x1a, 0x9d, 0x62, 0x14, 0xca, 0x10, 0xf8] }, // prettier-ignore
  { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: 0x009708, want: [0xa9, 0x20, 0x85, 0x5e, 0x20, 0x96, 0xa7, 0xee, 0x04, 0x14, 0x22, 0xdb, 0xf6, 0x00] }, // prettier-ignore
  // CODE_00A796 and UpdateScreenPosition are called from that span (bank_00.asm:5089, 13631).
  { name: 'Layer 2 scroll setup at $00:A796', at: 0x00a796, want: [0xc2, 0x20, 0xac, null, null, 0xf0, null, 0x88, 0xd0] }, // prettier-ignore
  { name: 'UpdateScreenPosition at $00:F6DB', at: 0x00f6db, want: [0x8b, 0x4b, 0xab, 0xc2, 0x20, 0xad, null, null, 0x38, 0xe9, 0x0c, 0x00] }, // prettier-ignore
  { name: 'GM11 call JSR CODE_00A635 at $00:9705', at: 0x009705, want: [0x20, 0x35, 0xa6] },
  { name: 'GM11 call JSL CODE_05801E at $00:9716', at: 0x009716, want: [0x22, 0x1e, 0x80, null] },
  // CODE_05D796: PHB PHK PLB SEP #$30 STZ / LDA / BNE / LDY / BEQ / JSR / LDA SublevelCount / BNE +3 / JMP CODE_05D83E
  // (bank_05.asm:7079-7093). The loader models the SUBLEVEL branch (it sets $141A), which falls through to
  // the JMP at $05:D83B, so the bytes of that branch are checked, not the overworld lead-in.
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796, want: [0x8b, 0x4b, 0xab, 0xe2, 0x30, 0x9c, null, null, 0xad, null, null, 0xd0, 0x05, 0xac, null, null, 0xf0, 0x03, 0x20, null, null, 0xad, 0x1a, 0x14, 0xd0, 0x03, 0x4c, 0x3e, 0xd8] }, // prettier-ignore
  // The sublevel branch ends in JMP CODE_05D8B7 (bank_05.asm:7162).
  { name: 'jump into the pointer loader at $05:D83B', at: 0x05d83b, want: [0x4c, 0xb7, 0xd8] },
  // CODE_05D8B7: REP #$30 / LDA $0E / ASL / CLC / ADC $0E / TAY
  { name: 'pointer loader at $05:D8B7', at: 0x05d8b7, want: [0xc2, 0x30, 0xa5, 0x0e, 0x0a, 0x18, 0x65, 0x0e, 0xa8] }, // prettier-ignore
  // CODE_00A635: LDA BluePSwitchTimer / ORA SilverPSwitchTimer / ORA DirectCoinTimer / BNE / LDA
  { name: 'Mario entrance setup at $00:A635', at: 0x00a635, want: [0xad, 0xad, 0x14, 0x0d, 0xae, 0x14, 0x0d, 0x0c, 0x19, 0xd0, 0x0a, 0xad] }, // prettier-ignore
  // CODE_05801E: PHP / SEP #$20 / REP #$10 / LDX #0 / LDA #$25 / STA long
  { name: 'level data loader at $05:801E', at: 0x05801e, want: [0x08, 0xe2, 0x20, 0xc2, 0x10, 0xa2, 0x00, 0x00, 0xa9, 0x25, 0x9f, 0x00] }, // prettier-ignore
]

/** The first loader entry whose bytes differ from the shape this loader knows, or null. */
export function loaderShapeProblem(rom: RomFile): string | null {
  const mapper = mapperProblem(rom)
  if (mapper) return mapper
  for (const s of SHAPES)
    if (!shapeMatches(bytesAt(rom, s.at, s.want.length), s.want))
      return `${s.name} is not the vanilla shape; the loader will not run it`
  return null
}

/**
 * The 128 KB WRAM after the ROM has loaded `level` (the 9-bit level number, e.g.
 * 0x105). RNGCalc ($148B/C) is left zero here; the runner derives it by running
 * the ROM's GetRand (see SpriteRunner.ts).
 */
export function loadLevelState(rom: RomFile, level: number): LevelLoad {
  const problem = loaderShapeProblem(rom)
  if (problem) return { ok: false, reason: problem }
  const { bus, cpu } = smwMachine(rom)
  const w = bus.wram
  // SublevelCount ($141A) nonzero is a sublevel entry: it skips the
  // overworld-only intro branches that would overwrite the sprite memory setting.
  w[0x141a] = 1
  w[0x0e] = level & 0xff
  w[0x0f] = (level >> 8) & 0xff
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
      return runUntil(cpu, room, k => k.pb === 0 && k.pc === to)
    })
  try {
    // CODE_05D8B7 is entered mid-routine, after CODE_05D796's PHB; its PLB needs that byte.
    // GM11LoadLevel's order (bank_00.asm:2644-2657): the header loader, the layer position copy
    // (2645-2649, $1A-$21 to $1462-$1469), [UploadLevelMusic, not modelled], CODE_00A635 (clears
    // the per-level timers, sets Mario's entrance state $71/$76 from the entrance type just
    // read), then 2652-2656 ($5E = $20, CODE_00A796, $1404++, UpdateScreenPosition: $1E/$20
    // layer 2 positions, camera buffers), then CODE_05801E. That one ends with PLP, RTL; it
    // saves its own DB use via the JSL caller.
    const bad =
      run('level pointer loader', 0x05d8b7, 'jsl', 0x05, [0x05]) ??
      span('layer position copy', 0x0096f8, 0x009702) ??
      run('Mario entrance setup', 0x00a635, 'jsr', 0x00) ??
      span('screen position setup', 0x009708, 0x009716) ??
      run('level data loader', 0x05801e, 'jsl', 0x05)
    if (bad) return { ok: false, reason: bad }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
  return { ok: true, wram: w, steps }
}

/**
 * A seed for `level` with the ROM-run level state when the loader accepts the
 * ROM, else a generic seed that records why in `loadRefusal` (the model then
 * reports `seedSource: 'generic'` with that reason).
 */
export function levelSeed(rom: RomFile, level: number, over: SeedOverride = {}): SpriteSeed {
  const l = loadLevelState(rom, level)
  return withSeed(l.ok ? { ...over, loaded: l.wram } : { ...over, loadRefusal: l.reason })
}
