/**
 * Guards.ts -- what stops a run that has left the code the runner understands.
 * Shared by the sprite runner and the level loader so neither can wander: an
 * opcode the core cannot meaningfully run (BRK, COP, WDM, WAI, STP) or an instruction
 * fetched from outside cart ROM (WRAM, registers, open bus) ends the run with a
 * reason, never a guess.
 */
import type { RomFile } from '../../RomFile'
import { romByte } from './SpriteBus'

const REFUSED_OPS: Record<number, string> = { 0x00: 'BRK', 0x02: 'COP', 0x42: 'WDM', 0xcb: 'WAI', 0xdb: 'STP' } // prettier-ignore

/** The mnemonic of an opcode the core cannot meaningfully run here, or undefined. WAI halts until an interrupt that never comes. */
export const refusedOp = (op: number): string | undefined => REFUSED_OPS[op]

/** Why a HiROM-flagged ROM is not run, or null: the bus is LoROM only. */
export function mapperProblem(rom: Pick<RomFile, 'mapMode'>): string | null {
  return rom.mapMode === 'hirom'
    ? 'the ROM header says HiROM; the interpreter runs LoROM only'
    : null
}

/** Reads `n` bytes at a SNES address as the BUS would (LoROM, mirrored), or null when any is not cart ROM. */
export function bytesAt(rom: RomFile, a: number, n: number): number[] | null {
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const b = romByte(rom, a + i)
    if (b === null) return null
    out.push(b)
  }
  return out
}

/** True when `got` has every `want` byte; null in `want` matches anything. */
export function shapeMatches(got: number[] | null, want: (number | null)[]): boolean {
  return !!got && want.every((w, i) => w === null || got[i] === w)
}
