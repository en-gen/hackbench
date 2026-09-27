/**
 * The map tab's L1 (foreground), drawn one screen at a time (#421 step 3).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. The inputs come from the core's
 * `buildL1Inputs`, the same function the L1 data gate checks. Every cell is
 * drawn by `renderCell`, the Map16 sheet's own renderer and hidden-tile rule,
 * so the map has no drawing logic of its own; cells are then laid over the
 * backdrop. L1's two priority planes need no ordering while L1 is drawn
 * alone: its quadrants never overlap each other.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { RomFile } from '../../../../src/rom/RomFile'
import { SCREEN_H, SCREEN_W, SCREEN_W_VERT, SCREEN_H_VERT } from '../../../../src/rom/LevelParser'
import { type SwitchFlags } from '../../../../src/rom/ObjectExpander'
import {
  pipeVariantIndex,
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  type Map16Tile,
} from '../../../../src/rom/Map16'
import { buildL1Inputs, type L1Inputs } from '../../../../src/rom/model/L1Model'
import { PALACES, type Palace } from '../../../../src/rom/SwitchBlockTiles'
import { palaceArt, type PalaceArt } from '../../../../src/rom/SwitchArt'
import { renderCell } from '../../../../src/rom/render/CellRenderer'
import type { MapScreenResult, PalaceIconsResult, SwitchFlagsDto } from '../common/project-protocol'

/** Everything one map's screens are drawn from: the L1 inputs, as the data gate reads them. */
export type L1Model = L1Inputs

export type BuildL1Result = { status: 'ok'; model: L1Model } | { status: 'unavailable'; reason: string } // prettier-ignore

/** A map's L1 model, or why it cannot be drawn. Never an empty model. */
export function buildL1Model(rom: SmwRom, index: number, flags: SwitchFlags): BuildL1Result {
  const built = buildL1Inputs(rom, index, flags)
  return built.ok ? { status: 'ok', model: built.inputs } : { status: 'unavailable', reason: built.reason } // prettier-ignore
}

/** A screen's size in tiles: 16 x 27 horizontal, two 16-wide halves x 16 vertical. */
export function screenTiles(isVertical: boolean): { w: number; h: number } {
  return isVertical ? { w: SCREEN_W_VERT, h: SCREEN_H_VERT } : { w: SCREEN_W, h: SCREEN_H }
}

/**
 * The definition a cell draws: its own, or for the pipe tiles the set
 * MAP16AppTable picks by the strip counter (bank_05.asm:119-124), one per
 * screen since a screen is 16 strips.
 */
function cellDef(model: L1Model, id: number, screen: number): Map16Tile | undefined {
  const pipe = id - PIPE_VARIANT_TILE_START
  const sets = model.map16.pipeVariants
  if (pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && sets.length > 0) {
    return sets[pipeVariantIndex(screen * 16)]?.[pipe]
  }
  return model.map16.tiles[id]
}

/** One screen as RGBA: each cell's `renderCell` picture laid over the backdrop. */
export function drawL1Screen(model: L1Model, screen: number): Uint8ClampedArray {
  const { w, h } = screenTiles(model.isVertical)
  const x0 = model.isVertical ? 0 : screen * w
  const y0 = model.isVertical ? screen * h : 0
  const width = w * 16
  const out = new Uint8ClampedArray(width * h * 16 * 4)
  for (let i = 0; i < out.length; i += 4) out.set(model.backArea, i)
  const palette = { colors: model.colors }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const id = model.grid[y0 + y]?.[x0 + x]
      const def = id === undefined ? undefined : cellDef(model, id, screen)
      if (!def) continue
      const cell = renderCell(def, model.vram, palette, model.hidden.get(def.id))
      for (let py = 0; py < 16; py++)
        for (let px = 0; px < 16; px++) {
          const s = (py * 16 + px) * 4
          const a = cell[s + 3]!
          if (a === 0) continue
          const d = ((y * 16 + py) * width + x * 16 + px) * 4
          for (let c = 0; c < 3; c++) out[d + c] = Math.round((cell[s + c]! * a + out[d + c]! * (255 - a)) / 255) // prettier-ignore
          out[d + 3] = 255
        }
    }
  return out
}

const base64 = (b: Uint8ClampedArray) =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

type ScreenReply = Exclude<MapScreenResult, { status: 'rom-not-located' }>

/** One screen for the wire, bounded by the map's own screen count. */
export function screenResult(model: L1Model, screen: number): ScreenReply {
  if (!Number.isInteger(screen) || screen < 0 || screen >= model.screenCount) {
    return {
      status: 'unavailable',
      reason: `Screen ${screen} is outside this map's ${model.screenCount} screens`,
    }
  }
  const { w, h } = screenTiles(model.isVertical)
  return {
    status: 'ok',
    screen,
    screenCount: model.screenCount,
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    width: w * 16,
    height: h * 16,
    rgbaBase64: base64(drawL1Screen(model, screen)),
    note: model.animNote,
  }
}

/** Each palace's block for the wire: per ROM, so the same on every map. */
export function palaceIconsOf(
  art: Record<Palace, PalaceArt>,
): Exclude<PalaceIconsResult, { status: 'rom-not-located' }> {
  return {
    status: 'ok',
    icons: PALACES.map(palace => {
      const a = art[palace]
      return 'reason' in a
        ? { palace, unavailable: a.reason }
        : { palace, uncleared: base64(a.uncleared), cleared: base64(a.cleared) }
    }),
  }
}

const flagsKey = (f: SwitchFlagsDto) => `${+f.green}${+f.yellow}${+f.blue}${+f.red}`

/**
 * Built models, keyed by the working copy's bytes ARRAY: `WorkingRom.bytes()`
 * hands out a new one after every change, so an edit is never served a
 * stale model and needs no invalidation of its own.
 */
export class L1ModelCache {
  private readonly byBytes = new WeakMap<Uint8Array, Map<string, BuildL1Result>>()
  private readonly arts = new WeakMap<Uint8Array, Record<Palace, PalaceArt>>()

  constructor(private readonly build: typeof buildL1Model = buildL1Model) {}

  get(bytes: Uint8Array, romPath: string, index: number, flags: SwitchFlagsDto): BuildL1Result {
    let models = this.byBytes.get(bytes)
    if (!models) this.byBytes.set(bytes, (models = new Map()))
    const key = `${index}:${flagsKey(flags)}`
    let built = models.get(key)
    if (!built) {
      // A copy: the working copy's array is shared and must not be mutated.
      try {
        built = this.build(new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes))), index, flags)
      } catch (err) {
        built = { status: 'unavailable', reason: (err as Error).message }
      }
      if (models.size >= 8) models.delete(models.keys().next().value!)
      models.set(key, built)
    }
    return built
  }

  /** The ROM's palace art, once per working-copy bytes. */
  art(bytes: Uint8Array, romPath: string): Record<Palace, PalaceArt> {
    let art = this.arts.get(bytes)
    if (!art)
      this.arts.set(bytes, (art = palaceArt(RomFile.fromBytes(romPath, Buffer.from(bytes)))))
    return art
  }
}

export function mapScreen(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  screen: number,
  flags: SwitchFlagsDto,
): ScreenReply {
  const built = cache.get(bytes, romPath, index, flags)
  return built.status === 'ok' ? screenResult(built.model, screen) : built
}
