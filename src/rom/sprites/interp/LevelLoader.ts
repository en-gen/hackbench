/**
 * LevelLoader.ts -- the level state a sprite reads, produced by running the
 * ROM's OWN level loader on the core instead of copying it from anywhere.
 *
 * Sequence (each step the game's own code, bank $05): put the level number in
 * $0E/$0F, run the pointer and sprite-header loader (CODE_05D8B7, SMWDisX
 * bank_05.asm:7227, which ends in the RTL of CODE_05D796: Layer 1/2 data pointers, sprite memory $1692, buoyancy
 * $190E), then the level-data loader (CODE_05801E, bank_05.asm:19-70: header
 * parse CODE_0584E3 for $5B/$5D/$64, tileset slope pointer CODE_0581FB, then
 * every object of Layer 1 expanded into the Map16 tables at $7E:C800/$7F:C800).
 * A hack that edits any of this is read as edited. Hardware registers are the
 * bus stubs; nothing is read from an emulator capture.
 *
 * Evidence scope: vanilla, one level at a time; exercised by the grader in
 * test/suite/unit/sprites/spriteGrade.captures.test.ts.
 */
import { Cpu65816 } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'
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

/**
 * The 128 KB WRAM after the ROM has loaded `level` (the 9-bit level number, e.g.
 * 0x105). `rngSeed` is the pair the game's reset code leaves in $148B/$148C.
 */
export function loadLevelState(rom: RomFile, level: number): LevelLoad {
  const bus = new SpriteBus(rom)
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
    return { ok: false, reason: String(e instanceof Error ? e.message : e) }
  }
  return { ok: true, wram: w, steps }
}
