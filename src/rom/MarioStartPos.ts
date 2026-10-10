import type { RomFile } from './RomFile'

// Primary-entrance tables, bank_05.asm:7302-7316.
const F000 = 0x05f000 // Y index (low nibble)
const F200 = 0x05f200 // X index (bits 2:0), entrance type (bits 5:3)
const F600 = 0x05f600 // bits 4:0 entrance screen, bit 5 vertical
const Y_LO = 0x05d730
const Y_HI = 0x05d740
const X_LO = 0x05d750
const X_HI = 0x05d758

/**
 * The entrance-type nudge CODE_00A635 applies after the loader (bank_00.asm:5019-5060): types 3, 4 and
 * 7 OR a mask into X, type 6 ORs one into X and one into Y. The masks are read from the LDA operands.
 * If the code at those sites is not the stock shape the nudge is OMITTED, not replaced by a stock
 * constant (rom-interpretation.md recipe): the caller already draws this fallback as unverified.
 */
function entranceNudge(rom: RomFile, type: number): { x: number; y: number } {
  const at = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => rom.readByte(a + i) ?? -1) // prettier-ignore
  const none = { x: 0, y: 0 }
  if (type !== 3 && type !== 4 && type !== 6 && type !== 7) return none
  // Every byte that decides which types reach a nudge, mask operands aside: BEQ, CMP #$05, BNE
  // ($00A6D8, bank_00.asm:4988-4990), CMP #$06/BCC/BNE ($00A716, 5019-5021), LDA #$04/CLC/ADC #$03
  // ($00A73E, 5040-5043), CPY #$06/BCC ($00A752, 5048-5049).
  const stock: [number, number[]][] = [
    [0x00a6d8, [0xf0]], [0x00a6da, [0xc9, 0x05, 0xd0]],
    [0x00a716, [0xc9, 0x06, 0x90]], [0x00a71a, [0xd0]],
    [0x00a73e, [0xa9, 0x04, 0x18, 0x69, 0x03]], [0x00a752, [0xc0, 0x06, 0x90]],
  ] // prettier-ignore
  if (stock.some(([a, w]) => at(a, w.length).some((v, i) => v !== w[i]))) return none
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
 * The loader's tail (bank_05.asm:7375-7387) puts the screen number, DATA_05F600[map] & $1F,
 * into the high byte of X on a horizontal map and of Y on a vertical map (the other axis keeps
 * its DATA_05D740/05D758 high byte). Leaving the screen out put Mario on screen 0 (#781).
 * Vertical is DATA_05F600[map] bit 5 (bank_05.asm:7292-7299). The type is DATA_05F200 bits 5:3
 * (7317-7322).
 *
 * Every map reads its PRIMARY entrance, entry maps $100+ included: the overworld enters them with
 * UseSecondaryExit 0 (bank_05.asm:7111-7112, 7300-7337). A secondary entrance is a return entrance
 * a sub area's screen exit uses, not where a map starts. No stock-code gate on the tables: this is
 * the fallback for a ROM whose loader the interpreter refuses, and its caller draws such results as
 * unverified.
 */
export function readMarioStartPos(rom: RomFile, mapId: number): { x: number; y: number } {
  const b = (a: number): number => rom.readByte(a) ?? 0
  const yIdx = b(F000 + mapId) & 0x0f
  const xIdx = b(F200 + mapId) & 0x07
  const type = (b(F200 + mapId) >> 3) & 0x07
  const screen = b(F600 + mapId) & 0x1f
  let x = (b(X_HI + xIdx) << 8) | b(X_LO + xIdx)
  let y = (b(Y_HI + yIdx) << 8) | b(Y_LO + yIdx)
  if (b(F600 + mapId) & 0x20) y = (screen << 8) | (y & 0xff)
  else x = (screen << 8) | (x & 0xff)
  const n = entranceNudge(rom, type)
  return { x: x | n.x, y: y | n.y }
}
