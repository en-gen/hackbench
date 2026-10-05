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
 * parallax, and shifted vertically by its initial Layer2YPos (#113). L3 is two
 * planes by its tile priority bit, drawn only on the standard layout (#561).
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
import { buildL3Verdict, type L3Inputs, type L3Verdict } from '../../../../src/rom/model/L3Model'
import { L3_HUD_ROW_CUTOFF, L3_TILEMAP_COLS, L3_TILEMAP_ROWS } from '../../../../src/rom/L3Loader'
import { readLevelBgMode, type BgModeResult } from '../../../../src/rom/BgMode'
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
type Plane = Uint8ClampedArray | null
export type L1Planes = Record<'l1Low' | 'l1High', Plane>
export type L2Planes = Record<'l2Low' | 'l2High', Plane>

/** One cell as drawn, and the Map16 entry whose subtile priorities route its quadrants. */
interface DrawnCell {
  rgba: Uint8ClampedArray
  owner: Map16Tile
}

/**
 * One screen of one layer as [low, high] RGBA planes: each cell's 8x8 quadrants
 * copied into the plane their subtile priority bit (bit 13) picks, `dy` pixels
 * below their grid row. With a finite `period` the shifted grid wraps in it, as
 * the PPU's BG plane does; rows outside the screen are clipped. The planes never
 * overlap, clear where no tile draws.
 */
function drawPlanes(
  isVertical: boolean,
  screen: number,
  rows: number,
  { dy, period = Infinity }: { dy: number; period?: number },
  cellAt: (x: number, y: number) => DrawnCell | undefined,
): [Plane, Plane] {
  const { w, h } = screenTiles(isVertical)
  const x0 = isVertical ? 0 : screen * w
  const top = isVertical ? screen * h * 16 : 0
  const width = w * 16
  const height = h * 16
  const planes = [0, 1].map(() => new Uint8ClampedArray(width * height * 4))
  const drew = [false, false]
  for (let y = 0; y < rows; y++) {
    const shifted = y * 16 + dy
    const base = Number.isFinite(period) ? ((shifted % period) + period) % period : shifted
    // Every copy of this row, one per period, that reaches the screen.
    const copies = Number.isFinite(period) ? Math.ceil((top + height - base) / period) : 1
    for (let k = Math.ceil((top - 15 - base) / period) || 0; k < copies; k++) {
      const at = base + k * (Number.isFinite(period) ? period : 0)
      if (at + 16 <= top || at >= top + height) continue
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
            const outY = at + py - top
            if (outY < 0 || outY >= height) continue
            const row = cell.rgba.subarray((py * 16 + qx) * 4, (py * 16 + qx + 8) * 4)
            if (!drew[p]) drew[p] = row.some((v, i) => i % 4 === 3 && v !== 0)
            planes[p]!.set(row, (outY * width + x * 16 + qx) * 4)
          }
        }
      }
    }
  }
  return [drew[0] ? planes[0]! : null, drew[1] ? planes[1]! : null]
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
  const [l1Low, l1High] = drawPlanes(
    model.isVertical,
    screen,
    model.grid.length,
    { dy: 0 },
    (x, y) => {
      const id = model.grid[y]?.[x]
      const def = id === undefined ? undefined : cellDef(model, id, screen)
      if (!def) return undefined
      const rgba = renderMap16Tile(def, vram, palette)
      const art = model.switchArt.get(def.id)
      const ghost = art && ghostOf(rgba, art.off, art.alts, c => c.rgba)
      if (ghost) overlayHidden(rgba, 16, 0, 0, ghost)
      return { rgba, owner: ghost ? (model.map16.tiles[def.id] ?? def) : def }
    },
  )
  return { l1Low, l1High }
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
  // BG2 is a 64x64-tile plane (bank_00.asm:1270-1271), 512 px, so a shifted grid wraps in it. An image is
  // never streamed (CODE_058883's image modes return, bank_05.asm:1023-1055): one fixed plane, wrapped on
  // every screen. A horizontal object stream fits the plane; a vertical one is streamed, so it is not wrapped.
  const period = l2.kind === 'image' || !model.isVertical ? 512 : Infinity
  const [l2Low, l2High] = drawPlanes(
    model.isVertical,
    screen,
    l2.grid.length,
    { dy: l2.dy, period },
    (x, y) => {
      const id = l2.grid[y]?.[x]
      const def = id == null ? undefined : l2.tiles[id]
      if (!def) return undefined
      let rgba = drawn.get(def.id)
      if (!rgba) drawn.set(def.id, (rgba = renderMap16Tile(def, vram, palette)))
      return { rgba, owner: def }
    },
  )
  return { l2Low, l2High }
}

export type L3Planes = Record<'l3Low' | 'l3High', Plane>

/**
 * L3 of one screen as [low, high] planes by each tile's priority bit: tile row
 * R (gameplay rows only; the first 8 are the status bar) at level Y
 * R*8 - Layer3YPos + Layer1YPos, x repeating every 512 px (a tide, whose BG3
 * scrolls with the camera, every 256 px over the first 32 columns, and its
 * second copy of the tilemap is not drawn). Rows that start above the level
 * are skipped whole, as the reference view does. Char 0 of every 2bpp
 * palette is clear.
 */
export function drawL3Planes(l3: L3Inputs, isVertical: boolean, screen: number): L3Planes {
  const { w, h } = screenTiles(isVertical)
  const [width, height] = [w * 16, h * 16]
  const [x0, top] = isVertical ? [0, screen * height] : [screen * width, 0]
  const cols = l3.tide ? 32 : L3_TILEMAP_COLS
  const cell = (r: number, c: number) => l3.tilemap[r * L3_TILEMAP_COLS + c] ?? 0
  const row = (r: number) => Array.from({ length: L3_TILEMAP_COLS }, (_, c) => cell(r, c))
  let first = L3_HUD_ROW_CUTOFF
  while (first < L3_TILEMAP_ROWS - 1 && row(first).every(v => v === 0)) first++
  // A tide writes its tilemap twice for animation; the copy starts where a row repeats the first one's chars.
  const sameChars = (a: number[], b: number[]) => a.every((v, c) => (v === 0) === (b[c] === 0) && (v & 0x3ff) === (b[c]! & 0x3ff)) // prettier-ignore
  let end = L3_TILEMAP_ROWS
  for (let r = first + 1; l3.tide && r < L3_TILEMAP_ROWS; r++) {
    if (sameChars(row(r), row(first))) {
      end = r
      break
    }
  }
  const planes = [0, 1].map(() => new Uint8ClampedArray(width * height * 4))
  const drew = [false, false]
  for (let r = L3_HUD_ROW_CUTOFF; r < end; r++) {
    const y = r * 8 - l3.yPx + l3.camYPx
    if (y < 0 || y + 8 <= top || y >= top + height) continue
    for (let sx = 0; sx < width; sx += 8) {
      const word = cell(r, ((x0 + sx) % (cols * 8)) >> 3)
      const pixels = l3.chars[(word & 0x3ff) >> 7]?.[word & 0x7f]
      if (!word || !pixels) continue
      const p = word & 0x2000 ? 1 : 0
      for (let ty = 0; ty < 8; ty++) {
        const outY = y + ty - top
        if (outY < 0 || outY >= height) continue
        for (let tx = 0; tx < 8; tx++) {
          const v = pixels[((word & 0x8000 ? 7 - ty : ty) << 3) | (word & 0x4000 ? 7 - tx : tx)]!
          const color = v === 0 ? undefined : l3.colors[((word >> 10) & 7) * 4 + v]
          if (!color) continue
          planes[p]!.set(color, (outY * width + sx + tx) * 4)
          drew[p] = true
        }
      }
    }
  }
  return { l3Low: drew[0] ? planes[0]! : null, l3High: drew[1] ? planes[1]! : null }
}

/** What the map tab draws: L1's inputs plus the background and the layer-order verdict. */
export interface MapInputs extends L1Inputs {
  l2?: L2Result
  /** Layer 3's layout, priority bit and inputs, or why it is not drawn (#561). Absent: the old order, no layer 3. */
  l3?: L3Verdict
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
  const drawn: Partial<Record<MapPlaneKey, Plane>> = {
    ...drawL1Planes(model, screen, switches, vram),
    ...(l2 && drawL2Planes(model, l2, screen, vram)),
    ...(model.l3?.l3 && drawL3Planes(model.l3.l3, model.isVertical, screen)),
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
    layer3: {
      layout: model.l3?.layout ?? 'other',
      priority: model.l3?.priority ?? model.header.layer3Priority,
      reason: model.l3 ? model.l3.reason : 'Layer 3 not drawn yet',
    },
    note: [...model.unverified, model.animNote].filter(Boolean).join(' ') || undefined,
    layerNotes: [
      model.l2 && !model.l2.ok ? `The background is not drawn: ${model.l2.reason}` : '',
      model.orderNote ? `Layer order unverified, drawn as BG mode 1: ${model.orderNote}` : '',
    ].filter(Boolean),
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
  bgMode: () => BgModeResult = () => readLevelBgMode(rom.rom),
  l1: typeof buildL1Inputs = buildL1Inputs,
): MapInputsResult {
  const built = l1(rom, index, flags)
  if (!built.ok) return built
  const bg = bgMode()
  return {
    ok: true,
    inputs: {
      ...built.inputs,
      l2: buildL2Inputs(rom, index, built.inputs),
      l3: buildL3Verdict(rom.rom, index, built.inputs, bg),
      orderNote: bg.ok ? undefined : bg.reason,
    },
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
  /** The BG mode reading scans the ROM, so it is made once per bytes, not per map. */
  private readonly modes = new WeakMap<Uint8Array, BgModeResult>()

  constructor(private readonly build: typeof buildMapInputs = buildMapInputs) {}

  get(bytes: Uint8Array, romPath: string, index: number, flags: SwitchFlagsDto): MapInputsResult {
    let models = this.byBytes.get(bytes)
    if (!models) this.byBytes.set(bytes, (models = new Map()))
    const key = `${index}:${flagsKey(flags)}`
    let built = models.get(key)
    if (!built) {
      // A copy: the working copy's array is shared and must not be mutated.
      try {
        const rom = new SmwRom(RomFile.fromBytes(romPath, Buffer.from(bytes)))
        const bgMode = () => this.modes.get(bytes) ?? this.modes.set(bytes, readLevelBgMode(rom.rom)).get(bytes)! // prettier-ignore
        built = this.build(rom, index, flags, bgMode)
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
