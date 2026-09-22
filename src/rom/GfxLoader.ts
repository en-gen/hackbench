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
 *   - LoadCredits: lines 2463-2479 (credits letters, 2bpp format)
 *   - GfxBppConvertFlag: line 5431 (controls 3bpp->4bpp conversion for GFX01/GFX17)
 *   - DATA_00A9D2/DATA_00A9D6: lines 5320-5323 (VRAM upload addresses)
 *
 * BPP determination:
 *   The game determines BPP by calling context (which upload routine is active).
 *   For our purposes, we infer from decompressed data size:
 *     - 3bpp = 24 bytes/tile (standard ROM format for all vanilla GFX)
 *     - 4bpp = 32 bytes/tile (Lunar Magic export format)
 *     - 2bpp = 16 bytes/tile (Layer 3 GFX, and the credits letters)
 */

import * as fs from 'fs'
import * as path from 'path'
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { decodeTilesBatch, PIXELS_PER_TILE } from './GraphicsDecoder'
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

// ── Credits-letters GFX (2BPP) - LoadCredits (bank_00.asm lines 2463-2479) ──
// LoadCredits decompresses one GFX file and copies it word-for-word into BG3
// character space with no 3→4bpp expansion, the same shape as CODE_00A993.
// BG3 characters are 2BPP, so that file is 2BPP - size inference alone calls
// the vanilla $400 bytes 4BPP because they divide evenly by 32.
//
// Matched as a byte pattern so a relocated routine still resolves, with the
// file index, VRAM destination and word count read from their operands. Two
// matches, a missing BG3 base, or a destination outside BG3 character space
// all mean we cannot say which file is 2BPP, and we say nothing rather than
// fall back to the vanilla $2F. The pattern pins the copy loop and its branch
// displacement, so a hack that rewrites LoadCredits to mean the same thing by
// other instructions scores zero matches and turns the 2BPP reading off. That
// is the intended direction to fail in: the file then renders under size
// inference, as it did before this resolver existed.
const LOAD_CREDITS_PATTERN: BytePattern = [
  0xa0,
  WILD, // LDY #fileIndex
  0x22,
  WILD,
  WILD,
  WILD, // JSL PrepareGraphicsFile
  0xa9,
  0x80,
  0x8d,
  0x15,
  0x21, // LDA #$80 / STA HW_VMAINC
  0xc2,
  0x30, // REP #$30
  0xa9,
  WILD,
  WILD, // LDA #VRam_CreditsLetters
  0x8d,
  0x16,
  0x21, // STA HW_VMADD
  0xa2,
  WILD,
  WILD, // LDX #decompressedSize/2
  0xa7,
  0x00, // LDA [GraphicsCompPtr]
  0x8d,
  0x18,
  0x21, // STA HW_VMDATA
  0xe6,
  0x00,
  0xe6,
  0x00, // INC / INC
  0xca,
  0xd0,
  0xf4, // DEX / BNE -
]
const CREDITS_FILE_INDEX_OFF = 1
const CREDITS_VRAM_DEST_OFF = 14
const CREDITS_WORD_COUNT_OFF = 20

// HW_BG34NBA ($00210C) bits 0-3 hold the BG3 character base in $1000-word
// steps (hardware_registers.asm lines 155-163). SMW writes it as an immediate
// (bank_00.asm lines 1276-1277); $04 puts BG3 characters at word $4000.
const BG34NBA_PATTERN: BytePattern = [0xa9, WILD, 0x8d, 0x0c, 0x21]
const BG3_CHAR_BASE_STEP = 0x1000 // words per nibble step
const BG3_CHAR_WINDOW = 0x2000 // words: 1024 characters x 8 words
const WORDS_PER_2BPP_CHAR = 8

const BYTES_PER_2BPP_TILE = 16
const BYTES_PER_3BPP_TILE = 24
const BYTES_PER_4BPP_TILE = 32

/** Where LoadCredits sends one GFX file, as read from its operands. */
export interface CreditsGfxFile {
  /** GFX file index from the LDY immediate. */
  fileIndex: number
  /** Decompressed length: the LDX word count x 2. Kept as the self-check
   *  that the copy is a whole number of 2BPP characters. */
  byteLength: number
}

// Two full-buffer scans per call, and loadVram resolves eight slots per level
// load. Keyed on RomFile.version, which every writeAt bumps - a write made
// directly through RomFile.buffer would not (see RomFile.ts), so patch paths
// must build a new RomFile rather than mutate one in place, which is what
// MapEditorProvider and EditSession already do.
const _creditsCache = new WeakMap<RomFile, { version: number; result: CreditsGfxFile | null }>()

/** The BG3 character base nibble written at one $210C site, or null if the
 *  operand is somehow unreadable. */
function readBg34nbaNibble(rom: RomFile, at: number): number | null {
  const operand = rom.readAtFileOffset(at + 1, 1)
  return operand ? operand[0]! & 0x0f : null
}

/** BG3 character base in VRAM words, or null if the $210C writes are absent
 *  or disagree - either way we cannot place the credits copy. Every site is
 *  checked, not just the first, so `findPattern` runs uncapped here. */
function readBg3CharBase(rom: RomFile): number | null {
  const hits = findPattern(rom, BG34NBA_PATTERN)
  if (hits.length === 0) return null
  const nibble = readBg34nbaNibble(rom, hits[0]!)
  if (nibble === null) return null
  for (const at of hits) {
    if (readBg34nbaNibble(rom, at) !== nibble) return null
  }
  return nibble * BG3_CHAR_BASE_STEP
}

/** Resolve the credits-letters GFX file, or null when the ROM does not say. */
export function findCreditsGfxFile(rom: RomFile): CreditsGfxFile | null {
  const cached = _creditsCache.get(rom)
  if (cached && cached.version === rom.version) return cached.result
  const result = _findCreditsGfxFile(rom)
  _creditsCache.set(rom, { version: rom.version, result })
  return result
}

function _findCreditsGfxFile(rom: RomFile): CreditsGfxFile | null {
  const hits = findPattern(rom, LOAD_CREDITS_PATTERN)
  if (hits.length !== 1) return null // 0 = replaced, >1 = which one runs?

  // A match guarantees the whole run is in range, so the three operands all
  // come out of one read of the matched site.
  const site = rom.readAtFileOffset(hits[0]!, LOAD_CREDITS_PATTERN.length)
  if (!site) return null
  const read16 = (off: number): number => site[off]! | (site[off + 1]! << 8)
  const fileIndex = site[CREDITS_FILE_INDEX_OFF]!
  const vramDest = read16(CREDITS_VRAM_DEST_OFF)
  const byteLength = read16(CREDITS_WORD_COUNT_OFF) * 2

  const bg3Base = readBg3CharBase(rom)
  if (bg3Base === null) return null

  // Outside BG3 character space the copy is not BG3 characters at all, and
  // a destination that lands mid-character means the routine is doing
  // something other than what we read it as. Either way, refuse.
  const offsetWords = vramDest - bg3Base
  if (offsetWords < 0 || offsetWords >= BG3_CHAR_WINDOW) return null
  if (offsetWords % WORDS_PER_2BPP_CHAR !== 0) return null
  if (byteLength === 0 || byteLength % BYTES_PER_2BPP_TILE !== 0) return null
  if (fileIndex >= GFX_FILE_COUNT) return null

  return { fileIndex, byteLength }
}

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
  if (data.length === 0 || data.length % BYTES_PER_4BPP_TILE !== 0) return null
  return decodeTilesBatch(data, 4)
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
 * BPP for one GFX file.
 *
 * The game picks BPP by calling context, so we resolve the two routines that
 * upload a file verbatim - CODE_00A993 for Layer 3 and LoadCredits for the
 * credits letters - and treat everything else the way UploadGFXFile does,
 * as 3BPP, falling back to 4BPP for the LM export format. Size alone cannot
 * separate 2BPP from 4BPP: both divide 1024.
 *
 * Returns null when the length fits no tile size.
 */
export function inferGfxBpp(rom: RomFile, fileIndex: number, byteLength: number): 2 | 3 | 4 | null {
  if (byteLength === 0) return null

  const l3 = getLayer3GfxRange(rom)
  const credits = findCreditsGfxFile(rom)
  const isRawUpload =
    (fileIndex >= l3.start && fileIndex <= l3.end) || credits?.fileIndex === fileIndex
  if (isRawUpload && byteLength % BYTES_PER_2BPP_TILE === 0) return 2

  // 3BPP first: 3072 divides by 32 as well, and ROM data is 3BPP.
  if (byteLength % BYTES_PER_3BPP_TILE === 0) return 3
  if (byteLength % BYTES_PER_4BPP_TILE === 0) return 4
  return null
}

/** Load and decode a single GFX file by index. */
export function loadGfxFile(rom: RomFile, fileIndex: number): GfxSheet {
  if (fileIndex >= GFX_FILE_COUNT) return _emptySheet(GFX_TILES)

  const data = loadGfxRaw(rom, fileIndex)
  const bpp = inferGfxBpp(rom, fileIndex, data.length)
  if (bpp === null) return _emptySheet(GFX_TILES)
  return decodeTilesBatch(data, bpp)
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
