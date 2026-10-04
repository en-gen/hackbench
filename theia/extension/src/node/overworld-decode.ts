/**
 * Pure decode for the Overworld view, shaped like gfx-decode.ts: no Theia.
 * The hub (half 0) and each area's camera window over half 1, each in its own tileset
 * and CGRAM (docs/rom/overworld.md).
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
import { composeOverworldL1Grid, readOverworldL1 } from '../../../../src/rom/OverworldL1'
import {
  drawOverworldHalf,
  readOverworldL2,
  type OwHalfLayers,
} from '../../../../src/rom/OverworldL2'
import { deriveOverworldAreas } from '../../../../src/rom/OverworldAreas'
import { OW_WINDOW_H, OW_WINDOW_W, cropWindow } from '../../../../src/rom/OverworldWindow'
import {
  OW_HALF_H,
  OW_HALF_W,
  type OwLayerPixels,
} from '../../../../src/rom/render/OverworldComposite'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import type { OverworldAreasDto, OverworldDto, OverworldLayerDto } from '../common/gfx-protocol'

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

/**
 * Area `area`'s L1 and L2 on half `half`, in that area's own tileset and palette (the game loads
 * one area's at a time), or why they cannot be read. Per-area refusals carry the reason.
 */
export function drawOverworldArea(
  rom: SmwRom,
  area: number,
  half: 0 | 1,
  fps: OverworldViewFingerprints,
): { backdrop: number[]; layers: OwHalfLayers; l2Unavailable?: string } | { reason: string } {
  const l1 = readOverworldL1(rom.rom, area)
  if (!l1.ok) return { reason: l1.reason }
  const gfx = gfxSource(rom.rom)
  if (!gfx.ok) return { reason: `The overworld GFX cannot be read: ${gfx.reason}` }
  if (gfx.sites.hooked) {
    return {
      reason:
        "This ROM loads the overworld's GFX files through Lunar Magic's ExGFX hook in " +
        'UploadSpriteGFX (bank_00.asm:4334), which picks them from a list HackBench ' +
        "doesn't read yet.",
    }
  }
  const base = titleCgram(rom)
  if (typeof base === 'string') return { reason: base }
  const cgram = overworldCgram(rom.rom, l1.objectTileset, base.rows, fps.cgram)
  if (typeof cgram === 'string') return { reason: cgram }

  const l2 = readOverworldL2(rom.rom, fps.l2)
  const vram = loadVram(rom.rom, l1.objectTileset, l1.spriteTileset)
  const grid = composeOverworldL1Grid(l1.tileData, l1.charData)
  const layers = drawOverworldHalf(half, grid, l2.ok ? l2.tilemap : null, vram, {
    colors: cgram.flat(),
  })
  return {
    backdrop: [...base.backdrop],
    layers,
    ...(l2.ok ? {} : { l2Unavailable: l2.reason }),
  }
}

/** The hub: half 0 in area 0's tileset and palette, one 512x512 canvas. */
export function decodeOverworld(rom: SmwRom, fps: OverworldViewFingerprints = {}): OverworldDto {
  const d = drawOverworldArea(rom, 0, 0, fps)
  if ('reason' in d) return unavailable(d.reason)
  return {
    status: 'ok',
    backdrop: d.backdrop,
    width: OW_HALF_W,
    height: OW_HALF_H,
    prioCell: 8,
    l1: layerDto(d.layers.l1),
    ...(d.layers.l2 ? { l2: layerDto(d.layers.l2) } : {}),
    ...(d.l2Unavailable ? { l2Unavailable: d.l2Unavailable } : {}),
  }
}

/** An area's camera window over half 1, in the area's own tileset and palette. */
export function decodeOverworldArea(
  rom: SmwRom,
  area: { area: number; cameraX: number; cameraY: number },
  fps: OverworldViewFingerprints = {},
): OverworldDto {
  const d = drawOverworldArea(rom, area.area, 1, fps)
  if ('reason' in d) return unavailable(d.reason)
  const crop = (l: OwLayerPixels): OwLayerPixels => cropWindow(l, area.cameraX, area.cameraY)
  return {
    status: 'ok',
    backdrop: d.backdrop,
    width: OW_WINDOW_W,
    height: OW_WINDOW_H,
    prioCell: 1,
    l1: layerDto(crop(d.layers.l1)),
    ...(d.layers.l2 ? { l2: layerDto(crop(d.layers.l2)) } : {}),
    ...(d.l2Unavailable ? { l2Unavailable: d.l2Unavailable } : {}),
  }
}

/** The explorer's child rows: the areas the ROM names (area 0 is the Overworld row), or why none. */
export function decodeOverworldAreas(rom: SmwRom): OverworldAreasDto {
  const set = deriveOverworldAreas(rom.rom)
  if ('unavailable' in set) return { status: 'unavailable', reason: set.unavailable }
  return {
    status: 'ok',
    areas: set.areas
      .filter(a => a.area !== 0)
      .map(a => ({ area: a.area, ...(a.invalid ? { invalid: a.invalid } : {}) })),
  }
}

/** Area `area` as the explorer opens it: derived, then drawn; an invalid area is refused with its reason. */
export function decodeAreaView(
  rom: SmwRom,
  area: number,
  fps: OverworldViewFingerprints = {},
): OverworldDto {
  const set = deriveOverworldAreas(rom.rom)
  if ('unavailable' in set) return unavailable(set.unavailable)
  const a = set.areas.find(x => x.area === area)
  if (!a) return unavailable(`The ROM names no area ${area}.`)
  if (a.invalid || a.cameraX === undefined || a.cameraY === undefined) {
    return unavailable(a.invalid ?? `Area ${area} has no camera position.`)
  }
  return decodeOverworldArea(rom, { area, cameraX: a.cameraX, cameraY: a.cameraY }, fps)
}
