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

import { LevelObject, SCREEN_W, SCREEN_H, SCREEN_W_VERT, SCREEN_H_VERT } from './LevelParser'
import { RomFile } from './RomFile'
import { makeCursor, OWNER_NONE, OwnerGrid, TileGrid } from './objectHandlers/cursor'
import { dispatchStandard, dispatchExtended } from './objectHandlers/dispatch'

/** Empty tile = $25 (bank_05.asm CODE_05801E fills the level map with #$25). */
export const TILE_EMPTY = 0x25
/** Sentinel used during debugging for unmapped objects. Not emitted in production. */
export const TILE_UNKNOWN = 0x00

/** SNES address of the DATA_05F200 secondary-entrance attribute table (bank_05.asm:9287). */
const DATA_05F200_ADDR = 0x05_f200

/**
 * Read Layer3Setting for a level from DATA_05F200 (bank_05.asm line 9287).
 *
 * Layer3Setting is a 2-bit value stored in bits 7:6 of DATA_05F200[levelNum].
 * The ASM extracts it with: AND #$C0; CLC; ASL; ROL; ROL - equivalent to >> 6.
 * Non-zero values cause CODE_009FB8 to call CODE_00A045 every gameplay frame,
 * which zeroes the OWLayer1VramBuffer region ($7EE400–$7EFDFF). This region
 * overlaps the Map16 tile buffer at screen 16+ in the row-major WRAM layout
 * (stride $1B0 per screen), which is why Mesen fixtures show tile $000 rather
 * than the init value $025 at those addresses.
 *
 * TODO: longer-term this should migrate to a model layer that exposes all
 * secondary-entrance attributes, not just Layer3Setting.
 */
export function readLayer3Setting(rom: RomFile, levelNum: number): number {
  const byte = rom.readByte(DATA_05F200_ADDR + levelNum) ?? 0
  return (byte & 0xc0) >> 6
}

export type { TileGrid, OwnerGrid } from './objectHandlers/cursor'
export { OWNER_NONE } from './objectHandlers/cursor'

const MAP16_OW_L1_VRAM_BUFFER_OFFSET = 0x1c00 // OWLayer1VramBuffer − Map16TilesLow
const MAP16_BYTES_PER_SCREEN_H = 0x1b0 // 27 rows × 16 cols

/**
 * CODE_00A045 (bank_00.asm) zeroes OWLayer1VramBuffer in batches.  Each batch
 * writes $58 words (= $B0 bytes) then skips $100 bytes before the next batch,
 * producing a skip-$100 / write-$B0 pattern that repeats every $1B0 bytes.
 *
 * Byte at OWLayer1VramBuffer+off is zeroed iff (off % $1B0) < $B0.
 */
const MAP16_OW_L1_ZERO_BATCH_SIZE = 0xb0 // bytes zeroed per $1B0-stride batch

/**
 * Number of extra screens appended to a horizontal grid when layer3Setting is
 * non-zero. Two screens (32 columns) covers the Lua auto-walker's right-pad
 * window (RIGHT_PAD = 20 tiles) that may extend past the level boundary.
 */
const OVERFLOW_SCREENS = 2

/**
 * Create a blank level grid filled with TILE_EMPTY.
 *   Horizontal (default): screens * 16 cols, 27 rows.
 *   Vertical:              32 cols, screens * 16 rows.
 *
 * When layer3Setting is non-zero, OVERFLOW_SCREENS extra screens are appended.
 * Each cell in the overflow region is initialised based on its WRAM address in
 * the row-major Map16 layout (stride $1B0 per screen):
 *   - If wramOffset < $1C00 (before OWLayer1VramBuffer): tile = TILE_EMPTY
 *   - If wramOffset >= $1C00 and (off % $1B0) < $B0:    tile = $000 (zeroed)
 *   - If wramOffset >= $1C00 and (off % $1B0) >= $B0:   tile = TILE_EMPTY
 * The batch pattern comes from CODE_00A045 (bank_00.asm): it writes $58 words
 * ($B0 bytes) then skips $100 bytes, repeating every $1B0 bytes within
 * OWLayer1VramBuffer.  The level-init code (CODE_058074) filled ALL WRAM with
 * $25 beforehand, so un-zeroed cells in the overflow area retain TILE_EMPTY.
 *
 * NOTE: this is a rendering-accuracy approximation.  The $000 values come from
 * a Layer 3 runtime routine, not from object loading.  A cleaner long-term home
 * would be src/rom/model/tiles/ once that layer exists.
 * TODO: migrate to src/rom/model/tiles/ when that module is introduced.
 */
export function createGrid(screens: number, isVertical = false, layer3Setting = 0): TileGrid {
  const cols = isVertical ? SCREEN_W_VERT : screens * SCREEN_W
  const rows = isVertical ? screens * SCREEN_H_VERT : SCREEN_H
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(TILE_EMPTY))

  if (!isVertical && layer3Setting !== 0) {
    // Append OVERFLOW_SCREENS extra screens.  For each overflow cell compute
    // whether CODE_00A045 would have zeroed it (batch-skip pattern).
    for (let s = 0; s < OVERFLOW_SCREENS; s++) {
      const overflowScreen = screens + s
      for (let r = 0; r < SCREEN_H; r++) {
        const wramOffset = overflowScreen * MAP16_BYTES_PER_SCREEN_H + r * SCREEN_W
        const owlBufOff = wramOffset - MAP16_OW_L1_VRAM_BUFFER_OFFSET
        const zeroed =
          owlBufOff >= 0 && owlBufOff % MAP16_BYTES_PER_SCREEN_H < MAP16_OW_L1_ZERO_BATCH_SIZE
        const fillValue = zeroed ? 0x00 : TILE_EMPTY
        for (let c = 0; c < SCREEN_W; c++) {
          grid[r].push(fillValue)
        }
      }
    }
  }

  return grid
}

/**
 * Expand a single level object into the grid.
 * Dispatches via the ROM's pointer tables (tileset dispatch → handler table).
 *
 * Pass `owners` and `owner` to record which object drew each cell. Both are
 * optional: callers that only want tiles pay nothing for the bookkeeping.
 */
export function expandObject(
  grid: TileGrid,
  obj: LevelObject,
  rom: RomFile,
  tileset: number,
  owners: OwnerGrid | null = null,
  owner: number = OWNER_NONE,
): void {
  if (obj.type === 'extended') {
    // For extended objects, LevelParser stores the extended type in `objectNumber`
    // (per its comment) and the raw settings byte in `settings`. The ASM's
    // dispatch uses LvlLoadObjSize as the selector, which maps to our objectNumber.
    const cur = makeCursor(
      grid,
      rom,
      tileset,
      obj.x,
      obj.y,
      obj.objectNumber,
      obj.settings,
      owners,
      owner,
    )
    dispatchExtended(cur)
  } else {
    const cur = makeCursor(
      grid,
      rom,
      tileset,
      obj.x,
      obj.y,
      obj.objectNumber,
      obj.settings,
      owners,
      owner,
    )
    dispatchStandard(cur)
  }
}

/**
 * Number of screens the game renders for boss-arena level modes.
 *
 * Modes 9 and 11 have only 1 screen in their L1 header (levelLength=1), but
 * the game's mode-init routine (bank_00.asm MakeMode7BossArenaMap16 /
 * MakeASolidFloor) writes tiles to BOTH screen 0 (offset X) and screen 1
 * (offset X+$1B0).  We therefore create a 2-screen grid for these modes so
 * the second half of the arena is visible.
 */
const BOSS_ARENA_SCREENS = 2

/**
 * Pre-fill tiles for Mode-9 boss arenas (Roy / Morton / Ludwig / Reznor).
 *
 * bank_00.asm CODE_009925 / CODE_009A17 (line 3006):
 *   LDX #$B0  → row 11, col 0
 *   16 × tile $032 at row 11, cols 0-15 (screen 0) and cols 16-31 (screen 1)
 *   LDX reset to $D0 → row 13, col 0
 *   16 × tile $05  at row 13, cols 0-15 and cols 16-31
 */
function applyMode9BossArena(grid: TileGrid): void {
  const fillRow = (row: number, tile: number): void => {
    const r = grid[row]
    if (!r) return
    for (let c = 0; c < 32 && c < r.length; c++) r[c] = tile
  }
  fillRow(11, 0x32) // bridge floor (MakeMode7BossArenaMap16 LDA #$32)
  fillRow(13, 0x05) // lava / solid floor (MakeASolidFloor LDA #$05, X=$D0)
}

/**
 * Pre-fill tiles for Mode-11 boss arenas (Iggy / Larry).
 *
 * bank_00.asm .IggyLarry branch (line 2784):
 *   LDX #$50  → row 5, col 0
 *   16 × tile $05 at row 5, cols 0-15 (screen 0) and cols 16-31 (screen 1)
 */
function applyMode11BossArena(grid: TileGrid): void {
  const r = grid[5]
  if (!r) return
  for (let c = 0; c < 32 && c < r.length; c++) r[c] = 0x05
}

/**
 * Expand every object in the level stream into a 2D Map16 tile grid.
 *
 * The caller is expected to pass the level header's `objectTileset` so
 * tileset-specific dispatch resolves correctly. For vertical levels the
 * grid is 32 wide × (screens*16) tall instead of (screens*16) × 27.
 *
 * Pass `levelMode` (5-bit mode from L1 header byte 1) to enable boss-arena
 * pre-fills for modes 9 and 11.  Pass `levelNum` to read the Level3Setting
 * flag from DATA_05F200, which controls whether the OW Layer1 VRAM buffer is
 * zeroed (needed for correct tile output in maps like $002 and $127).
 */
export function expandMap(
  objects: LevelObject[],
  screens: number,
  rom: RomFile,
  tileset = 0,
  isVertical = false,
  levelMode?: number,
  levelNum?: number,
): TileGrid {
  return expandMapOwned(objects, screens, rom, tileset, isVertical, levelMode, levelNum).grid
}

/** A tile grid plus the record of which object drew each of its cells. */
export interface ExpandedMap {
  grid: TileGrid
  owners: OwnerGrid
}

/**
 * expandMap, plus the owner grid the editor needs to make a click mean
 * something.
 *
 * Same expansion, same tiles; the only addition is that each handler's writes
 * are attributed to the object that triggered them. Boss-arena pre-fills and
 * the Layer 3 overflow region happen before any object runs, so those cells
 * stay OWNER_NONE and clicking them selects nothing, which is correct: no
 * object drew them and no object edit can change them.
 */
export function expandMapOwned(
  objects: LevelObject[],
  screens: number,
  rom: RomFile,
  tileset = 0,
  isVertical = false,
  levelMode?: number,
  levelNum?: number,
): ExpandedMap {
  // Boss-arena modes override the header screen count.
  const effectiveScreens = levelMode === 9 || levelMode === 11 ? BOSS_ARENA_SCREENS : screens
  const layer3Setting = !isVertical && levelNum !== undefined ? readLayer3Setting(rom, levelNum) : 0
  const grid = createGrid(effectiveScreens, isVertical, layer3Setting)

  // Boss-arena levels write tiles via game-mode init, not object handlers.
  if (levelMode === 9) applyMode9BossArena(grid)
  else if (levelMode === 11) applyMode11BossArena(grid)

  const owners: OwnerGrid = grid.map(row => new Array<number>(row.length).fill(OWNER_NONE))

  for (let i = 0; i < objects.length; i++) {
    expandObject(grid, objects[i], rom, tileset, owners, i)
  }
  return { grid, owners }
}
