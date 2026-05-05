/**
 * OverworldLoader.ts -- Super Mario World overworld map parser.
 *
 * All loader functions read directly from the ROM. The only "constants" are
 * SNES base addresses for the overworld pointer/data tables; every byte the
 * renderer consumes is decoded out of those addresses, so a hacker who edits
 * the underlying ROM data will see their changes reflected here.
 *
 * Derived from SMWDisX (see C:\Projects\SMWDisX\bank_04\MEMO.md and
 * C:\Projects\SMWDisX\bank_00\MEMO.md):
 *   - SetUpScreen:           bank_00.asm:1268      BG1/2/3 = 64x64 mode
 *   - GM0CLoadOverworld:     bank_00.asm:4250      game-mode-12 dispatcher
 *   - DecompressOverworldL2: bank_04.asm:5440      drives CODE_04DC6A
 *   - CODE_04DC6A:           bank_04.asm:5683      twin-stream RLE driver
 *   - CODE_04DABA:           bank_04.asm:5452      RLE inner loop
 *   - CODE_04DC09:           bank_04.asm:5637      L1 Map16 build
 *   - CODE_04E4D0:           bank_04.asm:6131      paints L2 with 64x64-BG quadrant jumps
 *   - DATA_04DC02:           bank_04.asm:5634      per-area object tileset (7 bytes)
 *   - DATA_00A06B:           bank_00.asm:4242      per-area camera X words (7 entries)
 *   - DATA_00A079:           bank_00.asm:4246      per-area camera Y words (7 entries)
 *   - DATA_00AD1E:           bank_00.asm:5733      per-area palette index (7 bytes)
 *   - OverworldColors:       SNES $00B3D8          normal palette set, 6 blocks of 48 bytes
 *   - OWSpecialColors:       SNES $00B732          post-special-world palette set
 *   - DATA_04849D:           bank_04.asm:509       warp X words (27 entries; bits 0-8 = X,
 *                                                  bits 9-12 = destination submap)
 *   - DATA_0484D3:           bank_04.asm:518       warp Y words (27 entries)
 *   - CODE_04853B:           bank_04.asm:554       warp decode (the routine this mirrors)
 *
 * BG geometry (verified):
 *   Both layers use 64x64 SNES tilemaps. The decompressed L2 staging buffer
 *   `OWLayer2Tilemap` ($4000 bytes) holds two such layouts (0 and 1) using
 *   standard SNES 4-screen quadrant memory order:
 *
 *      offset within layout    contents
 *      $0000-$07FF             screen 0 (TL)  — rows  0-31, cols  0-31
 *      $0800-$0FFF             screen 1 (TR)  — rows  0-31, cols 32-63
 *      $1000-$17FF             screen 2 (BL)  — rows 32-63, cols  0-31
 *      $1800-$1FFF             screen 3 (BR)  — rows 32-63, cols 32-63
 *
 *   Layout 0 = bytes $0000-$1FFF; layout 1 = bytes $2000-$3FFF. Within each
 *   32x32 quadrant the row stride is $40 bytes (32 cols x 2 bytes per word).
 */

import { RomFile } from './RomFile'
import { bgr555ToRgba, RgbaColor } from './GraphicsDecoder'
import type { RgbaRow } from './PaletteLoader'

// ── ROM addresses (the only "constants" — all data is read through them) ─────

export const OW_ADDR = {
  /** OWTileNumbers: low-byte RLE stream of L2 tilemap (bank_04.asm:3567). */
  L2_STREAM_LO:    0x04A533,
  /** OWTilemap: high-byte RLE stream of L2 tilemap (bank_04.asm:4433). */
  L2_STREAM_HI:    0x04C02B,
  /** OWL1CharData: 512 Map16 character entries x 8 bytes (bank_05.asm:6820). */
  L1_CHARDATA:     0x05D000,
  /** OWL1TileData: $800 raw bytes of L1 Map16 indices (bank_0C.asm:7850). */
  L1_TILEDATA:     0x0CF7DF,
  /** DATA_00A06B: 7 signed-word per-area camera X positions (bank_00.asm:4242). */
  CAMERA_X_TABLE:  0x00A06B,
  /** DATA_00A079: 7 signed-word per-area camera Y positions (bank_00.asm:4246). */
  CAMERA_Y_TABLE:  0x00A079,
  /** DATA_04DC02: 7 bytes — ObjectTileset per area (bank_04.asm:5634). */
  OBJ_TILESET_TBL: 0x04DC02,
  /** DATA_00AD1E: 7 bytes — palette block index per area (bank_00.asm:5733). */
  PALETTE_INDEX_TABLE: 0x00AD1E,
  /** OverworldColors: 7 normal palette blocks indexed via DATA_00ABDF
   *  (variable stride; outermost block is 56 bytes / 28 colors). */
  PALETTE_NORMAL_BASE: 0x00B3D8,
  /** OWSpecialColors: 7 post-special-world palette blocks (same stride). */
  PALETTE_SPECIAL_BASE: 0x00B732,
  /** DATA_00ABDF: 7 word offsets into OverworldColors per palette index
   *  (`bank_00.asm:5591`). */
  PALETTE_BLOCK_OFFSETS: 0x00ABDF,
  /** OWStdColors: 42 colors → CGRAM rows 2-7, cols 9-15. Area-INDEPENDENT.
   *  Loaded by `CODE_00AD25` at `bank_00.asm:5762-5770`. */
  PALETTE_STD: 0x00B528,
  /** OWStdColors2: 56 colors → CGRAM rows 8-15, cols 1-7. Area-INDEPENDENT.
   *  Loaded by `CODE_00AD25` at `bank_00.asm:5771-5779`. */
  PALETTE_STD2: 0x00B57C,
  /** OverworldHudColors: 16 colors → CGRAM rows 0-1, cols 8-15.
   *  Loaded by `CODE_00AD25` at `bank_00.asm:5780-5788`. */
  PALETTE_HUD: 0x00B5EC,
  /** DATA_04849D: 27 warp X words (bank_04.asm:509). */
  WARP_X_TABLE:    0x04849D,
  /** DATA_0484D3: 27 warp Y words (bank_04.asm:518). */
  WARP_Y_TABLE:    0x0484D3,
  /**
   * Title-screen level number — encoded as the 1-byte immediate operand
   * of `LDA.B #!MainMapLvls+!TitleScreenLevel` in `GM03LoadTitleScreen`
   * (`bank_00.asm:2626`). Reading this byte at runtime keeps the OW
   * palette baseline ROM-derived: a hack that swaps the title-screen
   * level adjusts the OW pre-state automatically. The byte sits at
   * SNES `$0096CC` (= `GM03LoadTitleScreen + $1E`, one past the LDA
   * opcode at `$0096CB`). Vanilla SMW: this byte = `$EB` =
   * `MainMapLvls(36) + TitleScreenLevel($C7) - 12 wait that's not right`
   * — actually `$24 + $C7 = $EB`.
   */
  TITLE_LEVEL_LDA_OPERAND: 0x0096CC,
} as const

/**
 * Read the title-screen level number from ROM. The OW load
 * (`GM0CLoadOverworld`, `bank_00.asm:4250`) does NOT call
 * `LoadPalette`; it only writes 4 small CGRAM blocks via
 * `CODE_00AD25` and DMAs the entire `MainPalette` mirror to CGRAM
 * via `CODE_00922F`. So the cells outside those 4 blocks come from
 * whatever was loaded earlier — for the boot→title→OW path that's
 * the title-screen level's `LoadPalette` result. Returning the
 * level index lets the viewer reproduce that pre-state by parsing
 * the level header and feeding its FG/BG/sprite palette indices to
 * `buildLevelCgram`.
 */
export function readOwBaselineLevelIndex(rom: RomFile): number {
  return rom.readByte(OW_ADDR.TITLE_LEVEL_LDA_OPERAND) ?? 0xEB
}

// ── Buffer + count constants (all derived from asm loop limits) ──────────────

/** L2 tilemap output byte count: CPX _E with _E=$4000 (bank_04.asm:5694). */
export const OW_L2_TILEMAP_BYTES = 0x4000
/** L1 Map16 index stream length: MVN A=$07FF + 1 (bank_04.asm:5674). */
export const OW_L1_MAP16_BYTES = 0x0800
/** OWL1CharData entries: CPX #$0400 / step 2 = 512 entries; 8 bytes each. */
export const OW_L1_CHARDATA_BYTES = 0x1000
/** Number of overworld areas (constants.asm:269-276 — Submap_Main..StarWorld). */
export const OW_AREA_COUNT = 7
/** Number of warp entries in the DATA_04849D / DATA_0484D3 tables. */
export const OW_WARP_COUNT = 27
/**
 * Bytes per area's palette block: 4 rows × 7 colors × 2 bytes = 56 bytes.
 * `LoadColors` (`bank_00.asm:5713`) is called from `CODE_00AD25` with
 * `_6 = 6` (7 colors per row, 0..6 inclusive) and `_8 = 3` (4 outer
 * iterations), producing 28 colors written to CGRAM cols 1-7 of rows 4-7.
 *
 * The block START address per area = `OverworldColors + DATA_00ABDF[paletteIndex]`,
 * NOT `paletteIndex * 56` (the offsets in `DATA_00ABDF` happen to be a
 * uniform $38 stride in vanilla but the indirection means future hacks
 * could use a non-uniform layout — we honour the table).
 */
export const OW_PALETTE_BLOCK_BYTES = 56
export const OW_PALETTE_ROWS = 4
export const OW_PALETTE_COLS = 7
/** First CGRAM row that the area-specific palette occupies. */
export const OW_PALETTE_FIRST_ROW = 4
/** First CGRAM col within each row. */
export const OW_PALETTE_FIRST_COL = 1
/** Each Map16 super-tile is 2x2 SNES tiles. */
export const MAP16_PX = 16
export const SNES_TILE_PX = 8
/** Single 64x64 BG layout = $2000 bytes; the staging buffer holds 2. */
export const OW_BG_LAYOUT_BYTES = 0x2000
/** SNES 4-screen quadrant size: 32x32 tiles x 2 bytes = $0800. */
export const OW_BG_SCREEN_BYTES = 0x0800
/** BG dimensions in tiles. */
export const OW_BG_FULL_TILES = 64
export const OW_BG_HALF_TILES = 32

// ── Compatibility re-exports (legacy callers) ────────────────────────────────

/** @deprecated kept for legacy callers; use `OW_AREA_COUNT` */
export const OW_SUBMAP_COUNT = OW_AREA_COUNT
/** @deprecated kept for legacy callers; use `loadOverworldAreas` */
export const OW_BG_TILE_WIDTH = 0x40

// ── RLE decoder (CODE_04DABA port) ───────────────────────────────────────────

/**
 * Decompress one RLE-encoded SMW overworld stream.
 *
 * The asm decoder writes one byte per command iteration to `OWLayer2Tilemap,X`
 * and advances X by 2 (`INX INX`), so the same routine is called twice with
 * different starting X values to interleave low/high byte streams into a
 * single 16-bit tilemap. The loop terminates when the destination index
 * reaches `_E` (`$4000`); there is no in-stream terminator.
 *
 * Command byte format (FLLLLLLL):
 *   F=0 (bit 7 clear): LITERAL — emit (L+1) bytes copied from input
 *   F=1 (bit 7 set):   RLE     — emit (L & $7F)+1 copies of the next byte
 */
export function decompressOwRleStream(
  source: Uint8Array | Buffer,
  sourceStart: number,
  dest: Uint8Array,
  destStart: number,
  stride = 2,
): number {
  let pos = sourceStart
  let d = destStart
  const dLimit = dest.length

  while (d < dLimit) {
    if (pos >= source.length) break
    const cmd = source[pos++]
    const length = (cmd & 0x7F) + 1

    if ((cmd & 0x80) === 0) {
      for (let i = 0; i < length; i++) {
        if (pos >= source.length || d >= dLimit) break
        dest[d] = source[pos++]
        d += stride
      }
    } else {
      if (pos >= source.length) break
      const value = source[pos++]
      for (let i = 0; i < length; i++) {
        if (d >= dLimit) break
        dest[d] = value
        d += stride
      }
    }
  }
  return pos - sourceStart
}

/** Decompress + interleave the two L2 RLE streams into a 16-bit tilemap. */
export function interleaveOwL2Streams(
  streamLo: Uint8Array | Buffer,
  streamHi: Uint8Array | Buffer,
  outputBytes = OW_L2_TILEMAP_BYTES,
): Uint8Array {
  const out = new Uint8Array(outputBytes)
  decompressOwRleStream(streamLo, 0, out, 0, 2)
  decompressOwRleStream(streamHi, 0, out, 1, 2)
  return out
}

// ── 64x64 BG quadrant addressing ─────────────────────────────────────────────

/**
 * Byte offset within `OWLayer2Tilemap` of the 16-bit tilemap word for the
 * tile at `(row, col)` within the chosen 64x64 BG layout.
 *
 * Row and col are wrapped modulo 64 (the BG dimension), so the renderer
 * can pass any positive integer without pre-computing wrap. This matches
 * the SNES BG hardware behavior — when the camera scrolls past a BG
 * boundary, content wraps from the opposite edge. (Sub-area viewports
 * that have negative `cameraX` like Yoshi's Island visibly wrap; see the
 * red rectangles in Mesen's tilemap viewer.)
 *
 * Implements the SNES 4-screen quadrant layout:
 *
 *   layoutBase = layout * $2000
 *   screenIdx  = (row >> 5) * 2 + (col >> 5)   // 0=TL, 1=TR, 2=BL, 3=BR
 *   off        = layoutBase + screenIdx * $0800 + (row & 31) * $40 + (col & 31) * 2
 *
 * The +$0800 / +$1000 jump constants are exactly what `CODE_04E4D0`
 * (bank_04.asm:6131-6172) uses when it crosses screen boundaries during the
 * overworld L2 paint, so this is the canonical decoder.
 */
export function tilemapByteOffset(layout: 0 | 1, row: number, col: number): number {
  const layoutBase = layout * OW_BG_LAYOUT_BYTES
  const r = ((row % 64) + 64) % 64
  const c = ((col % 64) + 64) % 64
  const screenIdx  = ((r >> 5) << 1) | (c >> 5)
  return layoutBase
       + screenIdx * OW_BG_SCREEN_BYTES
       + (r & 31) * 0x40
       + (c & 31) * 2
}

/**
 * Same as `tilemapByteOffset` but for the L1 Map16 index buffer
 * (`Map16TilesLow`, $0800 bytes). Each 16x16 Map16 chunk is 256 bytes;
 * 4 chunks per layout, 2 layouts total. Row/col wrap mod 32.
 */
export function map16ByteOffset(layout: 0 | 1, row: number, col: number): number {
  const layoutBase = layout * 0x0400
  const r = ((row % 32) + 32) % 32
  const c = ((col % 32) + 32) % 32
  const chunkIdx   = ((r >> 4) << 1) | (c >> 4)
  return layoutBase + chunkIdx * 0x100 + (r & 15) * 0x10 + (c & 15)
}

// ── Raw ROM loaders ──────────────────────────────────────────────────────────

export function loadOverworldL2Tilemap(rom: RomFile): Uint8Array {
  const MAX = 0x8000
  const lo = rom.readAt(OW_ADDR.L2_STREAM_LO, MAX)
  const hi = rom.readAt(OW_ADDR.L2_STREAM_HI, MAX)
  if (!lo || !hi) return new Uint8Array(OW_L2_TILEMAP_BYTES)
  return interleaveOwL2Streams(lo, hi, OW_L2_TILEMAP_BYTES)
}

export function loadOverworldL1Map16Stream(rom: RomFile): Uint8Array {
  const buf = rom.readAt(OW_ADDR.L1_TILEDATA, OW_L1_MAP16_BYTES)
  return buf ? Uint8Array.from(buf) : new Uint8Array(OW_L1_MAP16_BYTES)
}

export function loadOverworldL1CharData(rom: RomFile): Uint8Array {
  const buf = rom.readAt(OW_ADDR.L1_CHARDATA, OW_L1_CHARDATA_BYTES)
  return buf ? Uint8Array.from(buf) : new Uint8Array(OW_L1_CHARDATA_BYTES)
}

// ── Area metadata ────────────────────────────────────────────────────────────

export interface OwPosition {
  x: number
  y: number
}

export interface OwArea {
  /** Area ID 0..OW_AREA_COUNT-1. constants.asm:269-276 calls these submaps. */
  index: number
  /** Tile-grid width. Vanilla: 64 for area 0 (the Main map), 32 for the rest. */
  widthTiles: number
  /** Tile-grid height. Same vanilla heuristic as widthTiles. */
  heightTiles: number
  /** Initial Layer 1/2 X scroll, signed. From DATA_00A06B. */
  cameraX: number
  /** Initial Layer 1/2 Y scroll, signed. From DATA_00A079. */
  cameraY: number
  /** ObjectTileset $11..$17 used to look up GFX via OBJECTGFXLIST. */
  objectTileset: number
  /** Index into OverworldColors / OWSpecialColors. From DATA_00AD1E. */
  paletteIndex: number
  /** Absolute SNES address of this area's normal palette block (48 bytes). */
  paletteAddrNormal: number
  /** Absolute SNES address of this area's post-special-world palette block. */
  paletteAddrSpecial: number
  /** First warp entry targeting this area in player slot 0 (Mario). */
  marioStart: OwPosition | null
  /** First warp entry targeting this area in player slot 1 (Luigi).
   *  Vanilla shares the warp tables between players; this stays separate so
   *  a future editor can diverge them per-player. */
  luigiStart: OwPosition | null
}

/** Sign-extend a 16-bit unsigned word to a JS-native signed integer. */
function signExtend16(u: number): number {
  return u > 0x7FFF ? u - 0x10000 : u
}

interface RawWarp {
  index: number
  destSubmap: number
  pos: OwPosition
}

/**
 * Decode all 27 warp entries from DATA_04849D / DATA_0484D3.
 *
 * Per `CODE_04853B` (bank_04.asm:554-576):
 *   X-table word: bits 0-8 = X pixel, bits 9-12 = destination submap nibble.
 *   Y-table word: full 16-bit Y pixel.
 */
function loadAllWarps(rom: RomFile): RawWarp[] {
  const xBuf = rom.readAt(OW_ADDR.WARP_X_TABLE, OW_WARP_COUNT * 2)
  const yBuf = rom.readAt(OW_ADDR.WARP_Y_TABLE, OW_WARP_COUNT * 2)
  if (!xBuf || !yBuf) return []
  const out: RawWarp[] = []
  for (let i = 0; i < OW_WARP_COUNT; i++) {
    const xWord = xBuf.readUInt16LE(i * 2)
    const yWord = yBuf.readUInt16LE(i * 2)
    out.push({
      index: i,
      destSubmap: (xWord >> 9) & 0x0F,
      pos: { x: xWord & 0x01FF, y: yWord & 0xFFFF },
    })
  }
  return out
}

/**
 * Return all warp entries that target the given area. Future editor work may
 * split player-0 vs player-1 starts; today they share the same source data.
 */
export function loadAreaWarpStarts(
  rom: RomFile,
  areaIndex: number,
): { mario: OwPosition[]; luigi: OwPosition[] } {
  const all = loadAllWarps(rom).filter(w => w.destSubmap === areaIndex)
  const positions = all.map(w => w.pos)
  return { mario: positions, luigi: positions.slice() }
}

/**
 * Read all 7 area descriptors from the ROM tables.
 *
 * Width/height: vanilla SMW only treats area 0 (Main) as a full 64x64 BG;
 * the other six use one 32x32 BG screen via per-area camera scroll. We mark
 * this with a heuristic ('index === 0 ? 64 : 32') and document the assumption
 * in the field comment. A future ROM editor that promotes a sub-area to
 * 64x64 will need to surface that distinction explicitly.
 */
export function loadOverworldAreas(rom: RomFile): OwArea[] {
  const xBuf      = rom.readAt(OW_ADDR.CAMERA_X_TABLE, OW_AREA_COUNT * 2)
  const yBuf      = rom.readAt(OW_ADDR.CAMERA_Y_TABLE, OW_AREA_COUNT * 2)
  const tsBuf     = rom.readAt(OW_ADDR.OBJ_TILESET_TBL, OW_AREA_COUNT)
  const palIx     = rom.readAt(OW_ADDR.PALETTE_INDEX_TABLE, OW_AREA_COUNT)
  // DATA_00ABDF holds 7 word offsets — one per palette index 0..6.
  const palOffBuf = rom.readAt(OW_ADDR.PALETTE_BLOCK_OFFSETS, 7 * 2)
  const warps     = loadAllWarps(rom)

  const out: OwArea[] = []
  for (let i = 0; i < OW_AREA_COUNT; i++) {
    const paletteIndex = palIx?.[i] ?? i
    const blockOffset  = palOffBuf?.readUInt16LE(paletteIndex * 2)
                       ?? (paletteIndex * OW_PALETTE_BLOCK_BYTES)
    const targetWarp = warps.find(w => w.destSubmap === i) ?? null
    const widthTiles  = i === 0 ? OW_BG_FULL_TILES : OW_BG_HALF_TILES
    const heightTiles = i === 0 ? OW_BG_FULL_TILES : OW_BG_HALF_TILES
    out.push({
      index: i,
      widthTiles,
      heightTiles,
      cameraX:            signExtend16(xBuf?.readUInt16LE(i * 2) ?? 0),
      cameraY:            signExtend16(yBuf?.readUInt16LE(i * 2) ?? 0),
      objectTileset:      tsBuf?.[i] ?? (0x11 + i),
      paletteIndex,
      paletteAddrNormal:  OW_ADDR.PALETTE_NORMAL_BASE  + blockOffset,
      paletteAddrSpecial: OW_ADDR.PALETTE_SPECIAL_BASE + blockOffset,
      marioStart: targetWarp ? { ...targetWarp.pos } : null,
      luigiStart: targetWarp ? { ...targetWarp.pos } : null,
    })
  }
  return out
}

// ── Per-area palette ─────────────────────────────────────────────────────────

const TRANSPARENT: RgbaColor = [0, 0, 0, 0]
const BLACK: RgbaColor       = [0, 0, 0, 255]

function emptyRow(): RgbaRow {
  return Array.from({ length: 16 }, (_, i) => i === 0 ? TRANSPARENT : BLACK)
}

/**
 * Read this area's full overworld CGRAM as 16 RgbaRows.
 *
 * Mirrors `CODE_00AD25` (`bank_00.asm:5736-5790`) which fires four
 * `LoadColors` calls. Each writes a rectangular block of CGRAM:
 *
 *   1. OverworldColors[area]   → rows 4-7  cols 1-7  (28 colors, area-specific)
 *   2. OWStdColors             → rows 2-7  cols 9-15 (42 colors, shared)
 *   3. OWStdColors2            → rows 8-15 cols 1-7  (56 colors, shared)
 *   4. OverworldHudColors      → rows 0-1  cols 8-15 (16 colors, shared)
 *
 * Without 2-4 the L1 icons render with junk colors when their tile pixels
 * land in cols 9-15 (OWStdColors range) or rows 8-15 (sprite range —
 * OWStdColors2). The user reported this for area 0's L1 icons.
 */
export function loadAreaPalette(rom: RomFile, area: OwArea, useSpecial: boolean): RgbaRow[] {
  const rows: RgbaRow[] = Array.from({ length: 16 }, emptyRow)

  // 1. Area-specific (4 rows × 7 cols starting at row 4 col 1)
  const areaAddr = useSpecial ? area.paletteAddrSpecial : area.paletteAddrNormal
  const areaBuf = rom.readAt(areaAddr, OW_PALETTE_BLOCK_BYTES)
  if (areaBuf) {
    for (let r = 0; r < OW_PALETTE_ROWS; r++) {
      for (let c = 0; c < OW_PALETTE_COLS; c++) {
        const word = areaBuf.readUInt16LE((r * OW_PALETTE_COLS + c) * 2)
        rows[OW_PALETTE_FIRST_ROW + r][OW_PALETTE_FIRST_COL + c] = bgr555ToRgba(word)
      }
    }
  }

  // 2. OWStdColors (6 outer × 7 inner = 42 colors, rows 2-7 cols 9-15).
  const stdBuf = rom.readAt(OW_ADDR.PALETTE_STD, 6 * 7 * 2)
  if (stdBuf) {
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 7; c++) {
        const word = stdBuf.readUInt16LE((r * 7 + c) * 2)
        rows[2 + r][9 + c] = bgr555ToRgba(word)
      }
    }
  }

  // 3. OWStdColors2 (8 outer × 7 inner = 56 colors, rows 8-15 cols 1-7).
  const std2Buf = rom.readAt(OW_ADDR.PALETTE_STD2, 8 * 7 * 2)
  if (std2Buf) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 7; c++) {
        const word = std2Buf.readUInt16LE((r * 7 + c) * 2)
        rows[8 + r][1 + c] = bgr555ToRgba(word)
      }
    }
  }

  // 4. OverworldHudColors (2 outer × 8 inner = 16 colors, rows 0-1 cols 8-15).
  const hudBuf = rom.readAt(OW_ADDR.PALETTE_HUD, 2 * 8 * 2)
  if (hudBuf) {
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 8; c++) {
        const word = hudBuf.readUInt16LE((r * 8 + c) * 2)
        rows[r][8 + c] = bgr555ToRgba(word)
      }
    }
  }

  return rows
}

// ── Area → buffer region mapping ─────────────────────────────────────────────

/**
 * Where in the staging buffer does a given area's visible content live?
 *
 * Two-layout model (verified by comparing the live game vs Mesen's L2
 * tilemap viewer):
 *
 *   Layout 0 ($0000-$1FFF in `OWLayer2Tilemap`) = the Main map, a full
 *     64×64 BG that the player scrolls through with the camera.
 *   Layout 1 ($2000-$3FFF) = ALL six sub-areas tiled together into one
 *     64×64 BG. Each sub-area has a fixed camera position; the L3 mask
 *     covers the rest of the screen so only the sub-area's playable
 *     window is visible in-game. Multiple sub-areas can therefore live in
 *     the same physical buffer with no quadrant boundary.
 *
 * The BG region authored per sub-area derives directly from the spacing
 * between adjacent cameras in `DATA_00A06B` / `DATA_00A079`:
 *
 *   horizontal Δ between left-column cameras (cam_X[1]) and right-column
 *   cameras (cam_X[4]) = $00F0 - $FFEF = $0101 ≈ 32 SNES tiles.
 *
 *   vertical Δ between consecutive cameras (cam_Y[1]→cam_Y[2]→cam_Y[3])
 *   = $00A8 each = exactly 21 SNES tiles.
 *
 * That gives a 32×21 BG region per sub-area, which is the largest window
 * that does NOT bleed into an adjacent sub-area's authored BG content.
 * The L3 mask hides the outer ring of this region in-game (the playable
 * interior is roughly 29×20), but a viewer/editor displays the entire
 * authored BG region — matching Lunar Magic.
 *
 * Position within the BG comes straight from the camera tables:
 *
 *   bgTileX = floor(cameraX / 8) mod 64
 *   bgTileY = floor(cameraY / 8) mod 64
 *
 * Negative `cameraX`/`cameraY` (e.g. `$FFEF` / `$FFD8`) wrap around the
 * 64-tile BG. The renderer applies the same modular wrap when sampling
 * tiles inside the window.
 */
export interface OwBufferRegion {
  /** 0 or 1 — which 64×64 BG layout in `OWLayer2Tilemap`. */
  layout: 0 | 1
  /** Starting BG row (0..63) within the layout, from the camera Y. */
  rowStart: number
  /** Starting BG col (0..63), from the camera X. */
  colStart: number
  /** Region width in SNES tiles. */
  widthTiles: number
  /** Region height in SNES tiles. */
  heightTiles: number
}

/**
 * Sub-area BG window: 32 cols × 28 rows = one full SNES camera screen.
 * Adjacent vertical sub-areas overlap by 6 rows; that overlap is
 * hidden in-game by the L3 sprite-overlay defined in
 * {@link OW_SUBAREA_L3_MASK}. Authored playable extent (after the
 * mask) is 32 cols × 22 rows.
 */
export const OW_SUBAREA_TILES_W = 32
export const OW_SUBAREA_TILES_H = 28

/**
 * L3 row mask: which rows of a sub-area's 32×28 camera viewport are
 * hidden by the OW border sprite-overlay (`OWBorderStripe`,
 * `bank_04.asm:3526`). Columns are NOT clipped — OW init writes
 * `WindowTable` with `$00,$FF` pairs (`bank_00.asm:4356-4361`),
 * giving full-width pass-through.
 *
 * The 6 sub-maps tile a single 64-row BG vertically as **22 + 21 +
 * 21 = 64 rows** (top-row pair, middle pair, bottom pair). Top-row
 * sub-maps (cam Y = `$FFD8` = -40) author 22 rows of content; the
 * other four sub-maps author 21 rows. The L3 mask absorbs the
 * difference: top-row maps mask 4 rows at the top of their viewport,
 * the rest mask 5. All six mask 2 rows at the bottom.
 *
 *     topRows + content + bottomRows = 28  (= full SNES screen)
 *     top-row    : 4 + 22 + 2 = 28
 *     middle/bot : 5 + 21 + 2 = 28
 */
export interface OwL3Mask {
  topRows: number
  bottomRows: number
}

/** Compute the per-area L3 row mask. Returns `null` for the Main map
 *  (Area 0), which renders the full 64×64 BG without any L3 frame. */
export function l3MaskForArea(area: OwArea): OwL3Mask | null {
  if (area.index === 0) return null
  // Top-row sub-areas have negative camera-Y (vanilla: $FFD8 = -40).
  // They author 22 rows of content; only 4 rows are L3-hidden at the
  // top instead of 5. cameraY is already sign-extended in OwArea, so
  // a simple `< 0` check is reliable.
  const isTopRow = area.cameraY < 0
  return { topRows: isTopRow ? 4 : 5, bottomRows: 2 }
}

export function isL3MaskedRow(
  localRow: number,
  mask: OwL3Mask,
  height: number = OW_SUBAREA_TILES_H,
): boolean {
  return localRow < mask.topRows || localRow >= height - mask.bottomRows
}

export function areaBufferRegion(area: OwArea): OwBufferRegion {
  if (area.index === 0) {
    // Main map: full 64×64 of layout 0; camera is (0, 0) in vanilla.
    return { layout: 0, rowStart: 0, colStart: 0, widthTiles: 64, heightTiles: 64 }
  }
  // SNES BG hardware places the first FULLY-VISIBLE tile at
  // ceil(cam / 8) when cam isn't a multiple of 8. Floor (= signed
  // shift right) lands one tile earlier on a partially-clipped tile,
  // which doesn't match the authored sub-area boundary. Verified
  // against Mesen's scroll overlay for sub-map 1 (cam = -17 → col 62,
  // not 61).
  const camTileX = ((Math.ceil(area.cameraX / 8) % 64) + 64) % 64
  const camTileY = ((Math.ceil(area.cameraY / 8) % 64) + 64) % 64
  return {
    layout: 1,
    rowStart: camTileY,
    colStart: camTileX,
    widthTiles: OW_SUBAREA_TILES_W,
    heightTiles: OW_SUBAREA_TILES_H,
  }
}

// ── Map16 character entry decode ─────────────────────────────────────────────

export interface OwSubTile {
  charNum: number
  palette: number
  priority: boolean
  flipX: boolean
  flipY: boolean
}

export interface OwMap16 {
  tl: OwSubTile
  tr: OwSubTile
  bl: OwSubTile
  br: OwSubTile
}

function decodeTilemapWord(lo: number, hi: number): OwSubTile {
  const word = (hi << 8) | lo
  return {
    charNum:  word & 0x03FF,
    palette: (word >> 10) & 0x07,
    priority:((word >> 13) & 0x01) === 1,
    flipX:   ((word >> 14) & 0x01) === 1,
    flipY:   ((word >> 15) & 0x01) === 1,
  }
}

/** Subtile layout matches CODE_04DCB6's 2x2 expansion (bank_04.asm:5764-5784). */
export function decodeOwMap16(charData: Uint8Array, index: number): OwMap16 {
  const off = index * 8
  return {
    tl: decodeTilemapWord(charData[off + 0] ?? 0, charData[off + 1] ?? 0),
    bl: decodeTilemapWord(charData[off + 2] ?? 0, charData[off + 3] ?? 0),
    tr: decodeTilemapWord(charData[off + 4] ?? 0, charData[off + 5] ?? 0),
    br: decodeTilemapWord(charData[off + 6] ?? 0, charData[off + 7] ?? 0),
  }
}

// ── Top-level facade ─────────────────────────────────────────────────────────

export interface OwData {
  l2Tilemap: Uint8Array
  l1Map16Indices: Uint8Array
  l1CharData: Uint8Array
  areas: OwArea[]
}

/** Single entry point bundling every ROM-derived overworld piece. */
export function loadOverworld(rom: RomFile): OwData {
  return {
    l2Tilemap:      loadOverworldL2Tilemap(rom),
    l1Map16Indices: loadOverworldL1Map16Stream(rom),
    l1CharData:     loadOverworldL1CharData(rom),
    areas:          loadOverworldAreas(rom),
  }
}
