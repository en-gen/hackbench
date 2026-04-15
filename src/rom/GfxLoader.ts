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

import * as fs from 'fs'
import * as path from 'path'
import { RomFile } from './RomFile'
import { decode4bpp, decode3bpp, PIXELS_PER_TILE } from './GraphicsDecoder'
import { decompress } from './LcLz2'

// ── GFX pointer tables (split lo/hi/bank, one byte per GFX file) ──────────────
export const GFX_PTR_LO   = 0x00B992
export const GFX_PTR_HI   = 0x00B9C4
export const GFX_PTR_BANK = 0x00B9F6

// ── Counts and sizes ──────────────────────────────────────────────────────────
// The lo, hi, and bank pointer tables are stored contiguously with one byte per
// GFX file. The number of files in the lo table is therefore the gap between the
// lo and hi table start addresses — no separate count byte exists in ROM.
// ($B9C4 - $B992 = $32 = 50 entries in vanilla SMW.)
export const GFX_FILE_COUNT = GFX_PTR_HI - GFX_PTR_LO

// Actual formats:
//
//   ROM storage: 3bpp SNES planar format (24 bytes/tile).
//     Standard files: 128 tiles × 24 bytes = 3072 bytes (LC_LZ2 decompressed).
//
//   Lunar Magic exports GFX files to <romdir>/Graphics/GFX<HEX>.bin.
//   LM converts 3bpp→4bpp: adds a zero 4th bitplane (16 bytes/tile → 32 bytes/tile).
//     Exported .bin files: 128 tiles × 32 bytes = 4096 bytes (4bpp, zero plane 3).
//
//   Mesen VRAM viewer shows 4bpp because the SNES renders everything as 4bpp;
//   the zero 4th bitplane just means the top color bit is always 0 (palette indices 0–7).
//
//   LM extended GFX32.bin: 23808 bytes = 744 tiles × 32 B (4bpp export)
//   LM extended GFX33.bin: 12288 bytes = 384 tiles × 32 B (4bpp export)
export const GFX_TILES      = 128  // tiles per standard file
export const GFX_TILES_3BPP = 128  // kept for compatibility

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

// ── Lunar Magic exported Graphics/ folder ─────────────────────────────────────

/**
 * Return the path to the Lunar Magic Graphics export directory adjacent to the ROM,
 * or null if it does not exist.
 *   <romdir>/Graphics/
 */
export function getGfxBinDir(rom: RomFile): string | null {
  const dir = path.join(path.dirname(rom.filePath), 'Graphics')
  return fs.existsSync(dir) ? dir : null
}

/**
 * Path of a single exported .bin file for the given file index (0–51 decimal).
 * Lunar Magic names them GFX<HEX>.bin  (e.g. index 0 → GFX00.bin, index 50 → GFX32.bin).
 */
export function gfxBinPath(binDir: string, fileIndex: number): string {
  const hex = fileIndex.toString(16).toUpperCase().padStart(2, '0')
  return path.join(binDir, `GFX${hex}.bin`)
}

/**
 * Load a GFX sheet directly from a Lunar Magic exported .bin file.
 * Files are raw 4bpp SNES planar data — no decompression needed.
 * Returns null if the file does not exist or cannot be read.
 */
export function loadGfxFileBin(binDir: string, fileIndex: number): GfxSheet | null {
  const p = gfxBinPath(binDir, fileIndex)
  if (!fs.existsSync(p)) return null
  let data: Buffer
  try { data = fs.readFileSync(p) } catch { return null }
  if (data.length === 0 || data.length % 32 !== 0) return null
  const count = data.length / 32
  const sheet: GfxSheet = []
  for (let t = 0; t < count; t++) {
    sheet.push(decode4bpp(data, t * 32))
  }
  return sheet
}

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
 * Read a single GFX file as raw bytes (4bpp SNES planar).
 * Prefers the Lunar Magic exported .bin file; falls back to ROM decompression.
 * Useful for client-side re-decoding or inspection.
 * Returns an empty Uint8Array if neither source yields data.
 */
export function loadGfxRaw(rom: RomFile, fileIndex: number): Uint8Array {
  if (fileIndex >= GFX_FILE_COUNT) return new Uint8Array(0)
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
 * Load and decode a single GFX file by its index (0–51 decimal).
 *
 * Preferred path: load from Lunar Magic's exported Graphics/<romdir>/GFX<HEX>.bin.
 * These are raw 4bpp SNES planar data confirmed correct by Mesen VRAM viewer.
 *
 * Fallback path: read from ROM pointer table and LC_LZ2 decompress.
 * The fallback always decodes as 4bpp (all SMW GFX are 4bpp in VRAM).
 *
 * Returns an empty fallback sheet if neither source yields data.
 */
export function loadGfxFile(rom: RomFile, fileIndex: number): GfxSheet {
  // ROM-only: read from the pointer table and LC_LZ2 decompress.
  // bpp is inferred from the decompressed tile stride:
  //   32 bytes/tile → 4bpp  (all vanilla SMW GFX confirmed via Mesen + LM exports)
  //   24 bytes/tile → 3bpp  (fallback for hacks / future use)
  if (fileIndex >= GFX_FILE_COUNT) return _emptySheet(GFX_TILES)

  const lo   = rom.readByte(GFX_PTR_LO   + fileIndex)
  const hi   = rom.readByte(GFX_PTR_HI   + fileIndex)
  const bank = rom.readByte(GFX_PTR_BANK + fileIndex)
  if (lo === null || hi === null || bank === null) return _emptySheet(GFX_TILES)

  const snesAddr = (bank << 16) | (hi << 8) | lo
  const compressed = rom.readAt(snesAddr, GFX_MAX_COMPRESSED)
  if (!compressed) return _emptySheet(GFX_TILES)

  const data = decompress(compressed)
  if (data.length === 0) return _emptySheet(GFX_TILES)

  // ⚠ Check 3bpp (24 bytes/tile) BEFORE 4bpp (32 bytes/tile).
  // ROM stores GFX as 3bpp: 128 tiles × 24 bytes = 3072 bytes.
  // 3072 is divisible by BOTH 24 (→ 128 tiles, correct) and 32 (→ 96 tiles, wrong),
  // so checking 32 first would misidentify 3bpp data as 4bpp.
  // Lunar Magic exports convert 3bpp→4bpp (32 bytes/tile, zero 4th bitplane),
  // so genuine 4bpp data will be 4096 bytes (4096 % 24 ≠ 0 → falls through to check 32).
  if (data.length % 24 === 0) {
    // 3bpp: 24 bytes per tile (standard ROM format for all vanilla SMW GFX files)
    const count = data.length / 24
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode3bpp(data, t * 24))
    return sheet
  }
  if (data.length % 32 === 0) {
    // 4bpp: 32 bytes per tile (Lunar Magic export format, or hacks)
    const count = data.length / 32
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode4bpp(data, t * 32))
    return sheet
  }
  // Unrecognised stride — return empty
  return _emptySheet(GFX_TILES)
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

  // Natural byte order: byte[0] → FG1, byte[1] → FG2, byte[2] → FG3, byte[3] → AN1.
  // Verified via VRAM dump for level $104: byte[0] content appears at chars $000–$07F (FG1).
  // Previous "reverse order" comment was WRONG; empirical VRAM analysis shows byte[0]=FG1.
  return {
    fg1: fgBuf?.[0] ?? 0,
    fg2: fgBuf?.[1] ?? 0,
    fg3: fgBuf?.[2] ?? 0,
    an1: fgBuf?.[3] ?? 0,
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
