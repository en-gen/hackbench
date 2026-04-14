/**
 * GFX file loading and VRAM slot assignment for Super Mario World.
 *
 * SMW has 50 GFX files (GFX00–GFX31 hex = indices 0–49 decimal), each stored
 * LC_LZ2-compressed in ROM banks $08–$0B. File addresses come from three split
 * pointer tables, NOT a fixed base + stride.
 *
 * ⚠ NAMING CONVENTION: GFX file names use HEX (Lunar Magic / community standard).
 *   GFX00 = index 0, GFX20 = index 32 decimal (the 3bpp Mario sprites file),
 *   GFX31 = index 49 decimal (last file in the pointer table).
 *   There are NO files GFX32–GFX33 hex (indices 50–51) in vanilla SMW.
 *   Confirmed: pointer tables at $B992/$B9C4/$B9F6 have exactly 50 entries each
 *   (spacing $32 = 50), and the last two slots read garbage if accessed as 51/52.
 *
 * After decompression, standard files are 4bpp SNES planar graphics
 * (up to 128 tiles × 32 bytes = 4096 bytes). GFX20 hex (index 32) is 3bpp.
 *
 * ── GFX Pointer Tables ────────────────────────────────────────────────────────
 *   $00B992  — lo  bytes (50 entries, GFX00–GFX31 hex)
 *   $00B9C4  — hi  bytes
 *   $00B9F6  — bank bytes
 *   Combined SNES address: (bank << 16) | (hi << 8) | lo
 *   Verified via diagnostic script: all 50 entries resolve to banks $08–$0B.
 *
 * ── VRAM slot layout (each slot = 128 8×8 tiles = one GFX file) ──────────────
 *   SP1, SP2, SP3, SP4   — sprite GFX (rows 8–15 in palette)
 *   FG1, FG2, FG3        — foreground/background GFX (rows 0–7 in palette)
 *   AnimFG (an1), An2    — animated tile slots
 *
 * ── GFX assignment tables ─────────────────────────────────────────────────────
 *   Sprite GFX:  $00A8C3 + spriteSet * 4  → 4 bytes: SP1, SP2, SP3, SP4
 *   FG/BG GFX:   $00A92B + tilesetId * 4  → 4 bytes: FG1, FG2, FG3, AnimFG
 *   ROM table stores entries in reverse load order; byte[3]=first slot loaded.
 *   (Verified empirically via Mesen2 $7E:0105/$7E:0101 vs ROM table bytes.)
 *
 * ── VRAM character number mapping (each slot = 0x80 chars = 128 tiles) ────────
 *   FG1     → chars $000–$07F
 *   FG2     → chars $080–$0FF
 *   FG3     → chars $100–$17F
 *   AnimFG  → chars $180–$1FF
 *   An2     → chars $200–$27F  (GFX20 hex / index 32, 3bpp static — Mario sprites)
 *   BG1     → chars $280–$2FF  (GFX21 hex / index 33, static tileset)
 *
 *   SP1–SP4 live in OBJ character space (separate from BG chars).
 *
 * NOTE: The tileset index for a level is stored via $05D760[spriteSet],
 *       NOT from header byte 4 directly.
 */

import { RomFile } from './RomFile'
import { decode2bpp, decode3bpp, decode4bpp, PIXELS_PER_TILE } from './GraphicsDecoder'
import { decompress } from './LcLz2'

// ── GFX pointer tables (split lo/hi/bank, one byte per GFX file) ──────────────
export const GFX_PTR_LO   = 0x00B992
export const GFX_PTR_HI   = 0x00B9C4
export const GFX_PTR_BANK = 0x00B9F6

// ── Counts and sizes ──────────────────────────────────────────────────────────
// Pointer table has exactly 50 entries (GFX00–GFX31 hex = indices 0–49 decimal).
// Confirmed: $B9C4-$B992 = $32 = 50. Do NOT read index 50 or 51.
export const GFX_FILE_COUNT  = 50   // GFX00–GFX31 hex (0–49 decimal)

// Actual decompressed sizes and formats (confirmed empirically):
//
//   Size    3bpp tiles  4bpp tiles  Which files            Format
//   ──────  ──────────  ──────────  ─────────────────────  ──────────────────────
//   3072 B   128 ✓      96          GFX00–GFX1F hex (0–31) 3bpp  (fills 128-slot perfectly)
//            128 ✓      128 ✓       GFX20 hex (32) Mario   3bpp  (same size/format)
//   2048 B    85.3 ✗    64 ✓        GFX28–GFX2B hex (40-43) 4bpp (doesn't divide by 24)
//   1024 B    42.7 ✗    32 ✓        GFX2F hex (47)          4bpp
//   1536 B    64 ✓       48 ✓       GFX30–GFX31 hex (48-49) 3bpp (assumed; fills evenly)
//
// Rule: if decompressed length is divisible by 24, use 3bpp.
//       if only divisible by 32 (not 24), use 4bpp.
export const GFX_TILES      = 128  // tiles per standard 3bpp file (3072 ÷ 24)
export const GFX_TILES_3BPP = 128  // kept for compatibility (same value)

// GFX20 hex (decimal index 32) is the Mario/Luigi sprites file.
// It is NOT the only 3bpp file — virtually all GFX files use 3bpp encoding.
// This constant is preserved for palette/slot-assignment logic only.
export const GFX_MARIO_3BPP_INDEX = 32  // = 0x20 hex in Lunar Magic naming

// GFX20 hex (index 32) and GFX21 hex (index 33) are the static tileset —
// always loaded into an2/bg1 regardless of the level's tileset ID.
export const GFX_STATIC_INDEX = 32  // GFX20 hex

// Upper bound for a single compressed GFX file read. Generous: actual
// decompressed data is ~4096 bytes; compressed is typically much smaller.
const GFX_MAX_COMPRESSED = 0x2000

// ── GFX assignment tables ─────────────────────────────────────────────────────
export const GFX_SPRITE_TABLE  = 0x00A8C3  // sprite GFX: 4 bytes per sprite set
export const GFX_FGBG_TABLE    = 0x00A92B  // FG/BG GFX:  4 bytes per tileset ID
export const GFX_BYTES_PER_SET = 4

/** Named VRAM slots. */
export const VRAM_SLOT_NAMES = [
  'sp4', 'sp3', 'sp2', 'sp1',
  'fg3', 'fg2', 'fg1',
  'an2', 'an1',
  'bg3', 'bg2', 'bg1',
] as const
export type VramSlotName = typeof VRAM_SLOT_NAMES[number]

/**
 * Character number base for each VRAM slot.
 * Each slot covers 128 tiles (0x80 chars).
 * SP1–SP4 use OBJ space and don't appear in Map16 BG char numbers.
 */
export const VRAM_CHAR_BASE: Record<VramSlotName, number> = {
  fg1: 0x000,  // chars $000–$07F
  fg2: 0x080,  // chars $080–$0FF
  fg3: 0x100,  // chars $100–$17F
  an1: 0x180,  // chars $180–$1FF  (AnimFG — 4th byte of FGBG table)
  an2: 0x200,  // chars $200–$27F  (GFX32 static)
  bg1: 0x280,  // chars $280–$2FF  (GFX33 static)
  bg2: 0x300,  // placeholder
  bg3: 0x380,  // placeholder
  sp1: 0x400,  // OBJ space — placeholder only
  sp2: 0x480,  // OBJ space — placeholder only
  sp3: 0x500,  // OBJ space — placeholder only
  sp4: 0x580,  // OBJ space — placeholder only
}

/** Decoded GFX sheet: N tiles × 64 palette indices each. */
export type GfxSheet = Uint8Array[]  // [tileIndex] → 64-pixel palette-index array

/** VRAM contents: slot name → decoded GFX sheet (or undefined if unassigned). */
export type VramState = Partial<Record<VramSlotName, GfxSheet>>

// ── Core loader ───────────────────────────────────────────────────────────────

/**
 * Read and decompress a single GFX file, returning the raw decompressed bytes.
 * Useful for client-side re-decoding (e.g. toggling 3bpp / 4bpp in the viewer).
 * Returns an empty Uint8Array if the pointer is invalid or the read fails.
 */
export function loadGfxRaw(rom: RomFile, fileIndex: number): Uint8Array {
  const lo   = rom.readByte(GFX_PTR_LO   + fileIndex)
  const hi   = rom.readByte(GFX_PTR_HI   + fileIndex)
  const bank = rom.readByte(GFX_PTR_BANK + fileIndex)

  if (lo === null || hi === null || bank === null) return new Uint8Array(0)

  const snesAddr   = (bank << 16) | (hi << 8) | lo
  const compressed = rom.readAt(snesAddr, GFX_MAX_COMPRESSED)
  if (!compressed) return new Uint8Array(0)

  return decompress(compressed)
}

/**
 * Load and decompress a single GFX file by its index (0–51).
 * Uses the split pointer tables at $00B992/$00B9C4/$00B9F6 to find the
 * LC_LZ2-compressed data, decompresses it, then decodes to palette indices.
 *
 * Returns an empty fallback sheet if the pointer is invalid or the read fails.
 */
export function loadGfxFile(rom: RomFile, fileIndex: number): GfxSheet {
  const lo   = rom.readByte(GFX_PTR_LO   + fileIndex)
  const hi   = rom.readByte(GFX_PTR_HI   + fileIndex)
  const bank = rom.readByte(GFX_PTR_BANK + fileIndex)

  if (lo === null || hi === null || bank === null) {
    return _emptySheet(GFX_TILES)
  }

  const snesAddr = (bank << 16) | (hi << 8) | lo
  const compressed = rom.readAt(snesAddr, GFX_MAX_COMPRESSED)
  if (!compressed) {
    return _emptySheet(GFX_TILES)
  }

  const data = decompress(compressed)

  // Detect bpp from decompressed size:
  //   only divisible by 32 (not 16 or 24) → 4bpp
  //   only divisible by 24 (not 32)       → 3bpp
  //   only divisible by 16 (not 24 or 32) → 2bpp
  //   divisible by both 24 and 32         → prefer 3bpp (standard SMW files confirmed
  //     3bpp by visual inspection; 128 tiles fills a VRAM slot exactly)
  //   divisible by 16 and 24 (e.g. 3072)  → also prefer 3bpp over 2bpp
  //   If auto-detection is wrong the viewer's BPP dropdown can override it.
  const div16 = data.length % 16 === 0
  const div24 = data.length % 24 === 0
  const div32 = data.length % 32 === 0
  const bpp   = (!div24 && !div32 && div16) ? 2
              : (!div24 &&  div32)           ? 4
              : 3   // 3bpp preferred for ambiguous sizes (e.g. 3072)
  const bpt   = bpp === 4 ? 32 : bpp === 3 ? 24 : 16
  const count = Math.floor(data.length / bpt)
  const decode = bpp === 4 ? decode4bpp : bpp === 3 ? decode3bpp : decode2bpp

  const sheet: GfxSheet = []
  for (let t = 0; t < count; t++) {
    sheet.push(decode(data, t * bpt))
  }
  return sheet
}

function _emptySheet(tileCount: number): GfxSheet {
  return Array.from({ length: tileCount }, () => new Uint8Array(PIXELS_PER_TILE))
}

// ── GFX assignment ────────────────────────────────────────────────────────────

/**
 * Read GFX file assignments for a level's tileset and sprite set.
 *
 * @param tilesetId  — GFX tileset index from $05D760[spriteSet]
 * @param spriteSet  — 4-bit sprite set from header byte 2 (bits 3-0)
 */
export function readGfxAssignment(
  rom: RomFile,
  tilesetId: number,
  spriteSet: number,
): Partial<Record<VramSlotName, number>> {
  const fgBuf = rom.readAt(GFX_FGBG_TABLE   + tilesetId * GFX_BYTES_PER_SET, GFX_BYTES_PER_SET)
  const spBuf = rom.readAt(GFX_SPRITE_TABLE  + spriteSet * GFX_BYTES_PER_SET, GFX_BYTES_PER_SET)

  // Reverse load order: byte[3] → VRAM slot 0, byte[2] → slot 1, etc.
  return {
    fg1: fgBuf?.[3] ?? 0,
    fg2: fgBuf?.[2] ?? 0,
    fg3: fgBuf?.[1] ?? 0,
    an1: fgBuf?.[0] ?? 0,
    sp1: spBuf?.[3] ?? 0,
    sp2: spBuf?.[2] ?? 0,
    sp3: spBuf?.[1] ?? 0,
    sp4: spBuf?.[0] ?? 0,
  }
}

/**
 * Load all GFX sheets for the given tileset and sprite set into a VramState.
 * GFX32 and GFX33 (the static tileset) are always loaded into an2/bg1.
 */
export function loadVram(rom: RomFile, tilesetId: number, spriteSet = 0): VramState {
  const assignment = readGfxAssignment(rom, tilesetId, spriteSet)
  const vram: VramState = {}
  for (const slot of VRAM_SLOT_NAMES) {
    const fileIndex = assignment[slot]
    if (fileIndex !== undefined && fileIndex < GFX_FILE_COUNT) {
      vram[slot] = loadGfxFile(rom, fileIndex)
    }
  }
  // Static tileset: GFX32 → chars $200–$27F, GFX33 → chars $280–$2FF
  vram.an2 = loadGfxFile(rom, GFX_STATIC_INDEX)
  vram.bg1 = loadGfxFile(rom, GFX_STATIC_INDEX + 1)
  return vram
}

// ── Char lookup ───────────────────────────────────────────────────────────────

/**
 * Look up the 64 palette indices for a given VRAM character number.
 * Returns null if that char range is not loaded.
 */
export function getCharPixels(vram: VramState, charNum: number): Uint8Array | null {
  for (const slot of VRAM_SLOT_NAMES) {
    const base  = VRAM_CHAR_BASE[slot]
    const sheet = vram[slot]
    if (!sheet) continue
    if (charNum >= base && charNum < base + sheet.length) {
      return sheet[charNum - base] ?? null
    }
  }
  return null
}
