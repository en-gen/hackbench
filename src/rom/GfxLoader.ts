/**
 * GfxLoader.ts -- GFX file loading and VRAM slot assignment for Super Mario World.
 *
 * Derived from SMWDisX disassembly (bank_00.asm):
 *   - GFXFilesLow/High/Bank: lines 6415-6569 (pointer tables, 50 entries each)
 *   - SPRITEGFXLIST: lines 5232-5258 (4 bytes per sprite set)
 *   - OBJECTGFXLIST: lines 5259-5285 (4 bytes per tileset)
 *   - UploadSpriteGFX: lines 5325-5389 (sprite + FG/BG upload routine)
 *   - UploadGFXFile: lines 5401-5478 (per-file upload with 3bpp->4bpp conversion)
 *   - PrepareGraphicsFile: lines 6571-6591 (LC_LZ2 decompression)
 *   - CODE_00A993: lines 5287-5317 (Layer 3 GFX, 2bpp format)
 *   - GfxBppConvertFlag: line 5431 (controls 3bpp->4bpp conversion for GFX01/GFX17)
 *   - DATA_00A9D2/DATA_00A9D6: lines 5320-5323 (VRAM upload addresses)
 *
 * BPP determination:
 *   The game determines BPP by calling context (which upload routine is active).
 *   For our purposes, we infer from decompressed data size:
 *     - 3bpp = 24 bytes/tile (standard ROM format for all vanilla GFX)
 *     - 4bpp = 32 bytes/tile (Lunar Magic export format)
 *     - 2bpp = 16 bytes/tile (Layer 3 GFX: GFX28-GFX2B)
 */

import * as fs from 'fs'
import * as path from 'path'
import { RomFile } from './RomFile'
import { decode4bpp, decode3bpp, decode2bpp, PIXELS_PER_TILE } from './GraphicsDecoder'
import { decompress } from './LcLz2'
import { hex2 } from './hex'

// ── GFX pointer tables (bank_00.asm lines 6415-6569) ──────────────────────────
// Split lo/hi/bank byte tables, one byte per GFX file.
// GFXFilesLow at $00B992, GFXFilesHigh at $00B9C4, GFXFilesBank at $00B9F6.
export const GFX_PTR_LO = 0x00b992 // bank_00.asm line 6415
export const GFX_PTR_HI = 0x00b9c4 // bank_00.asm line 6467
export const GFX_PTR_BANK = 0x00b9f6 // bank_00.asm line 6519

// Number of GFX files = gap between lo and hi tables
// $B9C4 - $B992 = $32 = 50 entries (GFX00-GFX31 hex)
export const GFX_FILE_COUNT = GFX_PTR_HI - GFX_PTR_LO // 50

export const GFX_TILES = 128 // tiles per standard file

// ── Layer 3 GFX (2BPP) - CODE_00A993 (bank_00.asm line 5287) ────────────────
// The Layer 3 upload routine loads a contiguous range of GFX files as raw 2BPP
// (no 3→4bpp conversion). The start index and count are immediate operands:
//   $A99B: LDA #$03   → count-1 (operand at $A99C)
//   $A99F: LDA #$28   → start file index (operand at $A9A0)
const L3_GFX_COUNT_ADDR = 0x00a99c // immediate byte: count - 1
const L3_GFX_START_ADDR = 0x00a9a0 // immediate byte: starting file index

/**
 * Read the Layer 3 GFX file range from CODE_00A993.
 * Returns { start, end } inclusive file indices that should be decoded as 2BPP.
 */
export function getLayer3GfxRange(rom: RomFile): { start: number; end: number } {
  const start = rom.readByte(L3_GFX_START_ADDR) ?? 0x28
  const countMinus1 = rom.readByte(L3_GFX_COUNT_ADDR) ?? 3
  return { start, end: start + countMinus1 }
}

// GFX20 hex (decimal 32) = Mario/Luigi sprites
// bank_00.asm line 5407: LDY #$31 (special world variant)
// bank_00.asm lines 5426-5431: GfxBppConvertFlag set for Y=$01 or Y=$17
export const GFX_MARIO_3BPP_INDEX = 32 // 0x20 hex

// GFX20/GFX21 are static, always loaded into AN2/BG1
// bank_00.asm line 6247-6248: dl GFX33&$7FFFFF / dl GFX32&$7FFFFF
export const GFX_STATIC_INDEX = 32 // GFX20 hex

const GFX_MAX_COMPRESSED = 0x2000

// ── GFX assignment tables (bank_00.asm) ───────────────────────────────────────
// SPRITEGFXLIST at $00A8C3 (line 5232): 4 bytes per sprite set
// OBJECTGFXLIST at $00A92B (line 5259): 4 bytes per tileset
export const GFX_SPRITE_TABLE = 0x00a8c3 // bank_00.asm line 5232
export const GFX_FGBG_TABLE = 0x00a92b // bank_00.asm line 5259
export const GFX_BYTES_PER_SET = 4

// VRAM upload addresses from DATA_00A9D2/DATA_00A9D6 (bank_00.asm lines 5320-5323):
//   Sprite: DATA_00A9D2 = {$78,$70,$68,$60} -- X=3→$6000, X=2→$6800, X=1→$7000, X=0→$7800
//   FG/BG:  DATA_00A9D6 = {$18,$10,$08,$00} -- X=3→$0000, X=2→$0800, X=1→$1000, X=0→$1800
// Upload loop: X from 3→0, _4[X] = reversed table entry.
// Net effect: byte[0]→slot1, byte[1]→slot2, byte[2]→slot3, byte[3]→slot4

/** Named VRAM slots.
 * BG slots (fg1-an1): loaded from OBJECTGFXLIST, chars $000-$1FF
 * OBJ slots (sp1-sp4): loaded from SPRITEGFXLIST, chars $400-$5FF
 * GFX32/33 (Mario + animated) are DMA'd to OBJ space at runtime by MarioGFXDMA.
 */
export const VRAM_SLOT_NAMES = ['sp1', 'sp2', 'sp3', 'sp4', 'fg1', 'fg2', 'fg3', 'an1'] as const
export type VramSlotName = (typeof VRAM_SLOT_NAMES)[number]

/**
 * Character number base for each VRAM slot.
 * BG char space: FG1=$000, FG2=$080, FG3=$100, AN1=$180, AN2=$200, BG1=$280.
 * OBJ char space: SP1-SP4 (separate from BG chars).
 *
 * VRAM addresses from DATA_00A9D6 (bank_00.asm line 5322):
 *   $0000 → FG1 (chars $000-$07F)
 *   $0800 → FG2 (chars $080-$0FF)
 *   $1000 → FG3 (chars $100-$17F)
 *   $1800 → AN1 (chars $180-$1FF)
 * Static: AN2 ($200-$27F), BG1 ($280-$2FF)
 */
// VRAM layout from rammap.asm lines 2286-2306:
//   BG space ($0000-$1FFF): character tiles for Layer 1/2
//     $0000: VRam_GFX_FG1 (2048B = 128 tiles)  - OBJECTGFXLIST byte[0]
//     $0800: VRam_GFX_FG2 (2048B)               - OBJECTGFXLIST byte[1]
//     $1000: VRam_GFX_BG1 (2048B)               - OBJECTGFXLIST byte[2]
//     $1800: VRam_GFX_FG3 (2048B)               - OBJECTGFXLIST byte[3]
//   Tilemaps ($2000-$3FFF): L1+L2 tilemaps (not tile graphics)
//   Layer 3 ($4000-$5FFF): L3 tiles + tilemaps
//   OBJ space ($6000-$7FFF): sprite character tiles
//     $6000: VRam_GFX_SP1 (2048B)  - SPRITEGFXLIST byte[0]
//     $6800: VRam_GFX_SP2 (2048B)  - SPRITEGFXLIST byte[1]
//     $7000: VRam_GFX_SP3 (2048B)  - SPRITEGFXLIST byte[2]
//     $7800: VRam_GFX_SP4 (2048B)  - SPRITEGFXLIST byte[3]
//   MarioGFXDMA (bank_00.asm line 4580): GFX32 → VRAM $6000 (overlaps SP1/SP2)
//
// BG char number = VRAM word address / 16 (each 4bpp tile = 16 words = 32 bytes)
// OBJ char number = (VRAM word address - OBJ base) / 16
//   OBJ base set by HW_OBSEL (bank_00.asm line 45): VRam_OBJTiles>>13 = $6000>>13 = 3
//   So OBJ char 0 = VRAM $6000, OBJ char 128 = VRAM $6800, etc.
//
// For the tile VIEWER we use a flat char space matching LM's 8x8 editor:
//   Pages 0x00-0x01: BG chars $000-$1FF (VRAM $0000-$1FFF)
//   Pages 0x02-0x03: Tilemaps (blank in tile viewer)
//   Pages 0x04-0x05: OBJ chars (VRAM $6000-$7FFF, displayed as chars $400-$5FF)
export const VRAM_CHAR_BASE: Record<VramSlotName, number> = {
  fg1: 0x000, // VRAM $0000 - BG char $000-$07F
  fg2: 0x080, // VRAM $0800 - BG char $080-$0FF
  fg3: 0x100, // VRAM $1000 - BG char $100-$17F (rammap: VRam_GFX_BG1)
  an1: 0x180, // VRAM $1800 - BG char $180-$1FF (rammap: VRam_GFX_FG3)
  sp1: 0x400, // VRAM $6000 - OBJ char $400-$47F (viewer page 0x04)
  sp2: 0x480, // VRAM $6800 - OBJ char $480-$4FF
  sp3: 0x500, // VRAM $7000 - OBJ char $500-$57F
  sp4: 0x580, // VRAM $7800 - OBJ char $580-$5FF
}

/** Decoded GFX sheet: N tiles x 64 palette indices each. */
export type GfxSheet = Uint8Array[]

/** VRAM contents: slot name → decoded GFX sheet. */
export type VramState = Partial<Record<VramSlotName, GfxSheet>>

// ── Lunar Magic exported Graphics/ folder ────────────────────────────────────

export function getGfxBinDir(rom: RomFile): string | null {
  const dir = path.join(path.dirname(rom.filePath), 'Graphics')
  return fs.existsSync(dir) ? dir : null
}

export function gfxBinPath(binDir: string, fileIndex: number): string {
  return path.join(binDir, `GFX${hex2(fileIndex)}.bin`)
}

export function loadGfxFileBin(binDir: string, fileIndex: number): GfxSheet | null {
  const p = gfxBinPath(binDir, fileIndex)
  if (!fs.existsSync(p)) return null
  let data: Buffer
  try {
    data = fs.readFileSync(p)
  } catch {
    return null
  }
  if (data.length === 0 || data.length % 32 !== 0) return null
  const count = data.length / 32
  const sheet: GfxSheet = []
  for (let t = 0; t < count; t++) {
    sheet.push(decode4bpp(data, t * 32))
  }
  return sheet
}

// ── Core loader ──────────────────────────────────────────────────────────────

/**
 * Read the SNES address of a GFX file from the pointer tables.
 * PrepareGraphicsFile (bank_00.asm lines 6571-6591):
 *   LDA GFXFilesLow,Y / LDA GFXFilesHigh,Y / LDA GFXFilesBank,Y
 */
function getGfxFileAddress(rom: RomFile, fileIndex: number): number | null {
  if (fileIndex >= GFX_FILE_COUNT) return null
  const lo = rom.readByte(GFX_PTR_LO + fileIndex)
  const hi = rom.readByte(GFX_PTR_HI + fileIndex)
  const bank = rom.readByte(GFX_PTR_BANK + fileIndex)
  if (lo === null || hi === null || bank === null) return null
  return (bank << 16) | (hi << 8) | lo
}

/**
 * Read a single GFX file as raw decompressed bytes.
 * Returns the LC_LZ2 decompressed data.
 */
export function loadGfxRaw(rom: RomFile, fileIndex: number): Uint8Array {
  const addr = getGfxFileAddress(rom, fileIndex)
  if (addr === null) return new Uint8Array(0)
  const compressed = rom.readAt(addr, GFX_MAX_COMPRESSED)
  if (!compressed) return new Uint8Array(0)
  return decompress(compressed)
}

/**
 * Load and decode a single GFX file by index.
 *
 * BPP inference from decompressed size:
 *   - Check 3bpp first (24 bytes/tile): standard ROM format
 *     3072 bytes = 128 tiles x 24 = 3bpp (would wrongly match 32 since 3072/32=96)
 *   - Then 2bpp (16 bytes/tile): Layer 3 GFX (GFX28-GFX2B)
 *     2048 bytes = 128 tiles x 16 = 2bpp
 *   - Then 4bpp (32 bytes/tile): LM exports or hacks
 *
 * The game uses calling context to determine BPP:
 *   - CODE_00A993: Layer 3 files → 2BPP (file range read from ROM)
 *   - UploadGFXFile: all others → 3BPP (with 3→4 conversion to VRAM)
 * We read the L3 file range from CODE_00A993 operands, then fall back
 * to size-based inference for non-L3 files.
 */
export function loadGfxFile(rom: RomFile, fileIndex: number): GfxSheet {
  if (fileIndex >= GFX_FILE_COUNT) return _emptySheet(GFX_TILES)

  const data = loadGfxRaw(rom, fileIndex)
  if (data.length === 0) return _emptySheet(GFX_TILES)

  // Layer 3 files are always 2BPP - range read from CODE_00A993 operands
  const l3 = getLayer3GfxRange(rom)
  if (fileIndex >= l3.start && fileIndex <= l3.end && data.length % 16 === 0) {
    const count = data.length / 16
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode2bpp(data, t * 16))
    return sheet
  }

  // Check 3bpp BEFORE 4bpp (3072 is divisible by both 24 and 32)
  if (data.length % 24 === 0 && data.length % 32 !== 0) {
    const count = data.length / 24
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode3bpp(data, t * 24))
    return sheet
  }
  // Standard: could be either 3bpp or 4bpp when divisible by both
  if (data.length % 24 === 0) {
    // Prefer 3bpp for ROM data (all vanilla SMW GFX are 3bpp in ROM)
    const count = data.length / 24
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode3bpp(data, t * 24))
    return sheet
  }
  if (data.length % 32 === 0) {
    const count = data.length / 32
    const sheet: GfxSheet = []
    for (let t = 0; t < count; t++) sheet.push(decode4bpp(data, t * 32))
    return sheet
  }

  return _emptySheet(GFX_TILES)
}

function _emptySheet(tileCount: number): GfxSheet {
  return Array.from({ length: tileCount }, () => new Uint8Array(PIXELS_PER_TILE))
}

// ── GFX assignment ──────────────────────────────────────────────────────────

/**
 * Read GFX file assignments for a level's tileset and sprite set.
 *
 * From UploadSpriteGFX (bank_00.asm lines 5325-5389):
 *   Sprite GFX: SPRITEGFXLIST + spriteSet*4, bytes [0..3] = SP1,SP2,SP3,SP4
 *     (reverse-loaded into scratch, then uploaded X=3→0 with VRAM $6000,$6800,$7000,$7800)
 *   FG/BG GFX:  OBJECTGFXLIST + tileset*4, bytes [0..3] = FG1,FG2,FG3,AN1
 *     (same reverse-load, uploaded X=3→0 with VRAM $0000,$0800,$1000,$1800)
 *
 * @param tilesetId  Object tileset index (from level header byte 4 bits 3-0)
 * @param spriteSet  Sprite tileset (from level header byte 2 bits 3-0)
 */
export function readGfxAssignment(
  rom: RomFile,
  tilesetId: number,
  spriteSet: number,
): Partial<Record<VramSlotName, number>> {
  const fgBuf = rom.readAt(GFX_FGBG_TABLE + tilesetId * GFX_BYTES_PER_SET, GFX_BYTES_PER_SET)
  const spBuf = rom.readAt(GFX_SPRITE_TABLE + spriteSet * GFX_BYTES_PER_SET, GFX_BYTES_PER_SET)

  // UploadSpriteGFX (bank_00.asm lines 5360-5389):
  //   Load loop (lines 5360-5369):
  //     LDX #$03; - LDA OBJECTGFXLIST,Y; STA _4,X; INY; DEX; BPL -
  //     → _4[3]=byte[0], _4[2]=byte[1], _4[1]=byte[2], _4[0]=byte[3]
  //   Upload loop (lines 5372-5383):
  //     X from 3→0; VRAM = DATA_00A9D6[X]; file = _4[X]
  //     DATA_00A9D6 = {$18,$10,$08,$00} (indexed, not iterated)
  //     X=3: VRAM=DATA_00A9D6[3]=$00, file=_4[3]=byte[0] → byte[0] → VRAM $0000
  //     X=2: VRAM=DATA_00A9D6[2]=$08, file=_4[2]=byte[1] → byte[1] → VRAM $0800
  //     X=1: VRAM=DATA_00A9D6[1]=$10, file=_4[1]=byte[2] → byte[2] → VRAM $1000
  //     X=0: VRAM=DATA_00A9D6[0]=$18, file=_4[0]=byte[3] → byte[3] → VRAM $1800
  //   Two reverses cancel out → FORWARD order: byte[0]→FG1, byte[1]→FG2, etc.
  //   Same for sprites with DATA_00A9D2 = {$78,$70,$68,$60}
  return {
    fg1: fgBuf?.[0] ?? 0, // byte[0] → VRAM $0000 (FG1)
    fg2: fgBuf?.[1] ?? 0, // byte[1] → VRAM $0800 (FG2)
    fg3: fgBuf?.[2] ?? 0, // byte[2] → VRAM $1000 (FG3)
    an1: fgBuf?.[3] ?? 0, // byte[3] → VRAM $1800 (AN1)
    sp1: spBuf?.[0] ?? 0, // byte[0] → VRAM $6000 (SP1)
    sp2: spBuf?.[1] ?? 0, // byte[1] → VRAM $6800 (SP2)
    sp3: spBuf?.[2] ?? 0, // byte[2] → VRAM $7000 (SP3)
    sp4: spBuf?.[3] ?? 0, // byte[3] → VRAM $7800 (SP4)
  }
}

// ── FilterSomeRAM upload variant (bank_00.asm:5480) ─────────────────────────
//
// `UploadGFXFile` (bank_00.asm:5401-5478) is the standard GFX upload path:
// it reads 24 bytes per tile (3bpp source) and writes 32 bytes per tile to
// VRAM (4bpp destination). For most files the 4th bitplane is forced to
// zero (per-tile mask `_A = $0000`), so non-zero pixel values stay in the
// 1..7 range.
//
// For specific file indices, `UploadGFXFile` jumps to `FilterSomeRAM`
// (bank_00.asm:5480-5513) instead. FilterSomeRAM is the same 3→4bpp loop
// but writes plane 3 = `plane0_byte | plane1_byte | plane2_byte` per row
// (the first half of the loop builds the OR into `GfxBppConvertBuffer`,
// the second half OR's it into the plane-3 byte). Per-pixel that's:
//
//     plane3 bit = plane0 bit | plane1 bit | plane2 bit
//     pixel value 0  → 0
//     pixel value V  → V | 8     (for V in 1..7)
//
// Trigger conditions in `UploadGFXFile` (bank_00.asm:5412-5422):
//   - `Y = $1E`                      → FilterSomeRAM (always)
//   - `Y = $08` AND ObjectTileset≥$11 → FilterSomeRAM (overworld tilesets)
//
// In vanilla SMW the trigger never fires for level loads (level
// ObjectTileset is 0..15) and always fires for the AN1 slot in OW (file
// `$1E`) and the FG3 slot in OW (file `$08`, since OW ObjectTileset is
// `$11`-`$17`). A hack that swaps either file index into a level slot or
// promotes a level tileset to ≥$11 would re-trigger the path on hardware
// - and this emulation flows through automatically because we read the
// file index out of `OBJECTGFXLIST` and the tileset out of the level
// header / `DATA_04DC02`.

/**
 * Does this `(fileIndex, objectTileset)` pair take the FilterSomeRAM
 * upload path on hardware? See the block comment above for the asm
 * trigger conditions.
 */
export function isFilterSomeRamFile(fileIndex: number, objectTileset: number): boolean {
  if (fileIndex === 0x1e) return true
  if (fileIndex === 0x08 && objectTileset >= 0x11) return true
  return false
}

/**
 * Apply the FilterSomeRAM plane-3 OR transform to a decoded GFX sheet:
 * non-zero pixels gain plane 3 = 1, zero pixels stay zero. This
 * reproduces the VRAM state the upload routine actually writes, so a
 * 4bpp-mode renderer (matching what Mesen reads from VRAM) sees pixel
 * values 0/9-15 instead of the 0-7 range our raw 3bpp decode produces.
 */
export function applyFilterSomeRamTransform(sheet: GfxSheet): GfxSheet {
  return sheet.map(tile => {
    const out = new Uint8Array(tile.length)
    for (let i = 0; i < tile.length; i++) {
      out[i] = tile[i] === 0 ? 0 : tile[i] | 0x08
    }
    return out
  })
}

/**
 * Load all GFX sheets for the given tileset and sprite set into a VramState.
 *
 * Files that take the `FilterSomeRAM` upload path on hardware (see
 * {@link isFilterSomeRamFile}) get the plane-3 OR transform applied
 * after decode so the in-memory pixel values match what the SNES sees
 * in VRAM. Both level loads and the overworld viewer share this
 * loader, so the level path is automatically protected if a hack
 * routes a FilterSomeRAM file (`$08`/`$1E`) into a level slot or
 * promotes a level tileset to `$11+`.
 *
 * Static tileset: GFX20 → AN2 (chars $200-$27F), GFX21 → BG1 (chars $280-$2FF)
 * (bank_00.asm lines 6247-6248: GFX33 then GFX32 loaded at CODE_00B888)
 */
export function loadVram(rom: RomFile, tilesetId: number, spriteSet = 0): VramState {
  const assignment = readGfxAssignment(rom, tilesetId, spriteSet)
  const vram: VramState = {}
  for (const slot of VRAM_SLOT_NAMES) {
    const fileIndex = assignment[slot]
    if (fileIndex !== undefined && fileIndex < GFX_FILE_COUNT) {
      let sheet = loadGfxFile(rom, fileIndex)
      if (isFilterSomeRamFile(fileIndex, tilesetId)) {
        sheet = applyFilterSomeRamTransform(sheet)
      }
      vram[slot] = sheet
    }
  }
  // GFX32 (Mario) and GFX33 (animated base) are loaded into OBJ VRAM $6000+
  // by MarioGFXDMA (bank_00.asm line 4580), not into BG char space.
  // They overlap with SP1/SP2 in the OBJ tile region.
  // For now we don't load them separately - the sprite slots already cover that range.
  return vram
}

// ── Char lookup ─────────────────────────────────────────────────────────────

/**
 * Look up the 64 palette indices for a given VRAM character number.
 */
export function getCharPixels(vram: VramState, charNum: number): Uint8Array | null {
  for (const slot of VRAM_SLOT_NAMES) {
    const base = VRAM_CHAR_BASE[slot]
    const sheet = vram[slot]
    if (!sheet) continue
    if (charNum >= base && charNum < base + sheet.length) {
      return sheet[charNum - base] ?? null
    }
  }
  return null
}

// ── Layer 3 char loading ─────────────────────────────────────────────────────

/**
 * Load L3 GFX chars (GFX28–GFX2B, 2BPP) into a flat 4-element array.
 *
 * Char index n (bits [9:0] of an L3 tilemap entry) maps to:
 *   file  = n >> 7   (0=GFX28, 1=GFX29, 2=GFX2A, 3=GFX2B)
 *   local = n & 0x7F (tile within that file)
 *
 * CODE_00A993 uploads these 4 files to VRAM word $4000 (VRam_L3Tiles).
 * Each 2BPP char is 8 words; 128 chars × 4 files = 512 chars total.
 */
export function loadL3Chars(rom: RomFile): GfxSheet[] {
  const { start, end } = getLayer3GfxRange(rom)
  const sheets: GfxSheet[] = []
  for (let i = start; i <= end; i++) {
    sheets.push(loadGfxFile(rom, i))
  }
  return sheets
}
