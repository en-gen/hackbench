/**
 * L2 Preset Background Decoder — SMW CODE_058126 format.
 *
 * Levels with L2 bank byte = $FF use a preset (static) background stored at
 * $0D0000 | (hi << 8) | lo. The data is NOT raw SNES tilemap words; it is
 * compressed with a byte-level RLE scheme decoded by the game at CODE_058126
 * (galaxyhaxz/smw-src, lv_read.s).
 *
 * ── Compression format ─────────────────────────────────────────────────────────
 *   Command byte:
 *     bit 7 = 1 → RUN mode:     count = (cmd & $7F) + 1; next byte repeated count times
 *     bit 7 = 0 → LITERAL mode: count = (cmd & $7F) + 1; next count bytes copied verbatim
 *   Stream terminator: two consecutive $FF bytes ($FF $FF)
 *
 * Output: raw SNES BG2 tilemap bytes (LE 16-bit words), exactly as they appear
 * in VRAM after decompression. Verified against Mesen VRAM dump (SnesVideoRam.dmp):
 *   Level $104 → VRAM byte $6000–$7FFF = 64×64 8×8-tile BG2 tilemap (8192 bytes)
 *   Tile at (col=14, row=33): charNum $114, palette 0, word $0114 at byte offset 4252.
 *
 * ── BG2 tilemap word format (SNES standard) ────────────────────────────────────
 *   bit 15    : Y-flip
 *   bit 14    : X-flip
 *   bit 13    : high priority
 *   bits 12–10: palette row (0–7)
 *   bits  9– 0: character number (VRAM tile index)
 */

import { SubTile } from './Map16'

/** Stride (columns) of the BG2 preset tilemap — always 64 for vanilla SMW presets. */
export const PRESET_STRIDE = 64

/**
 * Decompresses SMW L2 preset background data from the CODE_058126 byte-RLE stream.
 *
 * @param src  Raw bytes starting at the preset SNES address (e.g. rom.readAt(presetAddr, 0x3000))
 * @returns    Decompressed SNES BG2 tilemap bytes. Length is typically 8192 (64×64 words).
 */
export function decompressL2Preset(src: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < src.length) {
    // $FF $FF = end-of-stream terminator
    if (src[i] === 0xFF && i + 1 < src.length && src[i + 1] === 0xFF) break
    const cmd = src[i++]
    if (cmd === undefined) break
    if (cmd & 0x80) {
      // RUN mode: bit 7 set → repeat next byte (count+1) times
      const count = (cmd & 0x7F) + 1
      if (i >= src.length) break
      const val = src[i++]
      for (let j = 0; j < count; j++) out.push(val)
    } else {
      // LITERAL mode: bit 7 clear → copy next (count+1) bytes verbatim
      const count = cmd + 1
      for (let j = 0; j < count && i < src.length; j++) out.push(src[i++])
    }
  }
  return new Uint8Array(out)
}

/** Read a little-endian 16-bit word from a decompressed tilemap buffer. */
function readTilemapWord(buf: Uint8Array, stride: number, row8: number, col8: number): number {
  const off = (row8 * stride + col8) * 2
  return ((buf[off + 1] ?? 0) << 8) | (buf[off] ?? 0)
}

/** Decode a raw SNES BG tilemap word into a SubTile descriptor. */
function decodeTilemapWord(w: number): SubTile {
  return {
    charNum:  w & 0x3FF,
    palette:  (w >> 10) & 0x7,
    priority: ((w >> 13) & 1) === 1,
    flipX:    ((w >> 14) & 1) === 1,
    flipY:    ((w >> 15) & 1) === 1,
  }
}

import { Map16Tile } from './Map16'
import { SCREEN_W, SCREEN_H } from './LevelParser'
import { createGrid, TileGrid } from './ObjectExpander'

export interface L2PresetResult {
  /** 2D Map16 tile grid [row][col] — each cell is a synthetic Map16 tile ID ≥ 0x2000. */
  bgTileGrid: TileGrid
  /** Synthetic Map16 tiles built from raw SNES BG2 tilemap words (IDs 0x2000+). */
  l2PresetTiles: Map16Tile[]
}

/**
 * Decompress and rasterise an L2 preset background into a bgTileGrid + tile list.
 *
 * Each Map16 cell (16×16 px = 2×2 8×8 subtiles) is extracted from the 64-wide
 * decompressed tilemap and assigned a synthetic tile ID (starting at 0x2000).
 * Identical 2×2 groups reuse the same ID, keeping the tile list compact.
 *
 * @param decompressed  Output of `decompressL2Preset()`.
 * @param screens       Number of horizontal screens in the level (from L1 header).
 */
export function buildL2PresetGrid(decompressed: Uint8Array, screens: number): L2PresetResult {
  const bgTileGrid = createGrid(screens)
  const l2PresetTiles: Map16Tile[] = []
  const l2TileMap = new Map<string, number>()
  let l2IdCounter = 0x2000

  for (let r = 0; r < SCREEN_H; r++) {
    for (let c = 0; c < screens * SCREEN_W; c++) {
      // Each Map16 cell (r, c) maps to a 2×2 block of 8×8 tiles in the BG2 tilemap.
      const row8 = r * 2
      const col8 = c * 2
      const tlW = readTilemapWord(decompressed, PRESET_STRIDE, row8,     col8)
      const trW = readTilemapWord(decompressed, PRESET_STRIDE, row8,     col8 + 1)
      const blW = readTilemapWord(decompressed, PRESET_STRIDE, row8 + 1, col8)
      const brW = readTilemapWord(decompressed, PRESET_STRIDE, row8 + 1, col8 + 1)

      const key = `${tlW}_${trW}_${blW}_${brW}`
      let tileId = l2TileMap.get(key)
      if (tileId === undefined) {
        tileId = l2IdCounter++
        l2TileMap.set(key, tileId)
        l2PresetTiles.push({
          id: tileId,
          tl: decodeTilemapWord(tlW),
          tr: decodeTilemapWord(trW),
          bl: decodeTilemapWord(blW),
          br: decodeTilemapWord(brW),
        })
      }
      bgTileGrid[r][c] = tileId
    }
  }

  return { bgTileGrid, l2PresetTiles }
}
