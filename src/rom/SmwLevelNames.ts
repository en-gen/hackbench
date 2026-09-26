/**
 * SmwLevelNames.ts
 *
 * Decodes level names directly from ROM data using the same tables and
 * algorithm the SNES game engine uses (bank_04 CODE_049D07).
 *
 * No hardcoded name lookup - all data is read from the ROM at runtime,
 * so edited ROMs with modified names decode correctly.
 *
 * ── ROM data layout (US version) ──────────────────────────────────────
 *
 * LevelNameStrings ($049AC5): Packed substrings. Each substring is a run
 *   of tile-index bytes; the last byte has bit 7 set as a terminator.
 *
 * DATA_049C91: Word table of offsets into LevelNameStrings.
 *   Indexed by (nameByte1 & 0x7F) - selects the area prefix
 *   (e.g. "YOSHI'S ", "DONUT ", "VANILLA ").
 *
 * DATA_049CCF: Word table of offsets into LevelNameStrings.
 *   Indexed by ((nameByte0 & 0xF0) >> 3) - selects the area type
 *   (e.g. "ISLAND ", "PLAINS ", "GHOST HOUSE ").
 *
 * DATA_049CED: Word table of offsets into LevelNameStrings.
 *   Indexed by ((nameByte0 & 0x0F) << 1) - selects the number suffix
 *   (e.g. "1", "2", " ").
 *
 * LevelNames ($04A0FC): 96 entries × 2 bytes (little-endian word).
 *   Entry[i] = packed (nameByte0, nameByte1) that encodes prefix+type+suffix
 *   indices for translevel i.
 *
 * A slot's name comes from `levelNameForSlot`, below, via the overworld
 * walk's own entrances -- a bias/threshold formula alone cannot say which
 * translevel reaches a slot.
 */

import { RomFile } from './RomFile'
import type { OverworldEntranceIndex } from './OverworldEntrances'

// ── Fixed ROM addresses (same in all vanilla/LM-edited US ROMs) ───────────

/** Packed name substrings (area names, types, numbers). */
const ADDR_LEVEL_NAME_STRINGS = 0x049ac5

/** Word table: prefix offsets (28 entries for US). Indexed by (byte1 & 0x7F). */
const ADDR_PREFIX_TABLE = 0x049c91

/** Word table: type offsets (15 entries for US). Indexed by (byte0 & 0xF0) >> 3. */
const ADDR_TYPE_TABLE = 0x049ccf

/** Word table: suffix offsets (13 entries for US). Indexed by (byte0 & 0x0F) << 1. */
const ADDR_SUFFIX_TABLE = 0x049ced

/** 96 × 2-byte entries: packed name descriptor per translevel. */
const ADDR_LEVEL_NAMES = 0x04a0fc

/** Translevel is an 8-bit index with no further bound (bank_04.asm:1345-1349,
 *  :2258-2262); past the stock table's 93 entries it reads $FFFF fill
 *  (:3497-3524), which `decodeLevelName` already refuses on its own. */
const TRANSLEVEL_INDEX_WIDTH = 256

// ── Tile-index → ASCII mapping ────────────────────────────────────────────
//
// The SNES game stores display characters as BG tile indices (not ASCII).
// CODE_049D7F masks each byte with $7F before writing to VRAM; we map
// those 7-bit values to printable characters.
//
// The SMW overworld font uses multi-character graphical tiles for certain
// words. Each graphical tile renders as a small bitmap on the SNES, but
// we map them to their logical text equivalents:
//
// After AND $7F:
//   $00–$19 → A–Z (26 standard letter tiles)
//   $1C     → '-' (hyphen, e.g. "CHOCO-GHOST HOUSE")
//   $1F     → ' ' (space - raw byte $9F, masked to $1F)
//   $32–$37 → graphical tiles spelling "ILLUSI" (completing "OF ILLUSION")
//   $38–$3C → graphical tiles spelling "YELLO" (completing "YELLOW")
//   $5A     → '#' (castle number prefix graphic tile)
//   $5D     → '\'' (apostrophe, e.g. "YOSHI'S")
//   $64–$6A → digit tiles '1'–'7' (castle numbers, island numbers)

function tileToChar(tile: number): string {
  // Standard letter tiles A–Z
  if (tile >= 0x00 && tile <= 0x19) {
    return String.fromCharCode(0x41 + tile)
  }
  switch (tile) {
    case 0x1c:
      return '-' // hyphen
    case 0x1f:
      return ' ' // space (raw $9F after AND $7F)
    // "OF ILLUSION" graphical tiles - 6 tiles between "OF" and "ON"
    case 0x32:
      return ' I' // leading space to separate from preceding "OF"
    case 0x33:
      return 'L'
    case 0x34:
      return 'L'
    case 0x35:
      return 'U'
    case 0x36:
      return 'S'
    case 0x37:
      return 'I'
    // "YELLOW" graphical tiles - 5 tiles forming 6-letter word
    case 0x38:
      return 'Y'
    case 0x39:
      return 'E'
    case 0x3a:
      return 'L'
    case 0x3b:
      return 'L'
    case 0x3c:
      return 'OW'
    // Castle number prefix
    case 0x5a:
      return '#'
    // Apostrophe
    case 0x5d:
      return "'"
    // Number digit tiles 1–7
    case 0x64:
      return '1'
    case 0x65:
      return '2'
    case 0x66:
      return '3'
    case 0x67:
      return '4'
    case 0x68:
      return '5'
    case 0x69:
      return '6'
    case 0x6a:
      return '7'
    default:
      return '' // unknown/graphic tiles → omit
  }
}

// ── Core decoder ──────────────────────────────────────────────────────────

/** Max SNES display tiles for the overworld level name. */
const MAX_DISPLAY_TILES = 19

/**
 * Reads a packed substring from LevelNameStrings starting at the given
 * offset. Each byte's low 7 bits are a tile index; bit 7 set marks the
 * last byte of the substring.
 *
 * @returns Object with decoded text and SNES tile count consumed.
 */
function decodeSubstring(rom: RomFile, offset: number): { text: string; tiles: number } {
  let text = ''
  let tiles = 0
  for (let i = 0; i < 32; i++) {
    // safety limit
    const byte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + offset + i)
    if (byte === null) break
    const tile = byte & 0x7f
    text += tileToChar(tile)
    tiles++
    if (byte & 0x80) break // bit 7 = last byte of substring
  }
  return { text, tiles }
}

/**
 * Reads a 16-bit offset from one of the three indirection tables.
 */
function readTableOffset(rom: RomFile, tableAddr: number, index: number): number | null {
  return rom.readWord(tableAddr + index)
}

/**
 * Decode the display name for a single translevel number (8-bit index).
 *
 * Mirrors the US version of CODE_049D07:
 *   Part 1 (prefix):  byte1 & 0x7F → DATA_049C91 index → LevelNameStrings
 *                     Skip if first string byte has bit 7 set.
 *   Part 2 (type):    (byte0 & 0xF0) >> 3 → DATA_049CCF index → LevelNameStrings
 *                     Skip if first string byte == $9F (space).
 *   Part 3 (suffix):  (byte0 & 0x0F) << 1 → DATA_049CED index → LevelNameStrings
 *
 * @param rom         The loaded ROM file.
 * @param translevel  Translevel index, 0-255.
 * @returns Decoded name string, or null if the entry is empty ($0000 or $FFFF).
 */
export function decodeLevelName(rom: RomFile, translevel: number): string | null {
  if (translevel < 0 || translevel >= TRANSLEVEL_INDEX_WIDTH) return null

  const packed = rom.readWord(ADDR_LEVEL_NAMES + translevel * 2)
  if (packed === null || packed === 0 || packed === 0xffff) return null

  const byte0 = packed & 0xff // low byte - type + suffix
  const byte1 = (packed >> 8) & 0xff // high byte - prefix

  let name = ''
  let tilesUsed = 0

  // Part 1: Prefix (area name)
  const prefixIndex = (byte1 & 0x7f) * 2
  const prefixOffset = readTableOffset(rom, ADDR_PREFIX_TABLE, prefixIndex)
  if (prefixOffset !== null) {
    // Check if first byte of the substring has bit 7 set - if so, skip prefix
    const firstByte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + prefixOffset)
    if (firstByte !== null && !(firstByte & 0x80)) {
      const { text, tiles } = decodeSubstring(rom, prefixOffset)
      name += text
      tilesUsed += tiles
    }
  }

  // Part 2: Type (area descriptor)
  const typeIndex = (byte0 & 0xf0) >> 3 // >>4 then <<1 = >>3
  const typeOffset = readTableOffset(rom, ADDR_TYPE_TABLE, typeIndex)
  if (typeOffset !== null) {
    // Skip if first byte is $9F (space) - means no type component.
    // The SNES code checks the raw byte against $9F before AND $7F.
    const firstByte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + typeOffset)
    if (firstByte !== null && firstByte !== 0x9f) {
      const { text, tiles } = decodeSubstring(rom, typeOffset)
      name += text
      tilesUsed += tiles
    }
  }

  // Part 3: Suffix (number)
  // Only append if there's room in the 19-tile display budget.
  // The SNES engine clips overflow, so names that would exceed the
  // display width have their suffix invisibly truncated.
  const suffixIndex = (byte0 & 0x0f) * 2
  const suffixOffset = readTableOffset(rom, ADDR_SUFFIX_TABLE, suffixIndex)
  if (suffixOffset !== null) {
    const { text, tiles } = decodeSubstring(rom, suffixOffset)
    if (tilesUsed + tiles <= MAX_DISPLAY_TILES) {
      name += text
    }
  }

  // Clean up: collapse multiple spaces and trim.
  name = name.replace(/\s+/g, ' ').trim()
  return name || null
}

/**
 * Decode every translevel name the ROM defines.
 *
 * @returns Map from translevel index to decoded name string. Entries with
 *          empty/null names (including the stock table's $FFFF fill) are omitted.
 */
export function getAllLevelNames(rom: RomFile): Map<number, string> {
  const names = new Map<number, string>()
  for (let i = 0; i < TRANSLEVEL_INDEX_WIDTH; i++) {
    const name = decodeLevelName(rom, i)
    if (name) {
      names.set(i, name)
    }
  }
  return names
}

export interface LevelNameResult {
  name: string | null
  /** Set only when the overworld is unreadable, or `index` is reached by
   *  translevels that decode to different names; `name` is then null. */
  reason?: string
}

/** The name for slot `index`, from the entrances that actually reach it
 *  (`entrances.entrances`, keyed by `.slot`), not a static bias formula. */
export function levelNameForSlot(
  rom: RomFile,
  entrances: OverworldEntranceIndex,
  index: number,
): LevelNameResult {
  if (!entrances.overworldReadable) {
    return { name: null, reason: entrances.notes[0] }
  }
  const translevels = [
    ...new Set(entrances.entrances.filter(e => e.slot === index).map(e => e.translevel)),
  ]
  // An empty decode counts as its own value: agreeing on "no name" resolves,
  // but one translevel naming the slot while another decodes to nothing is
  // still a disagreement, not the named one winning by default.
  const names = new Set(translevels.map(t => decodeLevelName(rom, t)))
  if (names.size <= 1) return { name: [...names][0] ?? null }
  const list = translevels.map(t => `$${t.toString(16).toUpperCase()}`).join(', ')
  return {
    name: null,
    reason:
      `Slot $${index.toString(16).toUpperCase().padStart(3, '0')} is reached by translevels ` +
      `${list}, which decode to different names.`,
  }
}
