/**
 * The map tab's L1 (foreground), drawn one screen at a time (#421 step 3).
 *
 * Pure, so it is unit tested in CI; `ProjectServiceImpl` only resolves the
 * working copy and delegates here. The inputs come from the core's
 * `buildL1Inputs`, the same function the L1 data gate checks. Every cell is
 * drawn by `renderMap16Tile`, the Map16 sheet's own tile renderer, and a
 * cell blank in the switch state shown gets `ghostOf`'s screen door, the
 * sheet's and the preview's rule. The back area is not baked in: it is a
 * layer of its own in the view, so it can be hidden like any other. L1 is
 * sent as two planes by the Map16 priority bit; the view stacks them. They never
 * overlap, so their order is unobservable until L2 exists.
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
export type L1Planes = Record<MapPlaneKey, Uint8ClampedArray | null>

/**
 * One screen as RGBA planes: each cell drawn with the switches that are on,
 * blank cells given `ghostOf`'s screen door (both ways, #621), then each 8x8
 * quadrant copied into the plane its Map16 priority bit (bit 13) picks. The
 * planes never overlap, clear where no tile draws.
 */
export function drawL1Planes(
  model: L1Inputs,
  screen: number,
  switches: SwitchStateDto = SWITCHES_OFF,
): L1Planes {
  const on = new Set((Object.keys(switches) as SwitchKind[]).filter(k => switches[k]))
  // A char input, never a grid remap (#573): the chars the switches change, swapped.
  const vram = on.size > 0 && model.anim ? switchedVram(model.anim, model.vram, on) : model.vram
  const { w, h } = screenTiles(model.isVertical)
  const x0 = model.isVertical ? 0 : screen * w
  const y0 = model.isVertical ? screen * h : 0
  const width = w * 16
  const size = width * h * 16 * 4
  const planes = { l1Low: new Uint8ClampedArray(size), l1High: new Uint8ClampedArray(size) }
  const drew = { l1Low: false, l1High: false }
  const palette = { colors: model.colors }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const id = model.grid[y0 + y]?.[x0 + x]
      const def = id === undefined ? undefined : cellDef(model, id, screen)
      if (!def) continue
      const cell = renderMap16Tile(def, vram, palette)
      const art = model.switchArt.get(def.id)
      const ghost = art && ghostOf(cell, art.off, art.alts, x => x.rgba)
      if (ghost) overlayHidden(cell, 16, 0, 0, ghost)
      // The screen door is the hidden tile's art (built from the Map16 entry), so its priority
      // bits route it, not those of the blank cell drawn in its place.
      const owner = ghost ? (model.map16.tiles[def.id] ?? def) : def
      for (const [qx, qy, sub] of [
        [0, 0, owner.tl],
        [8, 0, owner.tr],
        [0, 8, owner.bl],
        [8, 8, owner.br],
      ] as const) {
        const plane = sub.priority ? 'l1High' : 'l1Low'
        for (let py = qy; py < qy + 8; py++) {
          const row = cell.subarray((py * 16 + qx) * 4, (py * 16 + qx + 8) * 4)
          if (!drew[plane]) drew[plane] = row.some((v, i) => i % 4 === 3 && v !== 0)
          planes[plane].set(row, ((y * 16 + py) * width + x * 16 + qx) * 4)
        }
      }
    }
  return {
    l1Low: drew.l1Low ? planes.l1Low : null,
    l1High: drew.l1High ? planes.l1High : null,
  }
}

const base64 = (b: Uint8ClampedArray) =>
  Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64')

type ScreenReply = Exclude<MapScreenResult, { status: 'rom-not-located' }>

/** One screen for the wire, bounded by the map's own screen count. */
export function screenResult(
  model: L1Inputs,
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
  const drawn = drawL1Planes(model, screen, switches)
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
 * Built models, keyed by the working copy's bytes ARRAY: `WorkingRom.bytes()`
 * hands out a new one after every change, so an edit is never served a
 * stale model and needs no invalidation of its own.
 */
export class L1ModelCache {
  private readonly byBytes = new WeakMap<Uint8Array, Map<string, L1InputsResult>>()
  private readonly arts = new WeakMap<Uint8Array, Record<Palace, PalaceArt>>()

  constructor(private readonly build: typeof buildL1Inputs = buildL1Inputs) {}

  get(bytes: Uint8Array, romPath: string, index: number, flags: SwitchFlagsDto): L1InputsResult {
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
