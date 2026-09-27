/**
 * Pure decode for the Overworld view, shaped like gfx-decode.ts: no Theia.
 * Area 0's tileset and CGRAM for the whole canvas (docs/rom/overworld-l1.md).
 * Anything it cannot interpret is refused with a reason, palette seed included.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { gfxSource, levelGfxAssignmentNote, loadVram } from '../../../../src/rom/GfxLoader'
import { buildLevelCgram, loadRomPalettes, type RgbaRow } from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { findSpecialMaps } from '../../../../src/rom/SpecialMaps'
import { overworldCgram } from '../../../../src/rom/OverworldLoader'
import {
  OW_L1_COLS,
  composeOverworldL1Grid,
  readOverworldL1,
} from '../../../../src/rom/OverworldL1'
import { buildTileAtlas } from '../../../../src/rom/TileRenderer'
import type { OverworldL1Dto } from '../common/gfx-protocol'

const unavailable = (reason: string): OverworldL1Dto => ({ status: 'unavailable', reason })

/** LoadPalette's result for the title screen map, which CODE_00AD25 draws over. */
function titleCgram(rom: SmwRom): RgbaRow[] | string {
  const special = findSpecialMaps(rom.rom)
  const title = special.maps.find(m => m.role === 'title-screen')
  if (!title) return special.notes.find(n => n.startsWith('Title')) ?? 'No title screen map.'
  const raw = rom.getLevelRawData(title.index)
  if (!raw) return `The title screen map's header is unreadable.`
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) return `Palette column 1 is unavailable: ${col1.reason}`
  const h = parseLevelHeader(raw)
  return buildLevelCgram(loadRomPalettes(rom.rom), h.bgPalette, h.fgPalette, h.spritePalette, col1)
    .rows
}

/** @param cgramFingerprints Replaces CODE_00AD25's recognized builds; for a synthetic ROM. */
export function decodeOverworldL1(
  rom: SmwRom,
  cgramFingerprints?: readonly string[],
): OverworldL1Dto {
  const l1 = readOverworldL1(rom.rom)
  if (!l1.ok) return unavailable(l1.reason)
  const gfx = gfxSource(rom.rom)
  if (!gfx.ok) return unavailable(`The overworld GFX cannot be read: ${gfx.reason}`)
  const note = levelGfxAssignmentNote(rom.rom)
  if (note) return unavailable(note)
  const base = titleCgram(rom)
  if (typeof base === 'string') return unavailable(base)
  const cgram = overworldCgram(rom.rom, l1.objectTileset, base, cgramFingerprints)
  if (typeof cgram === 'string') return unavailable(cgram)

  const vram = loadVram(rom.rom, l1.objectTileset, l1.spriteTileset)
  const grid = composeOverworldL1Grid(l1.tileData, l1.charData)
  const { atlas, atlasWidth, atlasHeight } = buildTileAtlas(
    grid,
    vram,
    { colors: cgram.flat() },
    OW_L1_COLS,
  )
  return {
    status: 'ok',
    width: atlasWidth,
    height: atlasHeight,
    rgbaBase64: Buffer.from(atlas.buffer, atlas.byteOffset, atlas.byteLength).toString('base64'),
  }
}
