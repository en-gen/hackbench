/**
 * L2Loader — faithful port of CODE_05801E (bank_05.asm lines 20-74) for the
 * Layer 2 preset-background path. Object-stream L2 (bank != $FF) is NOT
 * handled here; that requires the standard object dispatcher targeting a
 * Map16-page-2/3 backing store, which is a separate concern.
 *
 * ── How preset-BG L2 works in SMW ─────────────────────────────────────────
 *
 * 1. The L2 pointer table at $05E600 stores a 3-byte entry per level:
 *      lo, hi, bank
 *    If `bank == $FF`, the level uses a preset background and the lo/hi form
 *    a 16-bit address in bank $0C — not $FF. (The game sets
 *    `Layer2DataPtr+2 = $0C` after detecting the $FF sentinel.)
 *
 * 2. A page selector is derived purely from the address threshold:
 *      page = (lowWord >= $CE8FE) ? 1 : 0
 *    This is stamped into every high-byte slot of Layer2Tilemap. Combined
 *    with each decompressed low byte, it forms a full Map16 tile ID:
 *      map16Id = (page << 8) | lowByte
 *    and indexes into Map16BGTiles ($0D9100) via the L2 pointer table set up
 *    by the tail of CODE_058126 (ported as `loadAllMap16BG`).
 *
 * 3. The compressed data is decoded by CODE_058126 (LC_RLE1) into a flat byte
 *    stream. The game's Layer2TilemapLow buffer is 1024 bytes — a 32×32 tile
 *    grid. Shorter streams leave the trailing bytes at $25 (the value written
 *    during pre-init).
 */

import { RomFile } from './RomFile'
import { decompressRle1 } from './LcRle1'
import { parseL2Objects, SCREEN_W, SCREEN_H } from './LevelParser'
import { expandObject, createGrid } from './ObjectExpander'

/** L2 pointer table base. 3 bytes per level: lo, hi, bank. */
export const L2_POINTER_TABLE = 0x05E600

/** Page-selector threshold from CODE_05801E line 38. */
export const L2_PAGE_THRESHOLD = 0xE8FE

/** BG data bank set by CODE_05801E line 48 after the $FF sentinel check. */
export const L2_BG_BANK = 0x0C

/**
 * Preset tilemap dimensions.
 *
 * The decompressed stream is stored **screen-major**: two 16×27 blocks (432
 * bytes each) laid out back-to-back, representing the left and right halves
 * of the full 32×27 BG pattern. Byte offset for screen `s` (0=left, 1=right),
 * local column `c` in [0..15], row `r` in [0..26]:
 *
 *   offset = s * 432 + r * 16 + c
 *
 * Streams shorter than 864 bytes leave trailing cells at the $25 pre-init
 * value (CODE_05801E line 25 fills Layer2TilemapLow with $25 before the
 * decompressor runs).
 *
 * Row-major `width * row + col` interpretation (hypothesis A) would shuffle
 * hill tiles across unrelated rows, producing an incoherent BG; empirically
 * verified by dumping rows of level 105's $CD900 preset and seeing coherent
 * sky-to-ground structure only under the screen-major interpretation.
 */
export const L2_PRESET_SCREEN_COLS = 16
export const L2_PRESET_SCREEN_ROWS = 27
export const L2_PRESET_SCREEN_BYTES = L2_PRESET_SCREEN_COLS * L2_PRESET_SCREEN_ROWS  // 432
/** Full tiled pattern — two side-by-side screens. */
export const L2_TILEMAP_COLS = L2_PRESET_SCREEN_COLS * 2  // 32
export const L2_TILEMAP_ROWS = L2_PRESET_SCREEN_ROWS      // 27
export const L2_TILEMAP_SIZE = L2_PRESET_SCREEN_BYTES * 2  // 864

/**
 * BG2 PPU sub-tilemap height in tiles. Layer2TilemapLow is a 1024-byte buffer
 * (32×32 tiles); only the first 864 bytes hold preset data — the bottom 5 rows
 * stay at the $25 init fill (CODE_05801E lines 24-30). For vertical levels the
 * BG scrolls vertically and the PPU wraps the sub-tilemap every 32 rows, so
 * the tiled pattern repeats with a 5-row $25 strip between iterations. Lunar
 * Magic draws the same strip as solid back-area color.
 */
export const L2_BG_PLANE_ROWS = 32

/** Default empty-tile byte written by CODE_05801E init loop (line 25). */
export const L2_EMPTY_TILE = 0x25

export interface L2PresetLoad {
  /** Raw 3-byte L2 pointer (bank<<16 | hi<<8 | lo) read from the table. */
  rawPtr: number
  /** SNES address of the compressed BG data in bank $0C. */
  dataAddr: number
  /** Page selector (0 or 1) derived from the address threshold. */
  page: number
  /** 32×32 grid of full Map16 tile IDs: `(page << 8) | lowByte`. */
  grid: number[][]
}

/**
 * Read the raw 3-byte L2 pointer for a level.
 * Returns null if the ROM read fails.
 */
export function readL2Pointer(rom: RomFile, level: number): number | null {
  const base = L2_POINTER_TABLE + level * 3
  const lo = rom.readByte(base)
  const hi = rom.readByte(base + 1)
  const bk = rom.readByte(base + 2)
  if (lo === null || hi === null || bk === null) return null
  return (bk << 16) | (hi << 8) | lo
}

/** True if the L2 pointer indicates a preset BG (bank byte $FF). */
export function isPresetPtr(ptr: number): boolean {
  return ((ptr >> 16) & 0xFF) === 0xFF
}

/**
 * Load a preset BG from its pointer. Accepts the raw 3-byte pointer value so
 * the UI can override the level's default and render any preset on demand.
 *
 * Mirrors CODE_05801E preset-BG path: decompresses LC_RLE1 data from bank
 * $0C, derives the page selector from the source-address threshold, and
 * stamps a 32×32 tile grid. Returns null if `ptr` isn't a preset (bank != $FF).
 */
export function loadL2Preset(rom: RomFile, ptr: number): L2PresetLoad | null {
  if (!isPresetPtr(ptr)) return null

  const lowWord = ptr & 0xFFFF
  const page = lowWord >= L2_PAGE_THRESHOLD ? 1 : 0
  const dataAddr = (L2_BG_BANK << 16) | lowWord

  // Max L2 preset stream length we'll read; LC_RLE1 stops at $FF $FF so a
  // generous cap is fine. Vanilla streams decompress to ≤ 1024 bytes.
  const raw = rom.readAt(dataAddr, 0x2000)
  if (!raw) return null

  const bytes = decompressRle1(raw)

  // Build the 32×27 grid. ASM pre-initializes Layer2TilemapLow to $25 and
  // the decompressor writes on top; cells past the stream stay $25. Stream
  // layout: bytes [0..431] are the left 16×27 screen row-major, [432..863]
  // are the right 16×27 screen row-major.
  const grid: number[][] = Array.from({ length: L2_TILEMAP_ROWS }, () =>
    new Array<number>(L2_TILEMAP_COLS).fill((page << 8) | L2_EMPTY_TILE),
  )
  for (let s = 0; s < 2; s++) {
    for (let r = 0; r < L2_PRESET_SCREEN_ROWS; r++) {
      for (let c = 0; c < L2_PRESET_SCREEN_COLS; c++) {
        const i = s * L2_PRESET_SCREEN_BYTES + r * L2_PRESET_SCREEN_COLS + c
        if (i >= bytes.length) break
        grid[r][s * L2_PRESET_SCREEN_COLS + c] = (page << 8) | bytes[i]
      }
    }
  }

  return { rawPtr: ptr, dataAddr, page, grid }
}

/**
 * Load an object-stream L2 tilemap (bank != $FF).
 *
 * Mirrors LoadLevel (bank_05.asm line 424) for `LayerProcessing == 1`:
 *   - The game COPIES Layer2DataPtr + 5 into Layer1DataPtr and JMPs back into
 *     LoadAgain, which is the object-expansion loop. The +5 skips L2's own
 *     5-byte header bytes — the game never parses L2's header.
 *   - Object dispatch uses L1's ObjectTileset and L1's LevelScrLength. That's
 *     the screen count and tileset we pass in here.
 *   - The object stream writes Map16 IDs against the *regular* Map16 pointer
 *     table (not Map16BGTiles) — so the rendered tile IDs are L1-atlas
 *     compatible.
 *
 * We still call parseLevelObjects on the raw L2 bytes because it reads a
 * 5-byte "header" then an object stream — the same layout L2 data has. We
 * discard the parsed header and use only `.objects`.
 */
export function loadL2Objects(
  rom: RomFile, ptr: number, screens: number, objectTileset: number,
  isVertical = false,
): { grid: number[][] } | null {
  if (isPresetPtr(ptr)) return null

  const snesAddr = ptr & 0xFFFFFF
  // Read a generous window — real L2 streams terminate with $FF.
  const raw = rom.readAt(snesAddr, 0x2000)
  if (!raw) return null

  // L2 has no header; skip straight to object parsing. The vertical flag
  // mirrors L1's — in vanilla SMW, L2 verticality tracks L1 closely.
  // parseL2Objects applies the same XY-swap rules as parseLevelObjects.
  const objects = parseL2Objects(raw, screens, isVertical)
  const grid = createGrid(screens, isVertical)
  for (const obj of objects) {
    expandObject(grid, obj, rom, objectTileset)
  }
  return { grid }
}

// Re-export for callers that want the canonical grid dimensions without
// reaching into LevelParser directly.
export { SCREEN_W as L1_SCREEN_W, SCREEN_H as L1_SCREEN_H }

/**
 * Enumerate every unique preset pointer used by any level in the L2 table.
 * Returns them sorted by low-word address so the dropdown has a stable order.
 *
 * Each entry is the full 3-byte packed pointer (bank<<16 | hi<<8 | lo), matching
 * the input shape of `loadL2Preset`. The `levels` field lists which level indices
 * reference each pointer so the UI can label them helpfully.
 */
export function enumerateL2Presets(
  rom: RomFile, levelCount = 0x200,
): { ptr: number; levels: number[] }[] {
  const byPtr = new Map<number, number[]>()
  for (let level = 0; level < levelCount; level++) {
    const ptr = readL2Pointer(rom, level)
    if (ptr === null || !isPresetPtr(ptr)) continue
    const list = byPtr.get(ptr)
    if (list) list.push(level)
    else byPtr.set(ptr, [level])
  }
  return [...byPtr.entries()]
    .map(([ptr, levels]) => ({ ptr, levels }))
    .sort((a, b) => (a.ptr & 0xFFFF) - (b.ptr & 0xFFFF))
}
