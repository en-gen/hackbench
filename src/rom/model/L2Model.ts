/**
 * Everything a map's L2 (background) is drawn from, read from the ROM in one
 * place, beside `buildL1Inputs`. Both kinds the game loads: a preset image
 * (L2 pointer bank byte $FF, CODE_05801E) tiled across the map, and an object
 * stream expanded like L1's. The result is data, not pixels: ids into a Map16
 * table, plus the shift that puts L2 where the game shows it.
 */
import type { SmwRom } from '../SmwRom'
import { hex3s as hex3 } from '../hex'
import {
  isPresetPtr,
  l2PaletteOrForTileset,
  L2_EMPTY_TILE,
  loadL2Objects,
  loadL2Preset,
  readInitialLayer2YPos,
  readL2Pointer,
  tilePresetGrid,
} from '../L2Loader'
import { readInitialLayer1YPos } from '../L3Loader'
import { isLevelModeVerticalL2, SCREEN_H_VERT, SCREEN_W_VERT } from '../LevelParser'
import { readL2UploaderTable } from '../L2UploaderTable'
import { loadMap16Tiles, readL2Map16Table, type Map16Tile } from '../Map16'
import type { L1Inputs } from './L1Model'

export interface L2Inputs {
  kind: 'image' | 'objects'
  /** Map16 ids in the L1 grid's own layout (screens side by side, or stacked when vertical); null where empty. */
  grid: (number | null)[][]
  /** Definitions by id, with the tileset-3 palette OR already applied. */
  tiles: readonly (Map16Tile | undefined)[]
  /**
   * Pixels the grid sits below its row, `Layer1YPos - Layer2YPos` at level start (#113), image or
   * objects alike: Layer2YPos comes from DATA_05D70C either way (bank_05.asm:7323-7328).
   */
  dy: number
}

export type L2Result = { ok: true; l2: L2Inputs } | { ok: false; reason: string }

/**
 * The OR the strip uploader applies to every L2 object-stream subtile in
 * tileset 3 (bank_05.asm:1387-1391, 1503-1507), onto each definition.
 */
function withPaletteOr(tiles: readonly Map16Tile[], mask: number): Map16Tile[] {
  if (mask === 0) return [...tiles]
  const sub = (s: Map16Tile['tl']) => ({ ...s, palette: s.palette | mask })
  return tiles.map(t => ({ ...t, tl: sub(t.tl), tr: sub(t.tr), bl: sub(t.bl), br: sub(t.br) }))
}

/** Read one map's L2, or why it cannot be read. Never a vanilla fallback. */
export function buildL2Inputs(rom: SmwRom, index: number, l1: L1Inputs): L2Result {
  const refuse = (reason: string): L2Result => ({ ok: false, reason })
  const ptr = readL2Pointer(rom.rom, index)
  if (ptr === null) return refuse(`The L2 pointer of map ${hex3(index)} is outside the ROM`)
  const { screenCount: screens, isVertical, header } = l1
  // The level-start relation `Layer1YPos - Layer2YPos`, the view's representative frame; later
  // vertical scrolling moves L2 against L1 when VertLayer2Setting != 1. The high bytes follow the
  // ScreenMode the entry code builds from F600 bits 5-6 (bank_05.asm:7292-7299, 7379-7381), not the
  // VerticalTable, which the header parse applies later (:552-553). The values are the level's own
  // F400/F600; a sublevel reached by a secondary entrance takes its low bytes from FA00 and its high
  // byte from DATA_05FC00 (bank_05.asm:7147-7148, 7376-7388), which this view does not read (#505).
  const entryVertical = ((rom.rom.readByte(0x05f600 + index) ?? 0) & 0x20) !== 0
  const dy = (): number => readInitialLayer1YPos(rom.rom, index, entryVertical) - readInitialLayer2YPos(rom.rom, index, entryVertical) // prettier-ignore
  // The game picks the uploader by level mode (CODE_058955, bank_05.asm:1099-1135); the pointer's
  // bank byte must agree with it, or the map is one the game would draw differently (#506).
  const uploaders = readL2UploaderTable(rom.rom)
  if (!uploaders.ok) return refuse(uploaders.reason)
  const mode = header.levelMode & 0x1f
  const entry = uploaders.entries[mode]!
  const modeName = `level mode $${mode.toString(16).padStart(2, '0')}`
  if (entry.kind === 'unrecognized') {
    return refuse(`The L2 uploader for ${modeName} (at $${entry.target.toString(16)}) is not a routine this reader recognizes`) // prettier-ignore
  }
  if (entry.kind === 'none') return refuse(`${modeName} uploads no L2`)
  const preset = isPresetPtr(ptr)
  if (preset !== (entry.kind === 'image')) {
    return refuse(`${modeName} uploads an L2 ${entry.kind === 'image' ? 'image' : 'object stream'}, but the L2 pointer of ${hex3(index)} is ${preset ? 'an image' : 'an object stream'}`) // prettier-ignore
  }
  try {
    if (preset) {
      const image = loadL2Preset(rom.rom, ptr)
      if (!image) return refuse(`The background image at the L2 pointer of ${hex3(index)} cannot be read`) // prettier-ignore
      const table = readL2Map16Table(rom.rom)
      if (!table.ok) return refuse(`The background's Map16 table cannot be read: ${table.reason}`)
      const cols = isVertical ? SCREEN_W_VERT : screens * 16
      const rows = isVertical ? screens * SCREEN_H_VERT : 27
      return {
        ok: true,
        l2: { kind: 'image', grid: tilePresetGrid(image, cols, rows), tiles: loadMap16Tiles(rom.rom, table.value), dy: dy() }, // prettier-ignore
      }
    }
    const vertical = rom.getVerticalTable()
    if (!vertical.ok) return refuse(vertical.reason)
    const l2Vertical = isLevelModeVerticalL2(header.levelMode, vertical.table)
    if (l2Vertical !== isVertical) {
      return refuse(`L2 is ${l2Vertical ? 'vertical' : 'horizontal'} but L1 is ${isVertical ? 'vertical' : 'horizontal'}; the two cannot share one screen layout`) // prettier-ignore
    }
    const objects = loadL2Objects(rom.rom, ptr, screens, header.objectTileset, l2Vertical)
    if (!objects) return refuse(`The L2 object stream of ${hex3(index)} cannot be read`)
    return {
      ok: true,
      l2: {
        kind: 'objects',
        grid: objects.grid.map(row => row.map(id => (id === L2_EMPTY_TILE ? null : id))),
        tiles: withPaletteOr(l1.map16.tiles, l2PaletteOrForTileset(header.objectTileset)),
        dy: dy(),
      },
    }
  } catch (err) {
    return refuse(`The background of ${hex3(index)} could not be read: ${(err as Error).message}`)
  }
}
