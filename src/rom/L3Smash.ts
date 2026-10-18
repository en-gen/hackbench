/**
 * Where a Layer 3 Smash sprite ($89) first puts layer 3 on a map (#807, #997): worked out by running
 * the ROM's own level loader, start-up sweep and sprite loop (sprites/interp/SmashLanding.ts), so the
 * position is whatever the code gives from the power-on RNG, not a stored number. Settings byte $80
 * (CODE_00A007, bank_00.asm:4184-4195) leaves Layer3YPos at $D0 until the smasher's main writes both
 * cells every frame (Layer3SmashMain, bank_02.asm:11123-11124 -> CODE_00FF61, bank_00.asm:14778-14803).
 * A map with no smasher in the loaded sprites keeps $D0 and X 0 (`pos` null). A step that cannot run
 * refuses with its reason, and the map view then draws no layer 3 there, with that reason.
 */
import { firstLanding, type LandingResult } from './sprites/interp/SmashLanding'
import type { RomFile } from './RomFile'

export interface L3Position {
  x: number
  y: number
}
export type L3SmashResult = { ok: true; pos: L3Position | null } | { ok: false; reason: string }

/** Layer 3's first-landing position on `levelId`, or null when it has no loaded smasher. */
export function readL3SmashLoadPos(
  rom: RomFile,
  levelId: number,
  landing: (rom: RomFile, map: number) => LandingResult = firstLanding,
): L3SmashResult {
  const r = landing(rom, levelId)
  return r.ok ? { ok: true, pos: r.landing } : r
}
