import type { RomFile } from './RomFile'
import { findSecondaryEntranceForLevel } from './L3Loader'

// Table addresses, bank_05.asm:7302-7316 (primary) and 7120-7158 (secondary).
const F000 = 0x05f000 // primary Y index (low nibble)
const F200 = 0x05f200 // primary X index (low 3 bits)
const F600 = 0x05f600 // bits 4:0 entrance screen, bit 5 vertical
const FA00 = 0x05fa00 // secondary Y index (low nibble)
const FC00 = 0x05fc00 // secondary X index (bits 7:5), entrance screen (bits 4:0)
const Y_LO = 0x05d730
const Y_HI = 0x05d740
const X_LO = 0x05d750
const X_HI = 0x05d758

/**
 * Mario's start position in a map, the entrance's SCREEN included.
 *
 * The loader's tail (bank_05.asm:7375-7387) puts the screen number, DATA_05F600[map] & $1F
 * for a primary entrance or DATA_05FC00[entrance] & $1F for a secondary one, into the high
 * byte of X on a horizontal map and of Y on a vertical map (the other axis keeps its
 * DATA_05D740/05D758 high byte). Leaving the screen out put Mario on screen 0 (#781).
 * Vertical is DATA_05F600[map] bit 5 (bank_05.asm:7292-7299).
 *
 * A map $100+ uses the secondary entrance that targets it, as the game does; one no entrance
 * targets falls back to its primary bytes. No stock-code gate: this is the fallback for a ROM
 * whose loader the interpreter refuses, and its caller draws such results as unverified.
 */
export function readMarioStartPos(rom: RomFile, levelId: number): { x: number; y: number } {
  const b = (a: number): number => rom.readByte(a) ?? 0
  let yByte = b(F000 + levelId)
  let xIdx = b(F200 + levelId) & 0x07
  let screen = b(F600 + levelId) & 0x1f
  if (levelId >= 0x100) {
    const e = findSecondaryEntranceForLevel(rom, levelId)
    if (e !== null) {
      yByte = b(FA00 + e)
      xIdx = (b(FC00 + e) >> 5) & 0x07
      screen = b(FC00 + e) & 0x1f
    }
  }
  const yIdx = yByte & 0x0f
  let x = (b(X_HI + xIdx) << 8) | b(X_LO + xIdx)
  let y = (b(Y_HI + yIdx) << 8) | b(Y_LO + yIdx)
  if (b(F600 + levelId) & 0x20) y = (screen << 8) | (y & 0xff)
  else x = (screen << 8) | (x & 0xff)
  return { x, y }
}
