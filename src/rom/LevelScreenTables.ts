/**
 * Each level mode's layer layout, read from the level loader's own tables
 * (SMWDisX bank_05.asm:480-504, loaded at 542-553): the main screen designation
 * ($212C), the sub screen ($212D), CGADSUB (LevCGADSUBtable, :495-499), the
 * special-level setting ($0D9B, 0 = normal) and VerticalTable bit 7 (layer 2
 * interactive, bank_00.asm:11736-11738). ScreenPlanes turns the designations into
 * per-screen plane lists (#562); only a special setting stops layer 3 drawing.
 *
 * The tables are named by the operands of CODE_0584E3's LDA.L loads, found
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
  /** LevCGADSUBtable's byte, before CODE_009FB8 clears BG3 (bit 2). */
  cgadsub: number
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
const CGADSUB_AT = 15
const SPECIAL_AT = 21

/** Every mode's layout, or why the load site is not the stock one. */
export function readModeLayouts(rom: RomFile): ModeLayoutsResult {
  const what = "the level loader's screen-designation loads (bank_05.asm:542-551)"
  const site = findExactlyOneSite(rom, SITE, what)
  if (!site.ok) return site
  const code = rom.readAtFileOffset(site.offset, SITE.length)!
  const table = (at: number) => rom.readAt(code[at]! | (code[at + 1]! << 8) | (code[at + 2]! << 16), VERTICAL_TABLE_LENGTH) // prettier-ignore
  const [main, sub, cgadsub, special] = [MAIN_AT, SUB_AT, CGADSUB_AT, SPECIAL_AT].map(table)
  const vertical = readVerticalTable(rom)
  if (!main || !sub || !cgadsub || !special)
    return { ok: false, reason: `${what} name a table outside the ROM` }
  if (!vertical.ok) return vertical
  return {
    ok: true,
    layouts: Array.from({ length: VERTICAL_TABLE_LENGTH }, (_, m) => ({
      main: main[m]!,
      sub: sub[m]!,
      cgadsub: cgadsub[m]!,
      special: special[m]!,
      vertical: vertical.table[m]!,
    })),
  }
}

/**
 * Why layer 3 is not drawn for this layout, or null. The valid nonzero level
 * values are the boss rooms (Iggy/Larry $80, Reznor/Morton/Roy $C0, Bowser $C1;
 * rammap.asm:1331-1338); bit 7 sends NMI to Mode7NMI (bank_00.asm:233-235),
 * so there is no BG3 tilemap to draw.
 */
export function layoutRefusal(l: ModeLayout): string | null {
  return l.special !== 0 ? 'Layer 3 not drawn: Mode 7 boss room level mode' : null
}
