/**
 * Map16 tile system for Super Mario World.
 *
 * Each Map16 tile is a 16×16 pixel cell composed of four 8×8 SNES subtiles
 * arranged as:  TL | TR
 *               BL | BR
 *
 * ROM layout (vanilla SMW):
 *   $0D8000 — page 0: tiles $000–$0FF, 8 bytes each (low/high interleaved)
 *   $0DC000 — page 1: tiles $100–$1FF, 8 bytes each
 *
 * Each 8-byte entry = four 2-byte SNES BG tile attributes (little-endian):
 *   Bits  0–9 : character number (tile index in VRAM / GFX sheet)
 *   Bits 10–12: palette row (0–7)
 *   Bit   13  : priority (0=behind sprites, 1=above)
 *   Bit   14  : X-flip
 *   Bit   15  : Y-flip
 *
 * Subtile order within the 8 bytes: TL, BL, TR, BR
 * (SNES stores column-major: top-left, bottom-left, then top-right, bottom-right)
 *
 * NOTE: The subtile order TL/BL/TR/BR is verified against community documentation.
 * If tiles render mirrored, swap to TL/TR/BL/BR.
 */

import { RomFile } from './RomFile'

export const MAP16_PAGE0 = 0x0D8000  // tiles $000–$0FF
export const MAP16_PAGE1 = 0x0DC000  // tiles $100–$1FF (vanilla SMW address; LM may relocate)
export const MAP16_TILE_BYTES = 8
export const MAP16_TILES_PER_PAGE = 0x100
export const MAP16_TOTAL_TILES = 0x200

export interface SubTile {
  charNum: number    // 10-bit GFX character index
  palette: number   // 3-bit palette row (0–7)
  priority: boolean
  flipX: boolean
  flipY: boolean
}

/** A decoded 16×16 Map16 tile with its four 8×8 subtiles. */
export interface Map16Tile {
  id: number
  tl: SubTile   // top-left
  tr: SubTile   // top-right
  bl: SubTile   // bottom-left
  br: SubTile   // bottom-right
}

function decodeSubTile(word: number): SubTile {
  return {
    charNum:  word & 0x3FF,
    palette:  (word >> 10) & 0x7,
    priority: ((word >> 13) & 1) === 1,
    flipX:    ((word >> 14) & 1) === 1,
    flipY:    ((word >> 15) & 1) === 1,
  }
}

function readTile(rom: RomFile, baseAddr: number, index: number): Map16Tile {
  const addr = baseAddr + index * MAP16_TILE_BYTES
  const buf = rom.readAt(addr, MAP16_TILE_BYTES)
  if (!buf) {
    return {
      id: (baseAddr === MAP16_PAGE0 ? 0 : MAP16_TILES_PER_PAGE) + index,
      tl: { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false },
      tr: { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false },
      bl: { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false },
      br: { charNum: 0, palette: 0, priority: false, flipX: false, flipY: false },
    }
  }

  const w0 = buf.readUInt16LE(0)
  const w1 = buf.readUInt16LE(2)
  const w2 = buf.readUInt16LE(4)
  const w3 = buf.readUInt16LE(6)

  const id = (baseAddr === MAP16_PAGE0 ? 0 : MAP16_TILES_PER_PAGE) + index
  // Subtile word order: w0=TL, w1=TR, w2=BL, w3=BR (row-major).
  return {
    id,
    tl: decodeSubTile(w0),
    tr: decodeSubTile(w1),
    bl: decodeSubTile(w2),
    br: decodeSubTile(w3),
  }
}

/**
 * Load all 512 Map16 tiles from ROM.
 * Index 0x000–0x0FF come from page 0 ($0D8000).
 * Index 0x100–0x1FF come from page 1 ($0DC000).
 */
export function loadAllMap16(rom: RomFile): Map16Tile[] {
  const tiles: Map16Tile[] = []
  for (let i = 0; i < MAP16_TILES_PER_PAGE; i++) tiles.push(readTile(rom, MAP16_PAGE0, i))
  for (let i = 0; i < MAP16_TILES_PER_PAGE; i++) tiles.push(readTile(rom, MAP16_PAGE1, i))
  return tiles
}

export function loadMap16Tile(rom: RomFile, tileId: number): Map16Tile {
  if (tileId < MAP16_TILES_PER_PAGE) return readTile(rom, MAP16_PAGE0, tileId)
  return readTile(rom, MAP16_PAGE1, tileId - MAP16_TILES_PER_PAGE)
}
