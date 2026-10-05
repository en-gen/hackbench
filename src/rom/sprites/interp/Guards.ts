/**
 * Guards.ts -- what stops a run that has left the code the runner understands.
 * Shared by the sprite runner and the level loader so neither can wander: an
 * opcode the core cannot meaningfully run (BRK, COP, WDM, STP) or an instruction
 * fetched from outside cart ROM (WRAM, registers, open bus) ends the run with a
 * reason, never a guess.
 */

/** Thrown to stop a run; the message is the refusal reason shown to the user. */
export class Refusal extends Error {}

const REFUSED_OPS: Record<number, string> = { 0x00: 'BRK', 0x02: 'COP', 0x42: 'WDM', 0xdb: 'STP' }
const hex = (n: number): string => n.toString(16).toUpperCase().padStart(6, '0')

/** Bus `onInstruction` hook: throws `Refusal` for a refused opcode or a fetch outside ROM. */
export function guardInstruction(addr: number, op: number): void {
  const bank = addr >>> 16
  const lo = addr & 0xffff
  if (bank === 0x7e || bank === 0x7f || ((bank & 0x7f) < 0x40 && lo < 0x8000))
    throw new Refusal(`execution left ROM code at $${hex(addr)}`)
  if (REFUSED_OPS[op]) throw new Refusal(`${REFUSED_OPS[op]} executed at $${hex(addr)}`)
}

/** Reads `n` bytes at a SNES address as numbers, or null when unmapped. */
export function bytesAt(
  rom: { readAt(a: number, n: number): Uint8Array | null },
  a: number,
  n: number,
): number[] | null {
  // prettier-ignore
  const b = rom.readAt(a, n)
  return b ? [...b] : null
}

/** True when `got` has every `want` byte; null in `want` matches anything. */
export function shapeMatches(got: number[] | null, want: (number | null)[]): boolean {
  return !!got && want.every((w, i) => w === null || got[i] === w)
}
