/**
 * The Map16 tile each switch palace's block draws, uncleared and cleared,
 * read by running the ROM's own object through its own dispatch: whichever
 * object numbers this ROM routes to the block routine (CODE_0DB583,
 * CODE_0DB58B, CODE_0DB916, CODE_0DB91E), expanded both ways. The tile ids
 * therefore come from DATA_0DB587/89 and DATA_0DB91A/1C through the #567
 * readers, never from `$06A + color`.
 */
import type { RomFile } from './RomFile'
import type { LevelObject } from './LevelParser'
import {
  createGrid,
  expandObject,
  OWNER_NONE,
  SWITCH_FLAGS_UNCLEARED,
  TILE_EMPTY,
} from './ObjectExpander'
import { objectsDispatchedTo, type HandlerFn } from './objectHandlers/dispatch'
import { handle_0DB583, handle_0DB58B } from './objectHandlers/extendedHandlers'
import { handle_0DB916, handle_0DB91E } from './objectHandlers/standardHandlers'

export type Palace = 'yellow' | 'green' | 'red' | 'blue'
export const PALACES: readonly Palace[] = ['yellow', 'green', 'red', 'blue']

const ROUTINE: Record<Palace, HandlerFn> = {
  yellow: handle_0DB583,
  green: handle_0DB58B,
  blue: handle_0DB916,
  red: handle_0DB91E,
}

export type SwitchBlockTile = { uncleared: number; cleared: number } | { reason: string }

export function switchBlockTile(rom: RomFile, tileset: number, palace: Palace): SwitchBlockTile {
  const obj = objectsDispatchedTo(rom, tileset, ROUTINE[palace])[0]
  if (!obj) return { reason: `No object in this ROM reaches the ${palace} switch-block routine` }
  const draw = (cleared: boolean): number => {
    const grid = createGrid(1)
    const placed = { ...obj, x: 0, y: 0, screen: 0, settings: 0, raw: [] } as unknown as LevelObject
    const flags = { ...SWITCH_FLAGS_UNCLEARED, [palace]: cleared }
    expandObject(grid, placed, rom, tileset, null, OWNER_NONE, flags)
    return grid[0]![0]!
  }
  const uncleared = draw(false)
  const cleared = draw(true)
  if (uncleared === TILE_EMPTY || cleared === TILE_EMPTY) {
    return {
      reason: `The ${palace} switch-block routine is not the stock one, so its tile is unknown`,
    }
  }
  return { uncleared, cleared }
}
