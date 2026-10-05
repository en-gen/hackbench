/**
 * LevelLoader.ts -- the level state a sprite reads, produced by running the
 * ROM's OWN level loader on the core instead of copying it from anywhere.
 *
 * Sequence (each step the game's own code): put the level number in $0E/$0F,
 * run the pointer and sprite-header loader (CODE_05D8B7, SMWDisX
 * bank_05.asm:7227, entered mid-routine: it ends in the RTL of CODE_05D796;
 * Layer 1/2 data pointers, sprite memory $1692, buoyancy $190E), then Mario's
 * entrance setup (CODE_00A635, bank_00.asm:4913), then the level-data loader
 * (CODE_05801E, bank_05.asm:19-70: header parse CODE_0584E3, called at line
 * 428, for $5B/$5D/$64; tileset slope pointer CODE_0581FB, line 253; then every
 * object of Layer 1 expanded into the Map16 tables at $7E:C800/$7F:C800).
 * Hardware registers are the bus stubs; nothing is read from an emulator capture.
 *
 * The four fixed entries are byte-checked, including the bytes that lead into
 * the mid-routine entry (an entry that exists is not an entry that is reached),
 * and the run is guarded like the sprite runner's (no BRK/COP, no leaving ROM).
 * A ROM that differs, as the corpus hacks do, is refused with a reason rather
 * than run on a guess; the caller then has no loaded image.
 *
 * Evidence scope: vanilla, one level at a time; exercised by the grader in
 * test/suite/unit/sprites/spriteGrade.captures.test.ts.
 */
import { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
import { bytesAt, guardInstruction, Refusal, shapeMatches } from './Guards'
import { SpriteBus } from './SpriteBus'

const BUDGET = 5_000_000
const SENTINEL = 0xff00

export type LevelLoad =
  { ok: true; wram: Uint8Array; steps: number } | { ok: false; reason: string }

/** Runs a routine to its return on `cpu`; false when the step budget ran out. */
function call(
  cpu: Cpu65816,
  bus: SpriteBus,
  entry: number,
  kind: 'jsr' | 'jsl',
  phb = false,
): number {
  const push = (v: number) => {
    bus.write(cpu.s, v)
    cpu.s = (cpu.s - 1) & 0xffff
  }
  // CODE_05D8B7 is entered mid-routine, after CODE_05D796's PHB; its PLB needs that byte.
  const s0 = cpu.s
  if (kind === 'jsl') push(0x00)
  push((SENTINEL - 1) >> 8)
  push((SENTINEL - 1) & 0xff)
  if (phb) push(cpu.db)
  cpu.pb = entry >>> 16
  cpu.pc = entry & 0xffff
  for (let i = 0; i < BUDGET; i++) {
    cpu.step()
    if (cpu.s === s0 && cpu.pc === SENTINEL) return i
  }
  return -1
}

/** The vanilla shapes the loader relies on; `null` matches any byte. */
const SHAPES: { name: string; at: number; want: (number | null)[] }[] = [
  // CODE_05D8A2 tail: LDA OWPlayerSubmap,Y / BEQ +2 / LDA #1 / STA $0F, the bytes that fall into the entry.
  { name: 'level number lead-in at $05:D8AE', at: 0x05d8ae, want: [0xb9, null, null, 0xf0, 0x02, 0xa9, 0x01, 0x85, 0x0f] }, // prettier-ignore
  // CODE_05D8B7: REP #$30 / LDA $0E / ASL / CLC / ADC $0E / TAY
  { name: 'pointer loader at $05:D8B7', at: 0x05d8b7, want: [0xc2, 0x30, 0xa5, 0x0e, 0x0a, 0x18, 0x65, 0x0e, 0xa8] }, // prettier-ignore
  // CODE_00A635: LDA BluePSwitchTimer / ORA SilverPSwitchTimer / ORA DirectCoinTimer / BNE / LDA
  { name: 'Mario entrance setup at $00:A635', at: 0x00a635, want: [0xad, 0xad, 0x14, 0x0d, 0xae, 0x14, 0x0d, 0x0c, 0x19, 0xd0, 0x0a, 0xad] }, // prettier-ignore
  // CODE_05801E: PHP / SEP #$20 / REP #$10 / LDX #0 / LDA #$25 / STA long
  { name: 'level data loader at $05:801E', at: 0x05801e, want: [0x08, 0xe2, 0x20, 0xc2, 0x10, 0xa2, 0x00, 0x00, 0xa9, 0x25, 0x9f, 0x00] }, // prettier-ignore
]

/** The first loader entry whose bytes differ from the shape this loader knows, or null. */
export function loaderShapeProblem(rom: RomFile): string | null {
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
  const bus = new SpriteBus(rom)
  bus.onInstruction = guardInstruction
  const cpu = new Cpu65816(bus)
  cpu.e = false
  cpu.p = 0x34
  cpu.s = 0x1ff
  const w = bus.wram
  // SublevelCount ($141A) nonzero is a sublevel entry: it skips the
  // overworld-only intro branches that would overwrite the sprite memory setting.
  w[0x141a] = 1
  w[0x0e] = level & 0xff
  w[0x0f] = (level >> 8) & 0xff
  let steps = 0
  try {
    cpu.db = 0x05
    let n = call(cpu, bus, 0x05d8b7, 'jsl', true)
    if (n < 0) return { ok: false, reason: 'level pointer loader did not return' }
    steps += n
    // GM11 (bank_00.asm:2636-2657) runs CODE_00A635 between the two: it clears
    // the per-level timers and sets Mario's entrance state ($71, $76) from the
    // entrance type the header loader just read.
    cpu.db = 0x00
    n = call(cpu, bus, 0x00a635, 'jsr')
    if (n < 0) return { ok: false, reason: 'Mario entrance setup did not return' }
    steps += n
    // CODE_05801E ends with PLP, RTL; it saves its own DB use via the JSL caller.
    cpu.db = 0x05
    n = call(cpu, bus, 0x05801e, 'jsl')
    if (n < 0) return { ok: false, reason: 'level data loader did not return' }
    steps += n
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
  return { ok: true, wram: w, steps }
}
