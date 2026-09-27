/**
 * Pure decode for the Overworld view, shaped like gfx-decode.ts: no Theia.
 *
 * One tileset and one palette for the whole canvas, window 0's: its object
 * tileset (DATA_04DC02[0], read through CODE_04DC09's own operand) and its
 * CGRAM. The CGRAM is built as the overworld load leaves it: CODE_00AD25
 * (bank_00.asm:5736-5790) writes four blocks over whatever LoadPalette left
 * from the title screen map, so the title map's header seeds buildLevelCgram
 * and loadAreaPalette's four blocks are laid over it.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { buildLevelCgram, loadRomPalettes, type RgbaRow } from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { findSpecialMaps } from '../../../../src/rom/SpecialMaps'
import { loadAreaPalette, loadOverworldAreas } from '../../../../src/rom/OverworldLoader'
import {
  OW_L1_COLS,
  OW_L1_ROWS,
  composeOverworldL1Grid,
  readOverworldL1,
  renderOverworldL1,
} from '../../../../src/rom/OverworldL1'
import type { OverworldL1Dto } from '../common/overworld-protocol'

/** The cells CODE_00AD25 writes, as [row0, row1, col0, col1] inclusive
 * (bank_00.asm:5762-5788): HUD, OWStdColors, OverworldColors[area], OWStdColors2. */
const OW_BLOCKS: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 8, 15],
  [2, 7, 9, 15],
  [4, 7, 1, 7],
  [8, 15, 1, 7],
]

const unavailable = (reason: string): OverworldL1Dto => ({ status: 'unavailable', reason })

/** Window 0's CGRAM over the title map's, or why it cannot be built. */
function window0Cgram(rom: SmwRom): RgbaRow[] | string {
  const special = findSpecialMaps(rom.rom)
  const title = special.maps.find(m => m.role === 'title-screen')
  if (!title) return special.notes.find(n => n.startsWith('Title')) ?? 'No title screen map.'
  const raw = rom.getLevelRawData(title.index)
  if (!raw) return `The title screen map's header is unreadable.`
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) return `Palette column 1 is unavailable: ${col1.reason}`
  const h = parseLevelHeader(raw)
  const rows = buildLevelCgram(
    loadRomPalettes(rom.rom),
    h.bgPalette,
    h.fgPalette,
    h.spritePalette,
    col1,
  ).rows
  const ow = loadAreaPalette(rom.rom, loadOverworldAreas(rom.rom)[0]!, false)
  for (const [r0, r1, c0, c1] of OW_BLOCKS)
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) rows[r]![c] = ow[r]![c]!
  return rows
}

export function decodeOverworldL1(rom: SmwRom): OverworldL1Dto {
  const l1 = readOverworldL1(rom.rom)
  if (!l1.ok) return unavailable(l1.reason)
  const cgram = window0Cgram(rom)
  if (typeof cgram === 'string') return unavailable(cgram)

  const vram = loadVram(rom.rom, l1.objectTileset, l1.spriteTileset)
  const grid = composeOverworldL1Grid(l1.tileData, l1.charData)
  const rgba = renderOverworldL1(grid, vram, { colors: cgram.flat() })
  return {
    status: 'ok',
    width: OW_L1_COLS * 16,
    height: OW_L1_ROWS * 16,
    rgbaBase64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64'),
    objectTileset: l1.objectTileset,
  }
}
