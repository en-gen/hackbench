/**
 * Synthetic ROMs for the layer 3 gate: the mode tables (the 27-byte load site
 * CODE_0584E3 reads them through, plus the tables) and one level's layer 3 data
 * (F200 setting, per-tileset settings byte, Layer3Ptr entry, a one-tile stripe
 * image), all built here. No cart bytes.
 */
import { RomFile } from '../../../src/rom/RomFile'
import type { ModeLayout } from '../../../src/rom/LevelScreenTables'

const TABLE = { vertical: 0x058417, main: 0x058437, sub: 0x058457, cgadsub: 0x058477, special: 0x058497 } // prettier-ignore
const SITE_AT = 0x0584f0
const VT_SITE_AT = 0x058520
export const STRIPE_AT = 0x0a8000
const L3_SETTINGS = 0x009f88
const L3_PTRS = 0x059000

const long = (a: number) => [a & 0xff, (a >> 8) & 0xff, a >> 16]

/** The mode tables for 32 modes plus the two load sites that name them, as CODE_0584E3 compiles. */
export function modeTablesRom(layouts: readonly ModeLayout[]): RomFile {
  const rom = new RomFile('l3.sfc', Buffer.alloc(0x80000, 0))
  rom.writeAt(0x00ffd5, [0x20])
  rom.writeAt(
    TABLE.vertical,
    layouts.map(l => l.vertical),
  )
  rom.writeAt(
    TABLE.main,
    layouts.map(l => l.main),
  )
  rom.writeAt(
    TABLE.sub,
    layouts.map(l => l.sub),
  )
  rom.writeAt(
    TABLE.special,
    layouts.map(l => l.special),
  )
  // LDA.L main,X / STA.W $0D9D / LDA.L sub,X / STA.W $0D9E / LDA.L cgadsub,X / STA.B $40 / LDA.L special,X / STA.W $0D9B
  // prettier-ignore
  rom.writeAt(SITE_AT, [0xbf, ...long(TABLE.main), 0x8d, 0x9d, 0x0d, 0xbf, ...long(TABLE.sub), 0x8d, 0x9e, 0x0d,
    0xbf, ...long(TABLE.cgadsub), 0x85, 0x40, 0xbf, ...long(TABLE.special), 0x8d, 0x9b, 0x0d])
  rom.writeAt(VT_SITE_AT, [0xbf, ...long(TABLE.vertical), 0x85, 0x5b]) // LDA.L VerticalTable,X / STA.B ScreenMode
  return rom
}
export const SITE_BYTES = { at: SITE_AT, length: 27, stores: [0x8d, 0x9d, 0x0d] }

export const STANDARD: ModeLayout = { main: 0x15, sub: 0x02, special: 0, vertical: 0 }

/** One level's layer 3: a single tile word at the tilemap's first gameplay row, `row` * 8 rows down. */
export function withLayer3(
  rom: RomFile,
  o: { level: number; tileset: number; setting: number; settingsByte: number; word: number; row?: number }, // prettier-ignore
): RomFile {
  const entry = o.setting - 1 + o.tileset * 3
  rom.writeAt(0x05f200 + o.level, [o.setting << 6])
  rom.writeAt(L3_SETTINGS + entry, [o.settingsByte])
  rom.writeAt(L3_PTRS + entry * 3, long(STRIPE_AT))
  const vram = 0x5000 + (o.row ?? 8) * 32
  // One horizontal run of one tile: VRAM hi/lo, flags 0, byte count - 1 = 1, the word, terminator.
  rom.writeAt(STRIPE_AT, [vram >> 8, vram & 0xff, 0x00, 0x01, o.word & 0xff, o.word >> 8, 0xff])
  return rom
}

/** The vanilla-used modes the issue names as standard layout (#561, bank_05.asm:480-504). */
export const STANDARD_MODES = [0x00, 0x01, 0x03, 0x05, 0x07, 0x0a, 0x0c, 0x0d]

/**
 * 32 modes: those in STANDARD_MODES standard (vertical low bits vary, which must not matter);
 * every other mode deviates in exactly one of main, sub, vertical bit 7, special, cycling.
 */
export function sweepLayouts(): ModeLayout[] {
  return Array.from({ length: 32 }, (_, m) => {
    if (STANDARD_MODES.includes(m)) return { ...STANDARD, vertical: m & 3 }
    return [
      { ...STANDARD, main: 0x17 },
      { ...STANDARD, sub: 0x00 },
      { ...STANDARD, vertical: 0x80 | (m & 3) },
      { ...STANDARD, special: 0xc0 },
    ][m % 4]!
  })
}
