/**
 * The map tab's L1 (foreground), drawn one screen at a time (#421 step 3).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. The inputs come from the core's
 * `buildL1Inputs`, the same function the L1 data gate checks. Every cell is
 * drawn by `renderMap16Tile`, the Map16 sheet's own tile renderer, and a
 * cell blank in the switch state shown gets `ghostOf`'s screen door, the
 * sheet's and the preview's rule. The back area is not baked in: it is a
 * layer of its own in the view, so it can be hidden like any other. L1 and
 * L2 (background) are each sent as two planes by the subtile priority bit;
 * the view stacks the four in BG mode 1's order (`MAP_PLANE_KEYS`). A layer
 * never overlaps its own planes; L2 sits at a 1:1 horizontal offset, with no
 * parallax, and shifted vertically by its initial Layer2YPos (#113).
 */
import { SmwRom } from '../../../../src/rom/SmwRom'
import { RomFile } from '../../../../src/rom/RomFile'
import { SCREEN_H, SCREEN_W, SCREEN_W_VERT, SCREEN_H_VERT } from '../../../../src/rom/LevelParser'
import {
  pipeVariantIndex,
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  type Map16Tile,
} from '../../../../src/rom/Map16'
import {
  buildL1Inputs,
  type L1Inputs,
  type L1InputsResult,
} from '../../../../src/rom/model/L1Model'
import { buildL2Inputs, type L2Inputs, type L2Result } from '../../../../src/rom/model/L2Model'
import { readLevelBgMode } from '../../../../src/rom/BgMode'
import { PALACES, type Palace } from '../../../../src/rom/SwitchBlockTiles'
import { palaceArt, type PalaceArt } from '../../../../src/rom/SwitchArt'
import { renderMap16Tile } from '../../../../src/rom/TileRenderer'
import { ghostOf, overlayHidden } from '../../../../src/rom/render/HiddenTiles'
import { MAP_PLANE_KEYS } from '../common/project-protocol'
import type {
  MapPlaneKey,
  MapScreenResult,
  PalaceIconsResult,
  PalaceIconDto,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import type { SwitchKind } from '../../../../src/rom/AnimationLoader'
import { switchedVram } from '../../../../src/rom/SwitchAlternates'
import { buildSwitchButtonArt, buildTileAlternates, ONOFF_BUTTON_TILE_ID } from './map16-decode'

/** A screen's size in tiles: 16 x 27 horizontal, two 16-wide halves x 16 vertical. */
export function screenTiles(isVertical: boolean): { w: number; h: number } {
  return isVertical ? { w: SCREEN_W_VERT, h: SCREEN_H_VERT } : { w: SCREEN_W, h: SCREEN_H }
}

/**
 * The definition a cell draws: its own, or for the pipe tiles the set
 * MAP16AppTable picks by the strip counter (bank_05.asm:119-124), one per
 * screen since a screen is 16 strips.
 */
export function cellDef(model: L1Inputs, id: number, screen: number): Map16Tile | undefined {
  const pipe = id - PIPE_VARIANT_TILE_START
  const sets = model.map16.pipeVariants
  if (pipe >= 0 && pipe < PIPE_VARIANT_TILE_COUNT && sets.length > 0) {
    return sets[pipeVariantIndex(screen * 16)]?.[pipe]
  }
  return model.map16.tiles[id]
}

export const SWITCHES_OFF: SwitchStateDto = { blue: false, silver: false, onOff: false }

/** A plane's RGBA, or null when no pixel drew in it (the wire sends no image for it). */
export type L1Planes = Record<'l1Low' | 'l1High', Uint8ClampedArray | null>
export type L2Planes = Record<'l2Low' | 'l2High', Uint8ClampedArray | null>

/** One cell as drawn, and the Map16 entry whose subtile priorities route its quadrants. */
interface DrawnCell {
  rgba: Uint8ClampedArray
  owner: Map16Tile
}

/**
 * One screen of one layer as two RGBA planes: each cell's 8x8 quadrants copied
 * into the plane their subtile priority bit (bit 13) picks, `dy` pixels below
 * their grid row (rows outside the screen are clipped). The planes never
 * overlap, clear where no tile draws.
 */
function drawPlanes<L extends MapPlaneKey, H extends MapPlaneKey>(
  keys: readonly [L, H],
  isVertical: boolean,
  screen: number,
  dy: number,
  cellAt: (x: number, y: number) => DrawnCell | undefined,
): Record<L | H, Uint8ClampedArray | null> {
  const { w, h } = screenTiles(isVertical)
  const x0 = isVertical ? 0 : screen * w
  const top = isVertical ? screen * h * 16 : 0
  const width = w * 16
  const height = h * 16
  const planes = [0, 1].map(() => new Uint8ClampedArray(width * height * 4))
  const drew = [false, false]
  const firstRow = Math.max(0, Math.floor((top - dy) / 16))
  for (let y = firstRow; y * 16 + dy < top + height; y++)
    for (let x = 0; x < w; x++) {
      const cell = cellAt(x0 + x, y)
      if (!cell) continue
      for (const [qx, qy, sub] of [
        [0, 0, cell.owner.tl],
        [8, 0, cell.owner.tr],
        [0, 8, cell.owner.bl],
        [8, 8, cell.owner.br],
      ] as const) {
        const p = sub.priority ? 1 : 0
        for (let py = qy; py < qy + 8; py++) {
          const outY = y * 16 + py + dy - top
          if (outY < 0 || outY >= height) continue
          const row = cell.rgba.subarray((py * 16 + qx) * 4, (py * 16 + qx + 8) * 4)
          if (!drew[p]) drew[p] = row.some((v, i) => i % 4 === 3 && v !== 0)
          planes[p]!.set(row, (outY * width + x * 16 + qx) * 4)
        }
      }
    }
  return { [keys[0]]: drew[0] ? planes[0] : null, [keys[1]]: drew[1] ? planes[1] : null } as Record<L | H, Uint8ClampedArray | null> // prettier-ignore
}

/** The chars the switches that are on swap in (#573): a char input, never a grid remap. */
function vramFor(model: L1Inputs, switches: SwitchStateDto) {
  const on = new Set((Object.keys(switches) as SwitchKind[]).filter(k => switches[k]))
  return on.size > 0 && model.anim ? switchedVram(model.anim, model.vram, on) : model.vram
}

/**
 * L1 (foreground) of one screen: each cell drawn with the switches that are
 * on, blank cells given `ghostOf`'s screen door (both ways, #621). The screen
 * door is the hidden tile's art, so the hidden tile's own priority bits route
 * it, not those of the blank cell drawn in its place.
 */
export function drawL1Planes(
  model: L1Inputs,
  screen: number,
  switches: SwitchStateDto = SWITCHES_OFF,
  vram = vramFor(model, switches),
): L1Planes {
  const palette = { colors: model.colors }
  return drawPlanes(['l1Low', 'l1High'], model.isVertical, screen, 0, (x, y) => {
    const id = model.grid[y]?.[x]
    const def = id === undefined ? undefined : cellDef(model, id, screen)
    if (!def) return undefined
    const rgba = renderMap16Tile(def, vram, palette)
    const art = model.switchArt.get(def.id)
    const ghost = art && ghostOf(rgba, art.off, art.alts, c => c.rgba)
    if (ghost) overlayHidden(rgba, 16, 0, 0, ghost)
    return { rgba, owner: ghost ? (model.map16.tiles[def.id] ?? def) : def }
  })
}

/** L2 (background) of one screen, from the same chars and palette as L1. */
export function drawL2Planes(
  model: L1Inputs,
  l2: L2Inputs,
  screen: number,
  vram = model.vram,
): L2Planes {
  const palette = { colors: model.colors }
  const drawn = new Map<number, Uint8ClampedArray>()
  return drawPlanes(['l2Low', 'l2High'], model.isVertical, screen, l2.dy, (x, y) => {
    const id = l2.grid[y]?.[x]
    const def = id == null ? undefined : l2.tiles[id]
    if (!def) return undefined
    let rgba = drawn.get(def.id)
    if (!rgba) drawn.set(def.id, (rgba = renderMap16Tile(def, vram, palette)))
    return { rgba, owner: def }
  })
}

/** What the map tab draws: L1's inputs plus the background and the layer-order verdict. */
export interface MapInputs extends L1Inputs {
  l2?: L2Result
  /** Why the planes' order is unverified (not BG mode 1, or the mode could not be read). */
  orderNote?: string
}
export type MapInputsResult = { ok: true; inputs: MapInputs } | { ok: false; reason: string }

const base64 = (b: Uint8ClampedArray) =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

type ScreenReply = Exclude<MapScreenResult, { status: 'rom-not-located' }>

/** One screen for the wire, bounded by the map's own screen count. */
export function screenResult(
  model: MapInputs,
  screen: number,
  switches: SwitchStateDto = SWITCHES_OFF,
): ScreenReply {
  if (!Number.isInteger(screen) || screen < 0 || screen >= model.screenCount) {
    return {
      status: 'unavailable',
      reason: `Screen ${screen} is outside this map's ${model.screenCount} screens`,
    }
  }
  const { w, h } = screenTiles(model.isVertical)
  const vram = vramFor(model, switches)
  const l2 = model.l2?.ok ? model.l2.l2 : null
  const drawn: Partial<Record<MapPlaneKey, Uint8ClampedArray | null>> = {
    ...drawL1Planes(model, screen, switches, vram),
    ...(l2 && drawL2Planes(model, l2, screen, vram)),
  }
  return {
    status: 'ok',
    screen,
    screenCount: model.screenCount,
    orientation: model.isVertical ? 'vertical' : 'horizontal',
    width: w * 16,
    height: h * 16,
    planes: Object.fromEntries(
      MAP_PLANE_KEYS.map(k => {
        const rgba = drawn[k]
        return [k, rgba ? base64(rgba) : null]
      }),
    ) as Record<MapPlaneKey, string | null>,
    note: [...model.unverified, model.animNote].filter(Boolean).join(' ') || undefined,
    l2Note: model.l2 && !model.l2.ok ? model.l2.reason : undefined,
    orderNote: model.orderNote,
    backdrop: [model.backArea[0], model.backArea[1], model.backArea[2]],
  }
}

/** Each palace's block for the wire: per ROM, so the same on every map. */
export function palaceIconsOf(art: Record<Palace, PalaceArt>): PalaceIconDto[] {
  return PALACES.map(palace => {
    const a = art[palace]
    return 'reason' in a
      ? { palace, unavailable: a.reason }
      : { palace, uncleared: base64(a.uncleared), cleared: base64(a.cleared) }
  })
}

const flagsKey = (f: SwitchFlagsDto) => `${+f.green}${+f.yellow}${+f.blue}${+f.red}`

/**
 * L1's build plus the background and the layer-order verdict. Neither can
 * refuse the map: a background the core cannot read, or an order that cannot be
 * verified, is a note on a map that still draws ("viewers draw; they do not blank").
 */
export function buildMapInputs(
  rom: SmwRom,
  index: number,
  flags: SwitchFlagsDto,
  l1: typeof buildL1Inputs = buildL1Inputs,
): MapInputsResult {
  const built = l1(rom, index, flags)
  if (!built.ok) return built
  const bg = readLevelBgMode(rom.rom)
  return {
    ok: true,
    inputs: { ...built.inputs, l2: buildL2Inputs(rom, index, built.inputs), orderNote: bg.ok ? undefined : bg.reason }, // prettier-ignore
  }
}

/**
 * Built models, keyed by the working copy's bytes ARRAY: `WorkingRom.bytes()`
 * hands out a new one after every change, so an edit is never served a
 * stale model and needs no invalidation of its own.
 */
export class L1ModelCache {
  private readonly byBytes = new WeakMap<Uint8Array, Map<string, MapInputsResult>>()
  private readonly arts = new WeakMap<Uint8Array, Record<Palace, PalaceArt>>()

  constructor(private readonly build: typeof buildMapInputs = buildMapInputs) {}

  get(bytes: Uint8Array, romPath: string, index: number, flags: SwitchFlagsDto): MapInputsResult {
    let models = this.byBytes.get(bytes)
    if (!models) this.byBytes.set(bytes, (models = new Map()))
    const key = `${index}:${flagsKey(flags)}`
    let built = models.get(key)
    if (!built) {
      // A copy: the working copy's array is shared and must not be mutated.
      try {
        built = this.build(new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes))), index, flags)
      } catch (err) {
        built = { ok: false, reason: (err as Error).message }
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
  switches: SwitchStateDto = SWITCHES_OFF,
): ScreenReply {
  const built = cache.get(bytes, romPath, index, flags)
  return built.ok
    ? screenResult(built.inputs, screen, switches)
    : { status: 'unavailable', reason: built.reason }
}

/**
 * The toolbar's art for this map: each palace's block (per ROM) and each
 * char switch's own, the Map16 inspector's (`buildSwitchButtonArt`), from
 * the map's chars and palette. A map that cannot be built names why.
 */
export function toolbarArtOf(
  rom: RomFile,
  built: L1InputsResult,
  art: Record<Palace, PalaceArt>,
): Exclude<PalaceIconsResult, { status: 'rom-not-located' }> {
  if (!built.ok) {
    const unavailable = Object.fromEntries(
      (['blue', 'silver', 'onOff'] as const).map(k => [k, built.reason]),
    )
    return {
      status: 'ok',
      icons: palaceIconsOf(art),
      switchArt: {},
      switchUnavailable: unavailable,
    }
  }
  const m = built.inputs
  const onOff = m.map16.tiles.filter(t => t?.id === ONOFF_BUTTON_TILE_ID)
  const alternates = m.anim ? buildTileAlternates(m.anim, onOff, m.vram, { colors: m.colors }) : new Map() // prettier-ignore
  const buttons = buildSwitchButtonArt(rom, onOff, alternates, m.vram, { colors: m.colors })
  return {
    status: 'ok',
    icons: palaceIconsOf(art),
    switchArt: buttons.art,
    switchUnavailable: buttons.unavailable,
  }
}
