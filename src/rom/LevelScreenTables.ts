/**
 * Which level modes use the standard layer layout, read from the level
 * loader's own tables (SMWDisX bank_05.asm:480-504, loaded at 542-553): the
 * main screen designation ($15 = BG1, BG3, OBJ), the sub screen ($02 = BG2),
 * the special-level setting (0 = normal) and VerticalTable bit 7 (layer 2
 * interactive, bank_00.asm:11736-11738). Under all four BG2 is only on the
 * sub screen, so it sits behind every main-screen layer; any other combination
 * stacks differently and is not drawn yet (#562).
 *
 * The four tables are named by the operands of CODE_0584E3's LDA.L loads, found
 * as one 27-byte site that must match exactly once, with each STA pinned to its
 * RAM destination, so a hooked loader reads as unverified and never as stock.
 * VerticalTable comes from `readVerticalTable`, which carries its own gate.
 */
import { findExactlyOneSite, WILD, type BytePattern } from './BytePattern'
import { readVerticalTable, VERTICAL_TABLE_LENGTH } from './LevelTableGate'
import type { RomFile } from './RomFile'

export interface ModeLayout {
  main: number
  sub: number
  special: number
  /** VerticalTable's byte; bit 7 is layer 2 interactive. */
  vertical: number
}
export type ModeLayoutsResult = { ok: true; layouts: readonly ModeLayout[] } | { ok: false; reason: string } // prettier-ignore

// LDA.L main,X / STA.W ThroughMain / LDA.L sub,X / STA.W ThroughSub / LDA.L cgadsub,X /
// STA.B ColorSettings / LDA.L special,X / STA.W IRQNMICommand (bank_05.asm:542-551).
// prettier-ignore
const SITE: BytePattern = [
  0xbf, WILD, WILD, WILD, 0x8d, 0x9d, 0x0d,
  0xbf, WILD, WILD, WILD, 0x8d, 0x9e, 0x0d,
  0xbf, WILD, WILD, WILD, 0x85, 0x40,
  0xbf, WILD, WILD, WILD, 0x8d, 0x9b, 0x0d,
]
const MAIN_AT = 1
const SUB_AT = 8
const SPECIAL_AT = 21

/** Every mode's layout, or why the load site is not the stock one. */
export function readModeLayouts(rom: RomFile): ModeLayoutsResult {
  const what = "the level loader's screen-designation loads (bank_05.asm:542-551)"
  const site = findExactlyOneSite(rom, SITE, what)
  if (!site.ok) return site
  const code = rom.readAtFileOffset(site.offset, SITE.length)!
  const table = (at: number) => rom.readAt(code[at]! | (code[at + 1]! << 8) | (code[at + 2]! << 16), VERTICAL_TABLE_LENGTH) // prettier-ignore
  const [main, sub, special] = [MAIN_AT, SUB_AT, SPECIAL_AT].map(table)
  const vertical = readVerticalTable(rom)
  if (!main || !sub || !special)
    return { ok: false, reason: `${what} name a table outside the ROM` }
  if (!vertical.ok) return vertical
  return {
    ok: true,
    layouts: Array.from({ length: VERTICAL_TABLE_LENGTH }, (_, m) => ({
      main: main[m]!,
      sub: sub[m]!,
      special: special[m]!,
      vertical: vertical.table[m]!,
    })),
  }
}

/** Why layer 3 is not drawn for this layout, or null when it is the standard one. */
export function layoutRefusal(l: ModeLayout): string | null {
  if (l.vertical & 0x80) return 'Layer 3 not drawn yet: interactive layer 2 maps'
  if (l.main !== 0x15 || l.sub !== 0x02 || l.special !== 0) {
    return 'Layer 3 not drawn yet: this level mode has a non-standard layer layout'
  }
  return null
}
