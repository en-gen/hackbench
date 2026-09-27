/**
 * The map tab's L1 (foreground), drawn one screen at a time (#421 step 3).
 *
 * Pure: no Theia or RPC imports, so it is unit tested in CI the same way
 * map16-decode.ts and map-details.ts are. `ProjectServiceImpl.mapScreen`
 * only resolves the working copy and delegates here.
 *
 * No pixel code of its own. Cells are drawn through the core renderer,
 * `Tile.render` -> `BufferRenderTarget` -> `composeTile`, in the order
 * `RenderPass` gives L1's two priority planes. The inputs are assembled
 * the way the L1 data gate checks them (capture_gate.ts `gateMap`): the
 * grid from `expandMap`, the Map16 table and pipe sets from
 * `loadMap16WithPipeVariants`, VRAM at animation frame 0 (`frameZeroChars`,
 * the Map16 view's one source), CGRAM from the header plus any per-level
 * override block.
 *
 * Tiles are built here as plain Map16 quads rather than through
 * `TileFactory.buildTiles`, whose editor annotations (switch-palace quad
 * swap, P-switch reveals at half alpha) read the `editorStore` singleton.
 * A map tab passes its view state in (the design spec's rule), and the
 * switch-palace state is already in the grid: `expandMap` picks the page.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
  SCREEN_H,
  SCREEN_W,
  SCREEN_W_VERT,
  SCREEN_H_VERT,
} from '../../../../src/rom/LevelParser'
import {
  expandMap,
  SWITCH_FLAGS_UNCLEARED,
  type SwitchFlags,
  type TileGrid,
} from '../../../../src/rom/ObjectExpander'
import {
  loadMap16WithPipeVariants,
  pipeVariantIndex,
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  type Map16Tile,
} from '../../../../src/rom/Map16'
import { gfxSource, loadVram, type VramState } from '../../../../src/rom/GfxLoader'
import {
  buildLevelCgram,
  loadCustomLevelPalette,
  loadRomPalettes,
} from '../../../../src/rom/PaletteLoader'
import { readLevelCol1 } from '../../../../src/rom/PaletteStockTables'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { Tile } from '../../../../src/rom/model/tiles/Tile'
import { makePlaceholderBoxChar, quadFromMap16 } from '../../../../src/rom/model/tiles/TileFactory'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { PipeVariantsBehavior } from '../../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { Color } from '../../../../src/rom/model/palette/Color'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { createMapStore, type MapStore } from '../../../../src/rom/model/stores/mapStore'
import { cellBoxOf, type Phase, type RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { ppuDrawOrder } from '../../../../src/rom/model/RenderPass'
import { BufferRenderTarget } from '../../../../src/rom/render/BufferRenderTarget'
import { map16TileCapacity, frameZeroChars } from './map16-decode'
import type { MapScreenResult, SwitchFlagsDto } from '../common/project-protocol'

export const UNCLEARED: SwitchFlags = SWITCH_FLAGS_UNCLEARED

/** Everything one map's screens are drawn from. */
export interface L1Model {
  grid: TileGrid
  tiles: Map<number, Tile>
  mapStore: MapStore
  isVertical: boolean
  screenCount: number
  /** What the tiles were built from, for the atlas cross-check in tests. */
  inputs?: {
    vram: VramState
    colors: RgbaColor[]
    map16: { tiles: Map16Tile[]; pipeVariants: Map16Tile[][] }
  }
}

export type BuildL1Result = { status: 'ok'; model: L1Model } | { status: 'unavailable'; reason: string } // prettier-ignore

const hex3 = (n: number) => `$${n.toString(16).toUpperCase().padStart(3, '0')}`

/** A map's L1 model, or why it cannot be drawn. Never an empty model. */
export function buildL1Model(rom: SmwRom, index: number, flags: SwitchFlags): BuildL1Result {
  const unavailable = (reason: string): BuildL1Result => ({ status: 'unavailable', reason })
  const raw = rom.getLevelRawData(index)
  if (!raw) return unavailable(`No readable level data at slot ${hex3(index)}`)
  const table = rom.getVerticalTable()
  if (!table.ok) return unavailable(table.reason)
  const gfx = gfxSource(rom.rom)
  if (!gfx.ok) return unavailable(`GFX cannot be read: ${gfx.reason}`)
  const capacity = map16TileCapacity(rom.rom)
  if ('reason' in capacity) return unavailable(capacity.reason)
  const col1 = readLevelCol1(rom.rom)
  if ('reason' in col1) return unavailable(`Palette column 1 is unavailable: ${col1.reason}`)

  try {
    const header = parseLevelHeader(raw)
    const { objects } = parseLevelObjects(raw, table.table)
    const isVertical = isLevelModeVertical(header.levelMode, table.table)
    const tileset = header.objectTileset
    // Same call as the data gate's (no levelNum), plus the tab's flags.
    const grid = expandMap(objects, header.levelLength, rom.rom, tileset, isVertical, header.levelMode, undefined, flags) // prettier-ignore
    const map16 = loadMap16WithPipeVariants(rom.rom, tileset)

    const rawVram = loadVram(rom.rom, tileset, header.spriteSet)
    const frameZero = frameZeroChars(rom.rom, tileset, rawVram)
    const vram = frameZero?.vram ?? rawVram
    const chars = frameZero?.animData ? frameZero.chars : buildChars(vram)
    const placeholder = makePlaceholderBoxChar()

    const cgram = buildLevelCgram(loadRomPalettes(rom.rom, header.bgPalette), header.bgPalette, header.fgPalette, header.spritePalette, col1) // prettier-ignore
    const colors = loadCustomLevelPalette(rom.rom, index)?.colors ?? cgram.colors
    const cell = (c: RgbaColor) => new Color(new StaticColorBehavior(c))
    const rows = Array.from({ length: 16 }, (_, r) => colors.slice(r * 16, r * 16 + 16).map(cell))
    const palette = new Palette(rows, cell([0, 0, 0, 0]))

    const tiles = new Map<number, Tile>()
    for (const m16 of map16.tiles) {
      const pipe = m16.id - PIPE_VARIANT_TILE_START
      const behavior =
        pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && map16.pipeVariants.length > 0
          ? new PipeVariantsBehavior(map16.pipeVariants.map(v => quadFromMap16(v[pipe]!, chars, placeholder))) // prettier-ignore
          : new StaticQuadBehavior(quadFromMap16(m16, chars, placeholder))
      tiles.set(m16.id, new Tile(m16.id, behavior))
    }

    const screenCount = isVertical ? grid.length / SCREEN_H_VERT : (grid[0]?.length ?? 0) / SCREEN_W
    const mapStore = createMapStore({
      palette,
      levelOrientation: isVertical ? 'vertical' : 'horizontal',
      // One pipe set per screen: MAP16AppTable picked by the strip counter
      // (bank_05.asm:119-124), and a screen is 16 strips.
      screenPipeVariantIdx: Array.from({ length: screenCount }, (_, s) => pipeVariantIndex(s * 16)),
    })
    const inputs = { vram, colors, map16 }
    return { status: 'ok', model: { grid, tiles, mapStore, isVertical, screenCount, inputs } }
  } catch (err) {
    return unavailable(`Map ${hex3(index)} could not be built: ${(err as Error).message}`)
  }
}

/** A screen's size in tiles: 16 x 27 horizontal, two 16-wide halves x 16 vertical. */
export function screenTiles(isVertical: boolean): { w: number; h: number } {
  return isVertical ? { w: SCREEN_W_VERT, h: SCREEN_H_VERT } : { w: SCREEN_W, h: SCREEN_H }
}

/** L1's planes, back to front, as `RenderPass` orders them. */
const L1_PHASES: readonly Phase[] = ppuDrawOrder(false)
  .filter(p => p.layer === 'l1')
  .map(p => (p.priority === 1 ? 'priority' : 'nonPriority'))

/**
 * One screen as RGBA. Cells are handed to `Tile.render` at their MAP
 * position, so per-screen behavior (the pipe set) resolves as it does for
 * the whole map; the target shifts them into the screen.
 */
export function drawL1Screen(
  model: L1Model,
  screen: number,
  phases: readonly Phase[] = L1_PHASES,
): Uint8ClampedArray {
  const { w, h } = screenTiles(model.isVertical)
  const x0 = model.isVertical ? 0 : screen * w
  const y0 = model.isVertical ? screen * h : 0
  const target = new BufferRenderTarget(w * 16, h * 16)
  const shifted: RenderTarget = {
    blit8x8: (pixels, pos, row, fx, fy, alpha) =>
      target.blit8x8(pixels, { x: pos.x - x0 * 16, y: pos.y - y0 * 16 }, row, fx, fy, alpha),
    fillRect: (pos, size, color) =>
      target.fillRect({ x: pos.x - x0 * 16, y: pos.y - y0 * 16 }, size, color),
  }
  for (const phase of phases)
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const id = model.grid[y]?.[x]
        if (id === undefined) continue
        model.tiles.get(id)?.render(shifted, cellBoxOf(x, y), model.mapStore, phase)
      }
  return target.buf
}

const flagsKey = (f: SwitchFlagsDto) => `${+f.green}${+f.yellow}${+f.blue}${+f.red}`

/**
 * Built models, keyed by the working copy's bytes ARRAY: `WorkingRom.bytes()`
 * hands out a new one after every change, so an edit can never be served a
 * stale model and needs no invalidation of its own.
 */
export class L1ModelCache {
  private readonly byBytes = new WeakMap<Uint8Array, Map<string, BuildL1Result>>()

  get(bytes: Uint8Array, romPath: string, index: number, flags: SwitchFlagsDto): BuildL1Result {
    let models = this.byBytes.get(bytes)
    if (!models) this.byBytes.set(bytes, (models = new Map()))
    const key = `${index}:${flagsKey(flags)}`
    let built = models.get(key)
    if (!built) {
      // A copy: the working copy's array is shared and must not be mutated.
      built = buildL1Model(new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes))), index, flags)
      if (models.size >= 8) models.delete(models.keys().next().value!)
      models.set(key, built)
    }
    return built
  }
}

/** One screen for the wire, or why there is none. */
export function mapScreen(
  cache: L1ModelCache,
  bytes: Uint8Array,
  romPath: string,
  index: number,
  screen: number,
  flags: SwitchFlagsDto,
): Exclude<MapScreenResult, { status: 'rom-not-located' }> {
  const built = cache.get(bytes, romPath, index, flags)
  if (built.status !== 'ok') return built
  const { model } = built
  if (!Number.isInteger(screen) || screen < 0 || screen >= model.screenCount) {
    return {
      status: 'unavailable',
      reason: `Screen ${screen} is outside this map's ${model.screenCount} screens`,
    }
  }
  const { w, h } = screenTiles(model.isVertical)
  const rgba = drawL1Screen(model, screen)
  return {
    status: 'ok',
    screen,
    screenCount: model.screenCount,
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    width: w * 16,
    height: h * 16,
    rgbaBase64: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength).toString('base64'),
  }
}
