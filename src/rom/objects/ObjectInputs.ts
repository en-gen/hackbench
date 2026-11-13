/**
 * The inputs the Object finder reads for one map (#1237) and the plain-words refusals around it.
 *
 * Read-only and through the same expander as the map view, so the visible grid is the one on screen;
 * the owner grid and the per-piece footprint are what the view does not keep.
 */
import { expandMapOwned, type SwitchFlags } from '../ObjectExpander'
import type { Footprint, OwnerGrid, TileGrid } from '../objectHandlers/cursor'
import { drawInterpreted } from '../objectHandlers/interpretedDraw'
import { VANILLA_PRIMITIVES } from '../objectHandlers/interpret'
import { isLevelModeVertical, parseLevelHeader, parseLevelObjects } from '../LevelParser'
import { L2_PRESET_CMP_SITE, OPCODE_CMP_IMM } from '../L2Loader'
import { map16TileCapacity, MAP16_TOTAL_TILES } from '../Map16'
import { readActsLikeTable } from '../ActsLikeLoader'
import { marioTileSolidity, PSWITCH_INACTIVE } from '../MarioTileDispatch'
import { readSlopeTables, resolveSlope } from '../SlopeResolver'
import type { RomFile } from '../RomFile'
import type { SmwRom } from '../SmwRom'
import type { SlopeOf } from './Outline'

export const PER_LEVEL_MAP16 = "Objects can't be found on this map: it uses custom per-map tiles."

/**
 * Why Objects cannot be found on this ROM, or null. Round 1 targets a stock Map16 loader: 512 tiles
 * and the unhooked level-load compare at $05803B (SMWDisX bank_05.asm:33). A Lunar Magic hijack there,
 * or an expanded or unreadable Map16 table, may give a map its own tiles, and matching on them would
 * be wrong, so it refuses until the hacks milestone traces the loader [PROP, owner-approved].
 */
export function objectsRefusal(rom: RomFile): string | null {
  const capacity = map16TileCapacity(rom)
  if ('reason' in capacity || capacity.count !== MAP16_TOTAL_TILES) return PER_LEVEL_MAP16
  return rom.readByte(L2_PRESET_CMP_SITE) === OPCODE_CMP_IMM ? null : PER_LEVEL_MAP16
}

/**
 * Each tile slope class from the game own tables (DATA_00E632 through the acts-like low byte,
 * bank_00.asm:12334-12381; the same read the Tile model makes): the rise over 15 pixels, to two
 * places, so the two half tiles of a gentle slope share one class. Null for a tile that is flat or
 * not a Mario-solid slope tile.
 */
export function slopeClassOf(rom: RomFile, tileset: number): SlopeOf {
  const acts = readActsLikeTable(rom)
  const tables = readSlopeTables(rom)
  const memo = new Map<number, number | null>()
  return tile => {
    if (memo.has(tile)) return memo.get(tile)!
    const like = acts.get(tile) ?? tile
    let out: number | null = null
    if (marioTileSolidity(like & 0xff, (like >> 8) & 0xff, PSWITCH_INACTIVE)) {
      const s = resolveSlope(like & 0xff, tileset, tables)
      if (s) {
        const rise = Math.round(((s.heights[15]! - s.heights[0]!) / 15) * 100) / 100
        out = rise === 0 ? null : rise
      }
    }
    memo.set(tile, out)
    return out
  }
}

export type ObjectInputs =
  | {
      ok: true
      grid: TileGrid
      owners: OwnerGrid
      footprint: Footprint
      /** The level header foreground tileset. */
      tileset: number
    }
  | { ok: false; reason: string }

/** Expand one map with the owner grid and the footprint collected. */
export function readObjectInputs(rom: SmwRom, index: number, flags: SwitchFlags): ObjectInputs {
  const refuse = (reason: string): ObjectInputs => ({ ok: false, reason })
  const why = objectsRefusal(rom.rom)
  if (why) return refuse(why)
  const raw = rom.getLevelRawData(index)
  if (!raw) return refuse("Objects can't be found on this map: its data could not be read.")
  const table = rom.getVerticalTable()
  if (!table.ok) return refuse(table.reason)
  try {
    const header = parseLevelHeader(raw)
    const { objects } = parseLevelObjects(raw, table.table)
    const vertical = isLevelModeVertical(header.levelMode, table.table)
    const footprint: Footprint = []
    const sink = { unverified: [] as string[], draw: drawInterpreted, primitives: VANILLA_PRIMITIVES } // prettier-ignore
    const { grid, owners } = expandMapOwned(objects, header.levelLength, rom.rom, header.objectTileset, vertical, header.levelMode, undefined, flags, sink, footprint) // prettier-ignore
    return { ok: true, grid, owners, footprint, tileset: header.objectTileset }
  } catch (err) {
    return refuse(`Objects can't be found on this map: ${(err as Error).message}`)
  }
}
