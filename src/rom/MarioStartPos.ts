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
 * 7 OR a mask into X, type 6 ORs one into X and one into Y. Type 7 reaches it only when
 * SkipMidwayCastleIntro and KeyholeTimer are 0 (bank_00.asm:5037-5039), the overworld-entry case. The masks are read from the LDA operands.
 * If the code at those sites is not the stock shape the nudge is OMITTED, not replaced by a stock
 * constant (rom-interpretation.md recipe): the caller already draws this fallback as unverified.
 */
function entranceNudge(rom: RomFile, type: number): { x: number; y: number } {
  const at = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => rom.readByte(a + i) ?? -1) // prettier-ignore
  const none = { x: 0, y: 0 }
  if (type !== 3 && type !== 4 && type !== 6 && type !== 7) return none
  // Every opcode and branch offset on the paths to a nudge, mask operands aside: BEQ/CMP #$05/BNE
  // ($00A6D8, bank_00.asm:4988-4990), CMP #$06/BCC/BNE ($00A716, 5020-5022), type 7's entry
  // LDA/ORA/BNE CODE_00A6E0 ($00A736, 5036-5039), LDA #$04/CLC/ADC #$03 ($00A73E, 5040-5043),
  // CPY #$06/BCC ($00A752, 5052-5053). Not gated: the data those loads read.
  const stock: [number, number[]][] = [
    [0x00a6d8, [0xf0, 0x06, 0xc9, 0x05, 0xd0, 0x38]], [0x00a716, [0xc9, 0x06, 0x90, 0x26, 0xd0, 0x18]],
    [0x00a736, [0xad, 0xcf, 0x13, 0x0d, 0x34, 0x14, 0xd0, 0xa2]], [0x00a73e, [0xa9, 0x04, 0x18, 0x69, 0x03]],
    [0x00a752, [0xc0, 0x06, 0x90, 0x12]],
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
 * UseSecondaryExit 0 (bank_05.asm:7091-7093, 7164-7226, 7300-7337; Clear_1A_13D3 zeroes $13D3-$1BA1,
 * bank_00.asm:4375-4385). This models map load by the primary path, which is where the overworld puts
 * Mario in an entry map; for a sub area the real arrival point depends on the screen exit, not the
 * map. No stock-code gate on the tables: this is the fallback for a ROM whose loader the interpreter
 * refuses, and its caller draws such results as unverified.
 *
 * Returns null when any of the seven table bytes cannot be read; callers refuse rather than default.
 */
export function readMarioStartPos(rom: RomFile, mapId: number): { x: number; y: number } | null {
  // An unreadable table byte (a ROM cut short of the tables) is a refusal, not a 0: a zero would
  // draw as a plausible start on screen 0.
  const f0 = rom.readByte(F000 + mapId)
  const f2 = rom.readByte(F200 + mapId)
  const f6 = rom.readByte(F600 + mapId)
  if (f0 === null || f2 === null || f6 === null) return null
  const yIdx = f0 & 0x0f
  const xIdx = f2 & 0x07
  const type = (f2 >> 3) & 0x07
  const screen = f6 & 0x1f
  const yLo = rom.readByte(Y_LO + yIdx)
  const yHi = rom.readByte(Y_HI + yIdx)
  const xLo = rom.readByte(X_LO + xIdx)
  const xHi = rom.readByte(X_HI + xIdx)
  if (yLo === null || yHi === null || xLo === null || xHi === null) return null
  let x = (xHi << 8) | xLo
  let y = (yHi << 8) | yLo
  if (f6 & 0x20) y = (screen << 8) | (y & 0xff)
  else x = (screen << 8) | (x & 0xff)
  const n = entranceNudge(rom, type)
  return { x: x | n.x, y: y | n.y }
}
