import type { RomFile } from './RomFile'

// Table addresses, bank_05.asm:7302-7316 (primary) and 7120-7158 (secondary).
const F000 = 0x05f000 // primary Y index (low nibble)
const F200 = 0x05f200 // primary X index (low 3 bits)
const FE00 = 0x05fe00 // secondary entrance type (bits 2:0)
const F800 = 0x05f800 // secondary entrance target map, low byte
const F600 = 0x05f600 // bits 4:0 entrance screen, bit 5 vertical
const FA00 = 0x05fa00 // secondary Y index (low nibble)
const FC00 = 0x05fc00 // secondary X index (bits 7:5), entrance screen (bits 4:0)
const Y_LO = 0x05d730
const Y_HI = 0x05d740
const X_LO = 0x05d750
const X_HI = 0x05d758

/** The lowest secondary entrance targeting `mapId`, or null. Lowest index is this reader's tie rule. */
function secondaryEntrance(rom: RomFile, mapId: number): number | null {
  // The exit's entrance index is (submap flag << 8) | ExitTableLow and the target map's bit 8 is that
  // same flag (bank_05.asm:7103-7119), so candidates share the map's bit 8 and F800 holds the low byte.
  // DATA_05FC00 bit 0 is the entrance's screen bit, not the target (bank_05.asm:7147-7148, 7382).
  for (let low = 0; low < 0x100; low++) {
    const e = (mapId & 0x100) | low
    if (rom.readByte(F800 + e) === (mapId & 0xff)) return e
  }
  return null
}

/**
 * The entrance-type nudge CODE_00A635 applies after the loader (bank_00.asm:A716-A75A): types 3, 4 and
 * 7 OR a mask into X, type 6 ORs one into X and one into Y. The masks are read from the LDA operands.
 * If the code at those sites is not the stock shape the nudge is OMITTED, not replaced by a stock
 * constant (rom-interpretation.md recipe): the caller already draws this fallback as unverified.
 */
function entranceNudge(rom: RomFile, type: number): { x: number; y: number } {
  const at = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => rom.readByte(a + i) ?? -1) // prettier-ignore
  const none = { x: 0, y: 0 }
  if (type !== 3 && type !== 4 && type !== 6 && type !== 7) return none
  const [c, d] = [at(0x00a716, 2), at(0x00a752, 2)] // CMP #$06, CPY #$06
  if (c[0] !== 0xc9 || c[1] !== 6 || d[0] !== 0xc0 || d[1] !== 6) return none
  if (type === 6) {
    const s = at(0x00a726, 8) // LDA #m / TSB $94 / LDA #n / TSB $96
    const ok = s[0] === 0xa9 && s[2] === 0x04 && s[3] === 0x94 && s[4] === 0xa9 && s[6] === 0x04 && s[7] === 0x96 // prettier-ignore
    return ok ? { x: s[1]!, y: s[5]! } : none
  }
  const s = at(0x00a756, 4) // LDA #m / TSB $94
  return s[0] === 0xa9 && s[2] === 0x04 && s[3] === 0x94 ? { x: s[1]!, y: 0 } : none
}

/**
 * Mario's start position in a map, as the loader leaves $94/$96: the entrance's SCREEN and
 * entrance-type nudge included.
 *
 * The loader's tail (bank_05.asm:7375-7387) puts the screen number, DATA_05F600[map] & $1F
 * for a primary entrance or DATA_05FC00[entrance] & $1F for a secondary one, into the high
 * byte of X on a horizontal map and of Y on a vertical map (the other axis keeps its
 * DATA_05D740/05D758 high byte). Leaving the screen out put Mario on screen 0 (#781).
 * Vertical is DATA_05F600[map] bit 5 (bank_05.asm:7292-7299). The type is DATA_05F200 bits 5:3
 * (primary, 7317-7322) or DATA_05FE00 bits 2:0 (secondary, 7159-7161).
 *
 * A map $100+ uses the secondary entrance that targets it, as the game does; one no entrance
 * targets falls back to its primary bytes. No stock-code gate on the tables: this is the fallback
 * for a ROM whose loader the interpreter refuses, and its caller draws such results as unverified.
 */
export function readMarioStartPos(rom: RomFile, mapId: number): { x: number; y: number } {
  const b = (a: number): number => rom.readByte(a) ?? 0
  let yByte = b(F000 + mapId)
  let xIdx = b(F200 + mapId) & 0x07
  let screen = b(F600 + mapId) & 0x1f
  let type = (b(F200 + mapId) >> 3) & 0x07
  const e = mapId >= 0x100 ? secondaryEntrance(rom, mapId) : null
  if (e !== null) {
    yByte = b(FA00 + e)
    xIdx = (b(FC00 + e) >> 5) & 0x07
    screen = b(FC00 + e) & 0x1f
    type = b(FE00 + e) & 0x07
  }
  const yIdx = yByte & 0x0f
  let x = (b(X_HI + xIdx) << 8) | b(X_LO + xIdx)
  let y = (b(Y_HI + yIdx) << 8) | b(Y_LO + yIdx)
  if (b(F600 + mapId) & 0x20) y = (screen << 8) | (y & 0xff)
  else x = (screen << 8) | (x & 0xff)
  const n = entranceNudge(rom, type)
  return { x: x | n.x, y: y | n.y }
}
