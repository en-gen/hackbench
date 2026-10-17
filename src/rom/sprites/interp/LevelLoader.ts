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
 * object of Layer 1 expanded into the Map16 tables at $7E:C800/$7F:C800), then GM12PrepLevel's
 * Layer 3 handler (CODE_009FB8, bank_00.asm:4870; skipped when IRQNMICommand bit 7 is set,
 * bank_00.asm:4861-4864): the tide's $5B bit 7 and buffer clear (#842, #845).
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
 * Instruction cap for the whole load (all seven steps). The loader runs on the
 * Theia RPC thread (map-sprites.ts), so a ROM that passes the shapes and loops
 * must be refused quickly. Vanilla's worst level over all 512 slots is
 * 276,894 steps (slot $11A) with the Layer 3 reset and handler (276,864 before them; max over slots 0-511, one run, 2026-10-07 and the review of #842), so this is ~7x headroom.
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
  // LDA CameraMoveTrigger ($142A): exact, as the corpus holds only `2a 14` (and `2a 74`, all on SA-1
  // ROMs, which the mapper check refuses first).
  { name: 'UpdateScreenPosition at $00:F6DB (to the hook site at $F6E4)', at: 0x00f6db, want: [0x8b, 0x4b, 0xab, 0xc2, 0x20, 0xad, 0x2a, 0x14, 0x38] }, // prettier-ignore
  { name: 'GM11 call JSR CODE_00A635 at $00:9705', at: 0x009705, want: [0x20, 0x35, 0xa6] },
  { name: 'GM11 call JSL CODE_05801E at $00:9716', at: 0x009716, want: [0x22, 0x1e, 0x80, null] },
  // CODE_05D796: PHB PHK PLB SEP #$30 STZ / LDA / BNE / LDY / BEQ / JSR / LDA SublevelCount / BNE +3 / JMP CODE_05D83E
  // (bank_05.asm:7079-7093). The loader models the SUBLEVEL branch (it sets $141A), which falls through to
  // the JMP at $05:D83B, so the bytes of that branch are checked, not the overworld lead-in.
  { name: 'CODE_05D796 prologue and sublevel branch at $05:D796', at: 0x05d796, want: [0x8b, 0x4b, 0xab, 0xe2, 0x30, 0x9c, null, null, 0xad, null, null, 0xd0, 0x05, 0xac, null, null, 0xf0, 0x03, 0x20, null, null, 0xad, 0x1a, 0x14, 0xd0, 0x03, 0x4c, 0x3e, 0xd8] }, // prettier-ignore
  // The sublevel branch ends in JMP CODE_05D8B7 (bank_05.asm:7162).
  { name: 'jump into the pointer loader at $05:D83B', at: 0x05d83b, want: [0x4c, 0xb7, 0xd8] },
  // CODE_00A635: LDA BluePSwitchTimer / ORA SilverPSwitchTimer / ORA DirectCoinTimer / BNE / LDA
  { name: 'Mario entrance setup at $00:A635', at: 0x00a635, want: [0xad, 0xad, 0x14, 0x0d, 0xae, 0x14, 0x0d, 0x0c, 0x19, 0xd0, 0x0a, 0xad] }, // prettier-ignore
  // CODE_009FB8 (Layer 3 handler): LDA ObjectTileset / ASL / CLC / ADC ObjectTileset (bank_00.asm:4139-4143)
  {
    name: 'Layer 3 handler at $00:9FB8',
    at: 0x009fb8,
    want: [0xad, null, null, 0x0a, 0x18, 0x6d, null, null],
  },
]

/**
 * Spans the loader pins by fingerprint, not by literal bytes, so the source carries no game code (the scheme of
 * SubmapFlagGate.ts: SHA-256 of the span with the offsets in `mask` zeroed). `key` is the badLoader option of
 * the synthetic cart that plants a defect in the span. The SHAPES above hold the bytes that predate this.
 * - pointers: CODE_05D8B7's first nine bytes (bank_05.asm:7227).
 * - data: CODE_05801E's first twelve (bank_05.asm:19-70).
 * - reset: CODE_05BE8A whole (bank_05.asm:4784-4798): the Layer 3 scroll reset and Layer3YPos = Layer1YPos; the
 *   scroll-variable operands are masked, the two direct-page ones ($1C, $24) are in the hash.
 * - gm12: GM12PrepLevel's call site of the Layer 3 handler (bank_00.asm:4861-4870): LDA IRQNMICommand / BPL /
 *   JSR / BRA, then three calls ending in a JSL and the JSR CODE_009FB8 the loader makes. The call operands
 *   are masked (the JSL operand differs on Lunar Magic ROMs); the BPL and the handler's JSR target are in the
 *   hash, which is what makes the loader's mirror of the bit 7 test safe.
 */
interface Span {
  key: string
  name: string
  at: number
  length: number
  mask: readonly number[]
  fingerprints: readonly string[]
}
const SPANS: readonly Span[] = [
  { key: 'pointers', name: 'pointer loader at $05:D8B7', at: 0x05d8b7, length: 9, mask: [], fingerprints: ['6dccdd0c17609d04d1b9792f97a91199c2c69803d896b91501ea7189458a4b68'] },
  { key: 'data', name: 'level data loader at $05:801E', at: 0x05801e, length: 12, mask: [], fingerprints: ['4bc3f7d7f403b10d0ae7fa24c85a8b34e0ff53e001573a5d0926bc499a7c0510'] },
  { key: 'reset', name: 'Layer 3 reset at $05:BE8A', at: 0x05be8a, length: 28, mask: [6, 7, 9, 10, 12, 13, 15, 16, 18, 19], fingerprints: ['41453d6b75b4fe5ab096dcf23b132787b0103b35c0d5a758afcc1d67bc254f1d'] },
  { key: 'gm12', name: 'GM12PrepLevel call site of the Layer 3 handler at $00:A5AF', at: 0x00a5af, length: 23, mask: [11, 12, 14, 15, 17, 18, 19], fingerprints: ['f0b04d810d12baa061c4a56562b866f7accc91e3788f1ff1f0f77d74f724f877'] },
] // prettier-ignore

const spanPrint = (rom: RomFile, s: Span): string | null => {
  const b = bytesAt(rom, s.at, s.length)
  return spanFingerprint(b && Uint8Array.from(b), s.mask)
}

/**
 * TEST SEAM, for synthetic ROM builders only. Vouches for the fingerprinted spans of THIS `rom` instance as
 * built (a hand-written cart cannot match the game's fingerprints), except the spans named in `except` (the
 * ones a mutant planted a defect in). A span is accepted only while its bytes still hash to the vouched value,
 * so a byte written into a checked offset afterwards is refused. A ROM read from disk is never in the map.
 */
const vouched = new WeakMap<RomFile, Map<string, string>>()
export function markSyntheticRom(rom: RomFile, except: readonly string[] = []): void {
  const m = new Map<string, string>()
  for (const s of SPANS) {
    const fp = except.includes(s.key) ? null : spanPrint(rom, s)
    if (fp) m.set(s.key, fp)
  }
  vouched.set(rom, m)
}

/** The first loader entry whose bytes differ from the shape this loader knows, or null. */
export function loaderShapeProblem(rom: RomFile): string | null {
  const mapper = mapperProblem(rom)
  if (mapper) return mapper
  for (const s of SHAPES)
    if (!shapeMatches(bytesAt(rom, s.at, s.want.length), s.want))
      return `${s.name} is not the vanilla shape; the loader will not run it`
  for (const sp of SPANS) {
    const fp = spanPrint(rom, sp)
    if (fp === null || !(sp.fingerprints.includes(fp) || vouched.get(rom)?.get(sp.key) === fp))
      return `${sp.name} is not the vanilla shape; the loader will not run it`
  }
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
    // saves its own DB use via the JSL caller. GM12PrepLevel then runs the Layer 3 handler
    // (CODE_009FB8, bank_00.asm:4870): on a tide level it sets ScreenMode bit 7, Layer3YPos and the
    // $26/$28 offset, which CODE_019140's second pass reads as liquid (#842). The game skips it when
    // IRQNMICommand ($0D9B, set from SpecialLevTable by the header loader, bank_05.asm:500-503, 551)
    // has bit 7 (bank_00.asm:4861-4863 branches to CODE_0097BC instead). That is by mode, not by level
    // list: 24 vanilla maps end with it set (modes 9, $B and $10; docs/sprites/sprite-a4-floating-spike-ball.md),
    // so the loader tests the same cell. The same branch skips CODE_05BE8A (bank_00.asm:4869), which copies
    // Layer1YPos into Layer3YPos (bank_05.asm:4794-4795) just before the handler; on the maps where the handler
    // writes nothing (011, 130, 1c1) that copy is all that sets $24.
    const bad =
      run('level pointer loader', 0x05d8b7, 'jsl', 0x05, [0x05]) ??
      span('layer position copy', 0x0096f8, 0x009702) ??
      run('Mario entrance setup', 0x00a635, 'jsr', 0x00) ??
      span('screen position setup', 0x009708, 0x009716) ??
      run('level data loader', 0x05801e, 'jsl', 0x05) ??
      (w[0x0d9b] & 0x80
        ? null
        : (run('Layer 3 reset', 0x05be8a, 'jsl', 0x05) ??
          run('Layer 3 handler', 0x009fb8, 'jsr', 0x00)))
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
