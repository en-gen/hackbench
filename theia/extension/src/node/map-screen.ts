/**
 * The map tab's L1 (foreground), drawn one screen at a time (#421 step 3).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. The inputs come from the core's
 * `buildL1Inputs`, the same function the L1 data gate checks. Cells are
 * drawn through `Tile.render` -> `BufferRenderTarget` -> `composeTile`, in
 * the order `RenderPass` gives L1's two priority planes, over the backdrop.
 *
 * Tiles are plain Map16 quads, not `TileFactory.buildTiles`, whose editor
 * annotations read the `editorStore` singleton; the switch-palace state is
 * already in the grid, where `expandMap` picked the page.
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { RomFile } from '../../../../src/rom/RomFile'
import { SCREEN_H, SCREEN_W, SCREEN_W_VERT, SCREEN_H_VERT } from '../../../../src/rom/LevelParser'
import { type SwitchFlags, type TileGrid } from '../../../../src/rom/ObjectExpander'
import {
  pipeVariantIndex,
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
} from '../../../../src/rom/Map16'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { buildL1Inputs, type L1Inputs } from '../../../../src/rom/model/L1Model'
import {
  PALACES,
  switchBlockTile,
  type SwitchBlockTile,
} from '../../../../src/rom/SwitchBlockTiles'
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
import type { MapScreenResult, PalaceIconsResult, SwitchFlagsDto } from '../common/project-protocol'

/** Everything one map's screens are drawn from. */
export interface L1Model {
  grid: TileGrid
  tiles: Map<number, Tile>
  mapStore: MapStore
  isVertical: boolean
  screenCount: number
  backArea: RgbaColor
  note?: string
  palaceTiles?: Record<string, SwitchBlockTile>
  /** What the tiles were built from, for the atlas cross-check in tests. */
  inputs?: L1Inputs
}

export type BuildL1Result = { status: 'ok'; model: L1Model } | { status: 'unavailable'; reason: string } // prettier-ignore

/** The drawable model for a set of inputs: plain quads, pipe sets per screen, a static palette. */
export function modelFromInputs(inputs: L1Inputs): L1Model {
  const { map16, chars, colors, isVertical, screenCount } = inputs
  const placeholder = makePlaceholderBoxChar()
  const tiles = new Map<number, Tile>()
  for (const m16 of map16.tiles) {
    const pipe = m16.id - PIPE_VARIANT_TILE_START
    const behavior =
      pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && map16.pipeVariants.length > 0
        ? new PipeVariantsBehavior(map16.pipeVariants.map(v => quadFromMap16(v[pipe]!, chars, placeholder))) // prettier-ignore
        : new StaticQuadBehavior(quadFromMap16(m16, chars, placeholder))
    tiles.set(m16.id, new Tile(m16.id, behavior))
  }
  const cell = (c: RgbaColor) => new Color(new StaticColorBehavior(c))
  const rows = Array.from({ length: 16 }, (_, r) => colors.slice(r * 16, r * 16 + 16).map(cell))
  const mapStore = createMapStore({
    palette: new Palette(rows, cell(inputs.backArea)),
    levelOrientation: isVertical ? 'vertical' : 'horizontal',
    // MAP16AppTable is picked by the strip counter (bank_05.asm:119-124);
    // a screen is 16 strips, so one pipe set per screen.
    screenPipeVariantIdx: Array.from({ length: screenCount }, (_, s) => pipeVariantIndex(s * 16)),
  })
  return { grid: inputs.grid, tiles, mapStore, isVertical, screenCount, backArea: inputs.backArea, note: inputs.animNote, inputs } // prettier-ignore
}

/** A map's L1 model, or why it cannot be drawn. Never an empty model. */
export function buildL1Model(rom: SmwRom, index: number, flags: SwitchFlags): BuildL1Result {
  const built = buildL1Inputs(rom, index, flags)
  if (!built.ok) return { status: 'unavailable', reason: built.reason }
  const model = modelFromInputs(built.inputs)
  const tileset = built.inputs.header.objectTileset
  model.palaceTiles = Object.fromEntries(PALACES.map(p => [p, switchBlockTile(rom.rom, tileset, p)])) // prettier-ignore
  return { status: 'ok', model }
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
 * One screen as RGBA over the backdrop. Cells are handed to `Tile.render`
 * at their MAP position, so the pipe set resolves per screen; the target
 * shifts them into the screen.
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
  target.fillRect({ x: 0, y: 0 }, { w: w * 16, h: h * 16 }, model.backArea)
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
    note: model.note,
  }
}

/** One Map16 tile as 16x16 RGBA, through the same path as a map cell. */
function drawTile(model: L1Model, id: number): string {
  const target = new BufferRenderTarget(16, 16)
  for (const phase of L1_PHASES) model.tiles.get(id)?.render(target, cellBoxOf(0, 0), model.mapStore, phase) // prettier-ignore
  return base64(target.buf)
}

export function palaceIconsOf(
  model: L1Model,
): Exclude<PalaceIconsResult, { status: 'rom-not-located' }> {
  return {
    status: 'ok',
    icons: PALACES.map(palace => {
      const t = model.palaceTiles?.[palace] ?? { reason: 'not read' }
      return 'reason' in t
        ? { palace, unavailable: t.reason }
        : { palace, uncleared: drawTile(model, t.uncleared), cleared: drawTile(model, t.cleared) }
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
