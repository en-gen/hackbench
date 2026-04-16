/**
 * SMW Object Expander — converts the level object stream into a 2D Map16 tile grid.
 *
 * Ported from SMWDisX (IsoFrieze/SMWDisX) bank_0D.asm handlers.
 * Each handler uses the TileCursor to write tiles exactly as the game does.
 */

import { LevelObject, SCREEN_W, SCREEN_H } from './LevelParser'
import { RomFile } from './RomFile'
import { TileCursor, TileGrid, createGrid, TILE_EMPTY } from './TileCursor'

export { TILE_EMPTY, TileGrid, createGrid }

// Re-export TileCursor types for tests
export type { TileCursor }

// ── ROM helpers ────────────────────────────────────────────────────────────

function romByte(rom: RomFile | undefined, addr: number): number {
  return rom?.readByte(addr) ?? 0
}

// ── Standard Object Handlers ───────────────────────────────────────────────
// Ported from bank_0D tileset 0 dispatch table at CODE_0DA44B.
// X = object number ($5A), passed via the dispatch.

/**
 * Objects $01-$0E: Ground/fill tiles.
 * CODE_0DA8C3. Settings: low=width, high=height.
 * Tile from table at $0DA8B4 indexed by (objNum-1).
 */
function handleGround(c: TileCursor, objNum: number, settings: number, rom: RomFile | undefined): void {
  const width = (settings & 0x0F)
  const height = (settings >> 4) & 0x0F
  const tileId = romByte(rom, 0x0DA8B4 + objNum - 1)
  if (tileId === 0) return

  c.saveCol()
  for (let h = height; h >= 0; h--) {
    for (let w = width; w >= 0; w--) {
      c.setPage0()
      // Item memory check for object $04 skipped (only affects collected items)
      if (objNum >= 7) c.setPage1()
      c.writeTileAdvanceCol(tileId)
    }
    c.restoreCol()
    c.advanceRow()
  }
}

/**
 * Objects $18-$1B, $22-$2F: Generic tilemap handler.
 * CODE_0DB3E3. First row from $0DB3DB[objNum-$17], body from $0DB3DF[objNum-$17].
 */
function handleGeneric(c: TileCursor, objNum: number, settings: number, rom: RomFile | undefined): void {
  const width = (settings & 0x0F)
  const height = (settings >> 4) & 0x0F
  const idx = objNum - 0x17

  const topTile = romByte(rom, 0x0DB3DB + idx)
  const bodyTile = romByte(rom, 0x0DB3DF + idx)

  c.saveCol()

  // First row: top tiles
  for (let w = width; w >= 0; w--) {
    c.setPage0()
    c.writeTileAdvanceCol(topTile)
  }
  c.restoreCol()
  c.advanceRow()

  // Body rows
  for (let h = height - 1; h >= 0; h--) {
    for (let w = width; w >= 0; w--) {
      c.setPage0()
      c.writeTileAdvanceCol(bodyTile)
    }
    c.restoreCol()
    c.advanceRow()
  }
}

/**
 * Object $1C: 2-tile-wide ledge.
 * CODE_0DB42D. Two columns using tiles from DATA_0DB42B.
 */
function handleLedge(c: TileCursor, settings: number, rom: RomFile | undefined): void {
  const width = (settings & 0x0F)
  const tile0 = romByte(rom, 0x0DB42B)  // $26
  const tile1 = romByte(rom, 0x0DB42C)  // $44

  c.saveCol()
  for (let x = 0; x < 2; x++) {
    for (let w = width; w >= 0; w--) {
      if (x === 0) c.setPage0()
      else c.setPage1()
      c.writeTileAdvanceCol(x === 0 ? tile0 : tile1)
    }
    c.restoreCol()
    c.advanceRow()
  }
}

/**
 * Object $1D: Fence/tree.
 * CODE_0DB461. Body rows tile $0B, bottom row tile $0E.
 */
function handleFenceTree(c: TileCursor, settings: number): void {
  const height = (settings >> 4) & 0x0F
  const width = (settings & 0x0F)

  c.saveCol()

  // Body rows
  for (let h = height; h > 0; h--) {
    for (let w = width; w >= 0; w--) {
      c.setPage0()
      c.writeTileAdvanceCol(0x0B)
    }
    c.restoreCol()
    c.advanceRow()
  }

  // Bottom row
  for (let w = width; w >= 0; w--) {
    c.setPage0()
    c.writeTileAdvanceCol(0x0E)
  }
}

/**
 * Object $1F: Vertical pipe.
 * CODE_0DB51F. Top=$53, body=$54, bottom=$55 (page 1).
 */
function handleVertPipe(c: TileCursor, settings: number): void {
  const height = (settings >> 4) & 0x0F

  c.setPage1()
  c.writeTile(0x53)
  c.advanceRow()
  for (let h = height; h > 0; h--) {
    c.setPage1()
    c.writeTile(0x54)
    c.advanceRow()
  }
  c.setPage1()
  c.writeTile(0x55)
}

/**
 * Object $20: Horizontal pipe.
 * CODE_0DB547. Left=$56, body=$57, right=$58 (page 1).
 */
function handleHorizPipe(c: TileCursor, settings: number): void {
  const width = (settings & 0x0F)

  c.setPage1()
  c.writeTileAdvanceCol(0x56)
  for (let w = width; w > 0; w--) {
    c.setPage1()
    c.writeTileAdvanceCol(0x57)
  }
  c.setPage1()
  c.writeTile(0x58)
}

/**
 * Object $11: Vertical vine/column.
 * CODE_0DAB0D. Top=$41, second=$42, body=$43 (page 1).
 */
function handleVertVine(c: TileCursor, settings: number): void {
  let height = (settings >> 4) & 0x0F

  c.setPage1()
  c.writeTile(0x41)
  c.advanceRow()
  height--
  if (height < 0) return
  c.setPage1()
  c.writeTile(0x42)
  c.advanceRow()
  height--
  while (height >= 0) {
    c.setPage1()
    c.writeTile(0x43)
    c.advanceRow()
    height--
  }
}

/**
 * Object $30: Vertical 2-wide column.
 * CODE_0DBB2C. Top=$61/$62, body=$63/$64 (page 1).
 */
function handleColumn2Wide(c: TileCursor, settings: number): void {
  let height = (settings >> 4) & 0x0F

  c.saveCol()
  // Top row
  c.setPage1()
  c.writeTileAdvanceCol(0x61)
  c.setPage1()
  c.writeTile(0x62)
  c.restoreCol()
  c.advanceRow()

  // Body rows
  while (height >= 0) {
    c.setPage1()
    c.writeTileAdvanceCol(0x63)
    c.setPage1()
    c.writeTile(0x64)
    c.restoreCol()
    c.advanceRow()
    height--
  }
}

/**
 * Object $31: Ground fill using tile $0E + object $0E's tile.
 * CODE_0DBB63. Just calls ground handler with objNum=$0E.
 */
function handleObj31(c: TileCursor, settings: number, rom: RomFile | undefined): void {
  handleGround(c, 0x0E, settings, rom)
}

/**
 * Object $3F: 3-tile pattern (left/body/right).
 * CODE_0DB5B7. Tiles from tables at $0DB5A8/$0DB5AD/$0DB5B2.
 */
function handleObj3F(c: TileCursor, settings: number, rom: RomFile | undefined): void {
  const width = (settings & 0x0F)
  const variant = (settings >> 4) & 0x0F

  const leftTile = romByte(rom, 0x0DB5A8 + variant)
  const bodyTile = romByte(rom, 0x0DB5AD + variant)
  const rightTile = romByte(rom, 0x0DB5B2 + variant)

  c.setPage0()
  c.writeTileAdvanceCol(leftTile)
  for (let w = width; w > 0; w--) {
    c.setPage0()
    c.writeTileAdvanceCol(bodyTile)
  }
  c.setPage0()
  c.writeTile(rightTile)
}

// ── Extended Object Handlers ───────────────────────────────────────────────

/**
 * Extended objects $10-$42: Single tile placement.
 * CODE_0DA57B/CODE_0DA5B1. Reads tile from $0DA548[extNum-$10].
 */
function handleExtSingleTile(c: TileCursor, extNum: number, rom: RomFile | undefined): void {
  const idx = extNum - 0x10
  const tileId = romByte(rom, 0x0DA548 + idx)
  if (tileId === 0 || tileId === TILE_EMPTY) return

  if (idx >= 0x13) c.setPage1()
  else c.setPage0()
  c.writeTile(tileId)
}

/**
 * Extended object $85: Yoshi's House tilemap.
 * CODE_0DEC33. Reads 160 bytes (10×16) from $0DEB93.
 */
function handleExtYoshiHouse(c: TileCursor, rom: RomFile): void {
  for (let r = 0; r < 10; r++) {
    c.saveCol()
    for (let col = 0; col < 16; col++) {
      const tileId = romByte(rom, 0x0DEB93 + r * 16 + col)
      c.setPage0()
      // This handler writes ALL 16 columns (including $25 empty)
      c.writeTileAdvanceCol(tileId)
    }
    c.restoreCol()
    c.advanceRow()
  }
}

// ── Main Dispatch ──────────────────────────────────────────────────────────

// Generic handler objects (CODE_0DB3E3 in tileset 0 dispatch)
const GENERIC_OBJECTS = new Set([
  0x18, 0x19, 0x1A, 0x1B,
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29,
  0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F,
])

export function expandObject(
  cursor: TileCursor,
  obj: LevelObject,
  rom?: RomFile,
): void {
  const { objectType, param } = obj

  if (objectType === 0x00) {
    // Extended object
    const extNum = param
    if (extNum === 0x85 && rom) {
      handleExtYoshiHouse(cursor, rom)
    } else if (extNum >= 0x10 && extNum <= 0x42) {
      handleExtSingleTile(cursor, extNum, rom)
    }
    // Other ext objects: TODO as needed

  } else if (objectType >= 0x01 && objectType <= 0x0E) {
    handleGround(cursor, objectType, param, rom)

  } else if (GENERIC_OBJECTS.has(objectType)) {
    handleGeneric(cursor, objectType, param, rom)

  } else if (objectType === 0x1C) {
    handleLedge(cursor, param, rom)

  } else if (objectType === 0x1D) {
    handleFenceTree(cursor, param)

  } else if (objectType === 0x1F) {
    handleVertPipe(cursor, param)

  } else if (objectType === 0x20) {
    handleHorizPipe(cursor, param)

  } else if (objectType === 0x11) {
    handleVertVine(cursor, param)

  } else if (objectType === 0x30) {
    handleColumn2Wide(cursor, param)

  } else if (objectType === 0x31) {
    handleObj31(cursor, param, rom)

  } else if (objectType === 0x3F) {
    handleObj3F(cursor, param, rom)

  } else {
    // Unimplemented: placeholder fill
    const width = (param & 0x0F)
    const height = (param >> 4) & 0x0F
    cursor.saveCol()
    for (let h = height; h >= 0; h--) {
      for (let w = width; w >= 0; w--) {
        cursor.setPage0()
        cursor.writeTileAdvanceCol(0x0F)
      }
      cursor.restoreCol()
      cursor.advanceRow()
    }
  }
}

/**
 * Expand all level objects into a tile grid.
 */
export function expandLevel(
  objects: LevelObject[],
  screens: number,
  rom?: RomFile,
): TileGrid {
  const grid = createGrid(screens)
  const cursor = new TileCursor(grid)

  for (const obj of objects) {
    cursor.setPosition(obj.screen, obj.y, obj.x % SCREEN_W)
    expandObject(cursor, obj, rom)
  }
  return grid
}
