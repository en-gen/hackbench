/**
 * SmwLevelNames.ts
 *
 * Decodes level names directly from ROM data using the same tables and
 * algorithm the SNES game engine uses (bank_04 CODE_049D07).
 *
 * No hardcoded name lookup — all data is read from the ROM at runtime,
 * so edited ROMs with modified names decode correctly.
 *
 * ── ROM data layout (US version) ──────────────────────────────────────
 *
 * LevelNameStrings ($049AC5): Packed substrings. Each substring is a run
 *   of tile-index bytes; the last byte has bit 7 set as a terminator.
 *
 * DATA_049C91: Word table of offsets into LevelNameStrings.
 *   Indexed by (nameByte1 & 0x7F) — selects the area prefix
 *   (e.g. "YOSHI'S ", "DONUT ", "VANILLA ").
 *
 * DATA_049CCF: Word table of offsets into LevelNameStrings.
 *   Indexed by ((nameByte0 & 0xF0) >> 3) — selects the area type
 *   (e.g. "ISLAND ", "PLAINS ", "GHOST HOUSE ").
 *
 * DATA_049CED: Word table of offsets into LevelNameStrings.
 *   Indexed by ((nameByte0 & 0x0F) << 1) — selects the number suffix
 *   (e.g. "1", "2", " ").
 *
 * LevelNames ($04A0FC): 96 entries × 2 bytes (little-endian word).
 *   Entry[i] = packed (nameByte0, nameByte1) that encodes prefix+type+suffix
 *   indices for translevel i.
 *
 * The translevel indices 0–95 map to overworld pointer table slots:
 *   0x00–0x24 (translevels 0–36) → main overworld
 *   0x25–0x5F (translevels 37–95) → submaps: slot = translevel - 0x24 + 0x100
 */

import { RomFile } from './RomFile'

// ── Fixed ROM addresses (same in all vanilla/LM-edited US ROMs) ───────────

/** Packed name substrings (area names, types, numbers). */
const ADDR_LEVEL_NAME_STRINGS = 0x049AC5

/** Word table: prefix offsets (28 entries for US). Indexed by (byte1 & 0x7F). */
const ADDR_PREFIX_TABLE       = 0x049C91

/** Word table: type offsets (15 entries for US). Indexed by (byte0 & 0xF0) >> 3. */
const ADDR_TYPE_TABLE         = 0x049CCF

/** Word table: suffix offsets (13 entries for US). Indexed by (byte0 & 0x0F) << 1. */
const ADDR_SUFFIX_TABLE       = 0x049CED

/** 96 × 2-byte entries: packed name descriptor per translevel. */
const ADDR_LEVEL_NAMES        = 0x04A0FC

/** Number of translevel entries in the LevelNames table. */
const TRANSLEVEL_COUNT = 96

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
//   $1F     → ' ' (space — raw byte $9F, masked to $1F)
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
    case 0x1C: return '-'   // hyphen
    case 0x1F: return ' '   // space (raw $9F after AND $7F)
    // "OF ILLUSION" graphical tiles — 6 tiles between "OF" and "ON"
    case 0x32: return ' I'  // leading space to separate from preceding "OF"
    case 0x33: return 'L'
    case 0x34: return 'L'
    case 0x35: return 'U'
    case 0x36: return 'S'
    case 0x37: return 'I'
    // "YELLOW" graphical tiles — 5 tiles forming 6-letter word
    case 0x38: return 'Y'
    case 0x39: return 'E'
    case 0x3A: return 'L'
    case 0x3B: return 'L'
    case 0x3C: return 'OW'
    // Castle number prefix
    case 0x5A: return '#'
    // Apostrophe
    case 0x5D: return "'"
    // Number digit tiles 1–7
    case 0x64: return '1'
    case 0x65: return '2'
    case 0x66: return '3'
    case 0x67: return '4'
    case 0x68: return '5'
    case 0x69: return '6'
    case 0x6A: return '7'
    default:   return ''    // unknown/graphic tiles → omit
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
  for (let i = 0; i < 32; i++) {  // safety limit
    const byte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + offset + i)
    if (byte === null) break
    const tile = byte & 0x7F
    text += tileToChar(tile)
    tiles++
    if (byte & 0x80) break  // bit 7 = last byte of substring
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
 * Decode the display name for a single translevel number (0–95).
 *
 * Mirrors the US version of CODE_049D07:
 *   Part 1 (prefix):  byte1 & 0x7F → DATA_049C91 index → LevelNameStrings
 *                     Skip if first string byte has bit 7 set.
 *   Part 2 (type):    (byte0 & 0xF0) >> 3 → DATA_049CCF index → LevelNameStrings
 *                     Skip if first string byte == $9F (space).
 *   Part 3 (suffix):  (byte0 & 0x0F) << 1 → DATA_049CED index → LevelNameStrings
 *
 * @param rom         The loaded ROM file.
 * @param translevel  Translevel index 0–95.
 * @returns Decoded name string, or null if the entry is empty ($0000).
 */
export function decodeLevelName(rom: RomFile, translevel: number): string | null {
  if (translevel < 0 || translevel >= TRANSLEVEL_COUNT) return null

  const packed = rom.readWord(ADDR_LEVEL_NAMES + translevel * 2)
  if (packed === null || packed === 0 || packed === 0xFFFF) return null

  const byte0 = packed & 0xFF        // low byte — type + suffix
  const byte1 = (packed >> 8) & 0xFF // high byte — prefix

  let name = ''
  let tilesUsed = 0

  // Part 1: Prefix (area name)
  const prefixIndex = (byte1 & 0x7F) * 2
  const prefixOffset = readTableOffset(rom, ADDR_PREFIX_TABLE, prefixIndex)
  if (prefixOffset !== null) {
    // Check if first byte of the substring has bit 7 set — if so, skip prefix
    const firstByte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + prefixOffset)
    if (firstByte !== null && !(firstByte & 0x80)) {
      const { text, tiles } = decodeSubstring(rom, prefixOffset)
      name += text
      tilesUsed += tiles
    }
  }

  // Part 2: Type (area descriptor)
  const typeIndex = (byte0 & 0xF0) >> 3  // >>4 then <<1 = >>3
  const typeOffset = readTableOffset(rom, ADDR_TYPE_TABLE, typeIndex)
  if (typeOffset !== null) {
    // Skip if first byte is $9F (space) — means no type component.
    // The SNES code checks the raw byte against $9F before AND $7F.
    const firstByte = rom.readByte(ADDR_LEVEL_NAME_STRINGS + typeOffset)
    if (firstByte !== null && firstByte !== 0x9F) {
      const { text, tiles } = decodeSubstring(rom, typeOffset)
      name += text
      tilesUsed += tiles
    }
  }

  // Part 3: Suffix (number)
  // Only append if there's room in the 19-tile display budget.
  // The SNES engine clips overflow, so names that would exceed the
  // display width have their suffix invisibly truncated.
  const suffixIndex = (byte0 & 0x0F) * 2
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
 * Decode all 96 translevel names from the ROM.
 *
 * @returns Map from translevel index (0–95) to decoded name string.
 *          Entries with empty/null names are omitted.
 */
export function getAllLevelNames(rom: RomFile): Map<number, string> {
  const names = new Map<number, string>()
  for (let i = 0; i < TRANSLEVEL_COUNT; i++) {
    const name = decodeLevelName(rom, i)
    if (name) {
      names.set(i, name)
    }
  }
  return names
}

/**
 * Convert a translevel index (0–95) to the level pointer table index.
 *
 * From bank_05 CODE_05D796:
 *   TranslevelNo >= $25 → LoadingLevelNumber = TranslevelNo - $24
 *   Then if on submap: high byte = 1 → actual = LoadingLevelNumber + $100
 *
 * For our purposes, the LevelNames table is indexed by translevel (0–95).
 * Translevels 0x00–0x24 map to pointer table indices $000–$024 (main map).
 * Translevels 0x25–0x5F map to pointer table indices $101–$13B (submaps).
 */
export function translevelToPointerIndex(translevel: number): number {
  if (translevel <= 0x24) return translevel
  return (translevel - 0x24) + 0x100
}

/**
 * Convert a pointer table index back to a translevel number, or null
 * if the index does not correspond to any overworld translevel.
 */
export function pointerIndexToTranslevel(index: number): number | null {
  if (index >= 0x000 && index <= 0x024) return index
  if (index >= 0x101 && index <= 0x13B) return (index - 0x100) + 0x24
  return null
}

/**
 * Get the decoded ROM name for a pointer table level index.
 * Converts the index to a translevel, then decodes the name.
 */
export function getLevelNameByIndex(rom: RomFile, index: number): string | null {
  const translevel = pointerIndexToTranslevel(index)
  if (translevel === null) return null
  return decodeLevelName(rom, translevel)
}
