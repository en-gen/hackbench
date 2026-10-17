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
import type { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { spanFingerprint } from '../../SubmapFlagGate'
import { bytesAt, mapperProblem, shapeMatches } from './Guards'
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

/** The vanilla call sites the loader relies on, short enough to state; `null` matches any byte. */
const SHAPES: { name: string; at: number; want: (number | null)[] }[] = [
  // GM11LoadLevel's three calls, in the order the loader makes them (bank_00.asm:2644, 2651, 2657).
  { name: 'GM11 call JSL CODE_05D796 at $00:96F4', at: 0x0096f4, want: [0x22, 0x96, 0xd7, null] },
  { name: 'GM11 call JSR CODE_00A635 at $00:9705', at: 0x009705, want: [0x20, 0x35, 0xa6] },
  { name: 'GM11 call JSL CODE_05801E at $00:9716', at: 0x009716, want: [0x22, 0x1e, 0x80, null] },
  // The sublevel branch ends in JMP CODE_05D8B7 (bank_05.asm:7162).
  { name: 'jump into the pointer loader at $05:D83B', at: 0x05d83b, want: [0x4c, 0xb7, 0xd8] },
]

/**
 * A loader span recognised by SHA-256 (`spanFingerprint`, the way SubmapFlagGate and L3CodeGate do it),
 * so the commit holds no ROM bytes: `length` bytes at `at` with the `mask` offsets zeroed (operands
 * a hack legitimately relocates). A span whose bytes hash differently is refused by `name`.
 * Measured on the vanilla US ROM (SHA-1 6b47bb75); the 512-level digest test pins that the loader's
 * output is unchanged from the byte-literal shapes these replace. A new span is added the same way:
 * hash the vanilla bytes, copy the digest here, add a synthetic stand-in beside the others.
 */
export interface LoaderSpan {
  name: string
  at: number
  length: number
  mask: readonly number[]
  sha: string
}

// Merging with #1050: whichever lands second converts its 9FB8 (8 B) and A5AF (23 B) shapes to spans here,
// hand-writes their stand-ins (syntheticLoaderSpans.ts STAND_IN_LENGTH), ports its loader tails, and re-pins
// VANILLA_ALL_LEVELS and PTR/ENT.
// prettier-ignore
export const LOADER_SPANS: readonly LoaderSpan[] = [
  // bank_00.asm:2645-2649: the layer-position copy loop; a hook inserted after it (Seven Vanilla Levels has
  // a JSL at $00:9708) is code a sequence that skipped it would miss.
  { name: 'GM11 layer position copy at $00:96F8', at: 0x0096f8, length: 10, mask: [], sha: 'cdd61fac211b404c6ef6854f60c3ed0a1eb071bd0a759896406b0fd0f4c15478' },
  // bank_00.asm:2652-2656, after the unmodelled music upload: the screen setup.
  { name: 'GM11 code between the entrance setup and the level data call at $00:9708', at: 0x009708, length: 14, mask: [], sha: 'b2ef31ed0dfcc10661bcf424e34a706089c715bfddbe66f4c052bc11938b5450' },
  // CODE_00A796 (bank_00.asm:5089), with its three operand bytes zeroed.
  { name: 'Layer 2 scroll setup at $00:A796', at: 0x00a796, length: 9, mask: [3, 4, 6], sha: 'b09b77d01726e12ac2f990c1f1455eef8d6ab0eaa1d28ce8132c6432e940b1f1' },
  // UpdateScreenPosition up to its hook site at $F6E4 (bank_00.asm:13631); the CameraMoveTrigger operand ($142A) is hashed.
  { name: 'UpdateScreenPosition at $00:F6DB (to the hook site at $F6E4)', at: 0x00f6db, length: 9, mask: [], sha: '92c7efb5c8facedfcded763753c47c31782afeb1dcc0560b54d7414142030e15' },
  // CODE_05D796's prologue and the SUBLEVEL branch the loader models (bank_05.asm:7079-7093).
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796, length: 29, mask: [6, 7, 9, 10, 14, 15, 19, 20], sha: '179af606edd3e896c3ff2ccfd63861b9548b3f62e2de481ff051d65ef867dca4' },
  // CODE_05D8B7, the pointer loader's opening (bank_05.asm:7227).
  { name: 'pointer loader at $05:D8B7', at: 0x05d8b7, length: 9, mask: [], sha: '6dccdd0c17609d04d1b9792f97a91199c2c69803d896b91501ea7189458a4b68' },
  // CODE_00A635, Mario's entrance setup (bank_00.asm:4913).
  { name: 'Mario entrance setup at $00:A635', at: 0x00a635, length: 12, mask: [], sha: '8f312beb45fb80e0889d9fa4914316905853c26341ea3fba1a6d44b34d13924e' },
  // CODE_05801E, the level data loader's opening (bank_05.asm:20).
  { name: 'level data loader at $05:801E', at: 0x05801e, length: 12, mask: [], sha: '4bc3f7d7f403b10d0ae7fa24c85a8b34e0ff53e001573a5d0926bc499a7c0510' },
]

const synthetic: LoaderSpan[] = []

/**
 * Tests only: a synthetic cart's loader routines are hand-written, so their fingerprints are accepted
 * IN ADDITION to the vanilla ones, by span name. By content, so a patched copy of the cart is still
 * accepted where its span is unchanged. Nothing under src/ calls this
 * (test/suite/unit/sprites/levelLoaderFingerprint.test.ts), so a shipped build accepts vanilla only.
 */
export function acceptLoaderSpans(spans: readonly LoaderSpan[]): void {
  for (const s of spans)
    if (!synthetic.some(t => t.name === s.name && t.sha === s.sha)) synthetic.push(s)
}

/**
 * The first loader entry whose bytes differ from what this loader knows, or null. `spans` replaces
 * the fingerprints checked (a test of the check itself); by default LOADER_SPANS and, in a test
 * that registered one, a synthetic cart's.
 */
export function loaderShapeProblem(rom: RomFile, spans?: readonly LoaderSpan[]): string | null {
  const mapper = mapperProblem(rom)
  if (mapper) return mapper
  const refuse = (name: string) => `${name} is not the vanilla shape; the loader will not run it`
  for (const s of SHAPES)
    if (!shapeMatches(bytesAt(rom, s.at, s.want.length), s.want)) return refuse(s.name)
  for (const s of spans ?? LOADER_SPANS) {
    const known = spans ? [s] : [s, ...synthetic.filter(t => t.name === s.name)]
    const hit = known.some(k => {
      const b = bytesAt(rom, k.at, k.length)
      return !!b && spanFingerprint(Uint8Array.from(b), k.mask) === k.sha
    })
    if (!hit) return refuse(s.name)
  }
  return null
}

/**
 * The 128 KB WRAM after the ROM has loaded `level` (the 9-bit level number, e.g.
 * 0x105). RNGCalc ($148B/C) is left zero here; the runner derives it by running
 * the ROM's GetRand (see SpriteRunner.ts).
 */
export function loadLevelState(
  rom: RomFile,
  level: number,
  spans?: readonly LoaderSpan[],
): LevelLoad {
  const problem = loaderShapeProblem(rom, spans)
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
