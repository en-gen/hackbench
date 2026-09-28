/**
 * Pure decode for the Overworld view, shaped like gfx-decode.ts: no Theia.
 * Area 0's tileset and CGRAM for the whole canvas (docs/rom/overworld.md).
 * An L1 (foreground) or palette it cannot interpret refuses the view with a
 * reason; an unreadable L2 (background) is left out, with its reason.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { gfxSource, loadVram } from '../../../../src/rom/GfxLoader'
import { buildLevelCgram, loadRomPalettes, type RgbaRow } from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { findSpecialMaps } from '../../../../src/rom/SpecialMaps'
import { overworldCgram } from '../../../../src/rom/OverworldLoader'
import {
  OW_CANVAS_H,
  OW_CANVAS_W,
  composeOverworldL1Grid,
  readOverworldL1,
} from '../../../../src/rom/OverworldL1'
import { drawOverworldLayers, readOverworldL2 } from '../../../../src/rom/OverworldL2'
import type { OwLayerPixels } from '../../../../src/rom/render/OverworldComposite'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import type { OverworldDto, OverworldLayerDto } from '../common/gfx-protocol'

const unavailable = (reason: string): OverworldDto => ({ status: 'unavailable', reason })
const b64 = (a: Uint8Array | Uint8ClampedArray): string =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64')
const layerDto = (px: OwLayerPixels): OverworldLayerDto => ({
  rgbaBase64: b64(px.rgba),
  prioBase64: b64(px.prio),
})

/** LoadPalette's result for the title screen map, which CODE_00AD25 draws over,
 *  and its back area color as the backdrop (CGRAM color 0). */
function titleCgram(rom: SmwRom): { rows: RgbaRow[]; backdrop: RgbaColor } | string {
  const special = findSpecialMaps(rom.rom)
  const title = special.maps.find(m => m.role === 'title-screen')
  if (!title) return special.notes.find(n => n.startsWith('Title')) ?? 'No title screen map.'
  const raw = rom.getLevelRawData(title.index)
  if (!raw) return `The title screen map's header is unreadable.`
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) return `Palette column 1 is unavailable: ${col1.reason}`
  const h = parseLevelHeader(raw)
  const palettes = loadRomPalettes(rom.rom, h.bgColor)
  const { rows } = buildLevelCgram(palettes, h.bgPalette, h.fgPalette, h.spritePalette, col1)
  return { rows, backdrop: palettes.backAreaColor }
}

/** Replacement recognized builds, for a synthetic ROM. */
export interface OverworldViewFingerprints {
  cgram?: readonly string[]
  l2?: readonly string[]
}

export function decodeOverworld(rom: SmwRom, fps: OverworldViewFingerprints = {}): OverworldDto {
  const l1 = readOverworldL1(rom.rom)
  if (!l1.ok) return unavailable(l1.reason)
  const gfx = gfxSource(rom.rom)
  if (!gfx.ok) return unavailable(`The overworld GFX cannot be read: ${gfx.reason}`)
  if (gfx.sites.hooked) {
    return unavailable(
      "This ROM loads the overworld's GFX files through Lunar Magic's ExGFX hook in " +
        'UploadSpriteGFX (bank_00.asm:4334), which picks them from a list HackBench ' +
        "doesn't read yet.",
    )
  }
  const base = titleCgram(rom)
  if (typeof base === 'string') return unavailable(base)
  const cgram = overworldCgram(rom.rom, l1.objectTileset, base.rows, fps.cgram)
  if (typeof cgram === 'string') return unavailable(cgram)

  const l2 = readOverworldL2(rom.rom, fps.l2)
  const vram = loadVram(rom.rom, l1.objectTileset, l1.spriteTileset)
  const grid = composeOverworldL1Grid(l1.tileData, l1.charData)
  const layers = drawOverworldLayers(grid, l2.ok ? l2.tilemap : null, vram, {
    colors: cgram.flat(),
  })
  return {
    status: 'ok',
    width: OW_CANVAS_W,
    height: OW_CANVAS_H,
    backdrop: [...base.backdrop],
    l1: layerDto(layers.l1),
    ...(layers.l2 ? { l2: layerDto(layers.l2) } : {}),
    ...(l2.ok ? {} : { l2Unavailable: l2.reason }),
  }
}
