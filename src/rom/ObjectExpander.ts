/**
 * ObjectExpander.ts -- Converts a level's object stream into a 2D Map16 tile grid
 * by dispatching each object to its ported SMW handler.
 *
 * Faithful port of the level-loading pipeline in bank_0D.asm:
 *   1. parseLevelObjects gives us a list of LevelObjects (type + objectNumber +
 *      settings + position).
 *   2. For each object we build a Cursor at (x, y) carrying the handler's
 *      register state (LvlLoadObjNo, LvlLoadObjSize, ObjectTileset).
 *   3. dispatchStandard / dispatchExtended look up the handler's ROM address in
 *      the ROM's own pointer tables, then call the matching TS port.
 *
 * See objectHandlers/ for cursor semantics, ROM-sourced data tables, and each
 * ported handler.
 */

import { LevelObject, SCREEN_W, SCREEN_H } from './LevelParser'
import { RomFile } from './RomFile'
import { makeCursor, TileGrid } from './objectHandlers/cursor'
import { dispatchStandard, dispatchExtended } from './objectHandlers/dispatch'

/** Empty tile = $25 (bank_05.asm CODE_05801E fills the level map with #$25). */
export const TILE_EMPTY = 0x25
/** Sentinel used during debugging for unmapped objects. Not emitted in production. */
export const TILE_UNKNOWN = 0x00

export type { TileGrid } from './objectHandlers/cursor'

/** Create a blank level grid filled with TILE_EMPTY. */
export function createGrid(screens: number): TileGrid {
  const cols = screens * SCREEN_W
  return Array.from({ length: SCREEN_H }, () => new Array(cols).fill(TILE_EMPTY))
}

/**
 * Expand a single level object into the grid.
 * Dispatches via the ROM's pointer tables (tileset dispatch → handler table).
 */
export function expandObject(
  grid: TileGrid, obj: LevelObject, rom: RomFile, tileset: number,
): void {
  if (obj.type === 'extended') {
    // For extended objects, LevelParser stores the extended type in `objectNumber`
    // (per its comment) and the raw settings byte in `settings`. The ASM's
    // dispatch uses LvlLoadObjSize as the selector, which maps to our objectNumber.
    const cur = makeCursor(grid, rom, tileset, obj.x, obj.y, obj.objectNumber, obj.settings)
    dispatchExtended(cur)
  } else {
    const cur = makeCursor(grid, rom, tileset, obj.x, obj.y, obj.objectNumber, obj.settings)
    dispatchStandard(cur)
  }
}

/**
 * Expand every object in the level stream into a 2D Map16 tile grid.
 *
 * The caller is expected to pass the level header's `objectTileset` so
 * tileset-specific dispatch resolves correctly.
 */
export function expandMap(
  objects: LevelObject[], screens: number, rom: RomFile, tileset = 0,
): TileGrid {
  const grid = createGrid(screens)
  for (const obj of objects) {
    expandObject(grid, obj, rom, tileset)
  }
  return grid
}
