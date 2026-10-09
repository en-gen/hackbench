/**
 * The map tab's per-tab state as a cache key: which switch palaces are
 * pressed and which char switches are on both change the picture, so both
 * key a cached screen. Pure, so it is unit tested without a DOM.
 */
import type {
  BlockIndicatorDto,
  MapSpriteDto,
  SwitchFlagsDto,
  SwitchStateDto,
} from '../common/project-protocol'
import { BLOCK, indicatorBox, paintIndicator, type Box } from '../common/block-indicator'
import {
  composeScreen,
  type SourceKey,
  type ScreenInput,
} from '../../../../src/rom/model/ColorMath'
import { decodeRgba } from './map16-pixels'
import { SWITCH_ORDER } from './map16-view-model'

export const PALACES: readonly (keyof SwitchFlagsDto)[] = ['yellow', 'green', 'red', 'blue']

const bits = <K extends string>(keys: readonly K[], on: Record<K, boolean>) =>
  keys.map(k => (on[k] ? '1' : '0')).join('')

/** `<palaces>:<switches>:<screen>`, palaces yellow green red blue, switches blue silver ON/OFF. */
export function screenKey(flags: SwitchFlagsDto, switches: SwitchStateDto, screen: number): string {
  return `${bits(PALACES, flags)}:${bits(SWITCH_ORDER, switches)}:${screen}`
}

/** What a screen is, for cutting sprites: its pixels and which way the map's screens run. */
export interface ScreenGeometry {
  orientation: 'horizontal' | 'vertical'
  width: number
  height: number
}

const decoded = new WeakMap<MapSpriteDto, Uint8ClampedArray>()

/**
 * One screen's sprite canvas, or null when no sprite reaches it. A sprite is one
 * bitmap in map pixels, so one that crosses a screen edge is cut into every screen
 * it overlaps, and what spills past the map's top or bottom is clipped. Sprites
 * stack in column order on a horizontal map and row order on a vertical one (the
 * stream's order breaks ties), later ones on top.
 */
export function compositeSpriteScreen(
  sprites: readonly MapSpriteDto[],
  screen: number,
  g: ScreenGeometry,
): Uint8ClampedArray | null {
  const vertical = g.orientation === 'vertical'
  const [left, top] = vertical ? [0, screen * g.height] : [screen * g.width, 0]
  const order = [...sprites].sort((a, b) => (vertical ? a.y - b.y : a.x - b.x) || a.index - b.index)
  let out: Uint8ClampedArray | null = null
  for (const s of order) {
    const { x0, y0, x1, y1 } = s.box
    const [cx0, cx1] = [Math.max(x0, left), Math.min(x1, left + g.width)]
    const [cy0, cy1] = [Math.max(y0, top), Math.min(y1, top + g.height)]
    if (cx0 >= cx1 || cy0 >= cy1) continue
    let bmp = decoded.get(s)
    if (!bmp) decoded.set(s, (bmp = decodeRgba(s.rgba)))
    out ??= new Uint8ClampedArray(g.width * g.height * 4)
    for (let y = cy0; y < cy1; y++) {
      for (let x = cx0; x < cx1; x++) {
        const from = ((y - y0) * (x1 - x0) + (x - x0)) * 4
        if (bmp[from + 3] === 0) continue
        out.set(bmp.subarray(from, from + 4), ((y - top) * g.width + (x - left)) * 4)
      }
    }
  }
  return out
}

/** The canvas surface the sprite painter needs: a subset of HTMLCanvasElement. */
interface SpriteCanvas {
  width: number
  height: number
  dataset: DOMStringMap
  getContext(id: '2d'): {
    clearRect(x: number, y: number, w: number, h: number): void
    putImageData?(data: ImageData, x: number, y: number): void
  } | null
}

/** Blanks a sprite canvas that still shows an earlier fetch's sprites. */
export function clearSpriteCanvas(canvas: SpriteCanvas): void {
  if (canvas.dataset.drawn === undefined) return
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  delete canvas.dataset.drawn
}

/**
 * Brings one screen's sprite canvas to `want`: the sprites cut to the screen, or, with
 * no sprites (a failed or older map's fetch), blank, never the stale picture.
 */
export function paintSpriteCanvas(
  canvas: SpriteCanvas,
  sp: (ScreenGeometry & { sprites: readonly MapSpriteDto[] }) | undefined,
  screen: number,
  want: string,
): void {
  if (!sp) return clearSpriteCanvas(canvas)
  if (canvas.dataset.drawn === want) return
  if (canvas.width !== sp.width) canvas.width = sp.width
  if (canvas.height !== sp.height) canvas.height = sp.height
  const ctx = canvas.getContext('2d')
  ctx?.clearRect(0, 0, canvas.width, canvas.height)
  const rgba = compositeSpriteScreen(sp.sprites, screen, sp)
  if (rgba) ctx?.putImageData?.(new ImageData(rgba, sp.width, sp.height), 0, 0)
  canvas.dataset.drawn = want
}

/** Decodes a reply's arts (16 x 16 RGBA) once. */
export function decodeArts(arts: Record<string, string>): Map<string, Uint8ClampedArray> {
  return new Map(Object.entries(arts).map(([k, v]) => [k, decodeRgba(v)]))
}

/** A block-content indicator with its plane, as `mapBlockContents` replies. */
export type Indicator = BlockIndicatorDto

const blockRect = (i: Indicator) => ({ x0: i.x, y0: i.y, x1: i.x + BLOCK, y1: i.y + BLOCK })

/** One indicator's identity, for hover and for the painted record. */
export const indicatorId = (i: Indicator): string => `${i.plane}:${i.x}:${i.y}`

/**
 * The indicator the pointer is over: the block under (x, y), among the planes
 * `shown` reports visible, topmost by `rank` (a plane's place in the stacking
 * order, higher is nearer). Null over no block.
 */
export function hoverTarget(
  list: readonly Indicator[],
  x: number,
  y: number,
  shown: (plane: Indicator['plane']) => boolean,
  rank: (plane: Indicator['plane']) => number,
): Indicator | null {
  let best: Indicator | null = null
  for (const i of list) {
    const r = blockRect(i)
    if (x < r.x0 || x >= r.x1 || y < r.y0 || y >= r.y1 || !shown(i.plane)) continue
    if (!best || rank(i.plane) > rank(best.plane)) best = i
  }
  return best
}

export interface PaintedIndicator {
  id: string
  hover: boolean
  /** The item box in the screen canvas's pixels, x1 and y1 exclusive. */
  box: Box
}

/** A native-resolution RGBA image scaled to `dw` x `dh` by nearest sampling. */
export function scaleNearest(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dw: number,
  dh: number,
): Uint8ClampedArray {
  // prettier-ignore
  if (dw === w && dh === h) return src.slice()
  const out = new Uint8ClampedArray(dw * dh * 4)
  // 32-bit pixels, and each source row is sampled once: its repeats are whole-row copies.
  const [s32, o32] = [
    new Uint32Array(src.buffer, src.byteOffset, w * h),
    new Uint32Array(out.buffer),
  ]
  const cols = Uint32Array.from({ length: dw }, (_, x) => Math.min(w - 1, Math.floor((x * w) / dw)))
  let last = -1
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / dh))
    const at = y * dw
    if (sy === last) o32.copyWithin(at, at - dw, at)
    else for (let x = 0; x < dw; x++) o32[at + x] = s32[sy * w + cols[x]!]!
    last = sy
  }
  return out
}

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One region of the display to put back on its canvas after a hover change. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface DisplaySource {
  /** Native size of a screen. */
  width: number
  height: number
  zoom: number
  screen: number
  geometry: ScreenGeometry
  /** The native planes that are shown (a hidden layer's is omitted; a shown, empty one is null). */
  planes: Partial<Record<SourceKey, Uint8ClampedArray | null>>
  lists: ScreenInput['lists']
  math: ScreenInput['math']
  /** The native composite of those same planes: every pixel outside an indicator is its scaled copy. */
  base: Uint8ClampedArray
  indicators: readonly Indicator[]
  arts: ReadonlyMap<string, Uint8ClampedArray>
}

const NO_ART = new Uint8ClampedArray(BLOCK * BLOCK * 4)

/**
 * The screen at screen resolution with its indicators IN their planes (#566, owner ruling
 * 2026-10-06), shown over the native composite, which stays as it is. Per-pixel operations commute with
 * nearest scaling, so the picture is the native composite scaled up (cheap), with each indicator's block
 * cell recomposed at the zoom: its planes' pixels scaled, its plane's indicators painted into the
 * plane's copy, then stacked and put through color math. A nearer plane or a sprite therefore covers an
 * indicator exactly as it covers its block. A hover change recomposes only the cells it touches.
 */
export class IndicatorDisplay {
  readonly width: number
  readonly height: number
  /** The picture, screen resolution RGBA. */
  readonly image: Uint8ClampedArray
  private hoverId: string | undefined
  private readonly mine: readonly Indicator[]
  private readonly left: number
  private readonly top: number

  constructor(
    private readonly src: DisplaySource,
    hoverId?: string,
  ) {
    const g = src.geometry
    ;[this.left, this.top] =
      g.orientation === 'vertical' ? [0, src.screen * g.height] : [src.screen * g.width, 0]
    this.width = Math.round(src.width * src.zoom)
    this.height = Math.round(src.height * src.zoom)
    this.mine = src.indicators.filter(
      q =>
        this.composed(q.plane) &&
        q.x + BLOCK > this.left &&
        q.x < this.left + g.width &&
        q.y + BLOCK > this.top &&
        q.y < this.top + g.height,
    )
    this.hoverId = hoverId
    this.image = scaleNearest(src.base, src.width, src.height, this.width, this.height)
    for (const r of this.mine.map(q => this.rect(q))) this.put(r, this.compose(r))
  }

  /** A plane the lists compose and the view shows: only these have indicators on screen. */
  private composed(p: Indicator['plane']): boolean {
    const { planes, lists } = this.src
    return planes[p] !== undefined && (lists.main.includes(p) || lists.sub.includes(p))
  }

  /** Whether any indicator is on this screen to be shown. */
  get touches(): boolean {
    return this.mine.length > 0
  }

  /** The block cell of an indicator in screen pixels, clipped to the screen. */
  private rect(q: Indicator): Rect {
    const [x, y, z] = [q.x - this.left, q.y - this.top, this.src.zoom]
    const r = (v: number) => Math.round(v * z)
    return {
      x0: Math.max(0, r(x)),
      y0: Math.max(0, r(y)),
      x1: Math.min(this.width, r(x + BLOCK)),
      y1: Math.min(this.height, r(y + BLOCK)),
    }
  }

  /** What was painted: each indicator's item box in screen pixels. */
  records(): PaintedIndicator[] {
    return this.mine.map(q => {
      const hover = indicatorId(q) === this.hoverId
      const box = indicatorBox(q.x - this.left, q.y - this.top, this.src.zoom, hover)
      return { id: indicatorId(q), hover, box }
    })
  }

  /** The cell `r` recomposed at the zoom, with the current hover. */
  private compose(r: Rect): Uint8ClampedArray {
    const s = this.src
    const [rw, rh] = [r.x1 - r.x0, r.y1 - r.y0]
    const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
    for (const [k, data] of Object.entries(s.planes) as [SourceKey, Uint8ClampedArray | null][]) {
      const own = this.mine.filter(q => q.plane === k && this.meets(q, r))
      if (!data && own.length === 0) {
        planes[k] = null
        continue
      }
      const cell = data
        ? scaleRegion(data, s.width, s.height, this.width, this.height, r)
        : new Uint8ClampedArray(rw * rh * 4)
      for (const q of own) {
        const art = s.arts.get(q.art) ?? NO_ART
        const [x, y] = [q.x - this.left, q.y - this.top]
        paintIndicator(cell, rw, rh, x, y, art, s.zoom, indicatorId(q) === this.hoverId, [
          r.x0,
          r.y0,
        ])
      }
      planes[k] = cell
    }
    return composeScreen({ width: rw, height: rh, planes, lists: s.lists, math: s.math })
  }

  /** The item box lies inside its block cell, so the cells meeting is enough. */
  private meets(q: Indicator, r: Rect): boolean {
    const b = this.rect(q)
    return b.x0 < r.x1 && b.x1 > r.x0 && b.y0 < r.y1 && b.y1 > r.y0
  }

  private put(r: Rect, rgba: Uint8ClampedArray): void {
    const rw = r.x1 - r.x0
    for (let y = r.y0; y < r.y1; y++) {
      const row = rgba.subarray((y - r.y0) * rw * 4, (y - r.y0 + 1) * rw * 4)
      this.image.set(row, (y * this.width + r.x0) * 4)
    }
  }

  /** Moves the hover; returns the cells that changed (the old one's and the new one's), recomposed. */
  setHover(next: string | undefined): Region[] {
    const prev = this.hoverId
    if (prev === next) return []
    this.hoverId = next
    const out: Region[] = []
    const seen = new Set<string>()
    for (const q of this.mine.filter(i => [prev, next].includes(indicatorId(i)))) {
      const r = this.rect(q)
      if (seen.has(`${r.x0},${r.y0}`)) continue
      seen.add(`${r.x0},${r.y0}`)
      const rgba = this.compose(r)
      this.put(r, rgba)
      out.push({ x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0, rgba })
    }
    return out
  }
}

/** The region `r` (screen pixels) of a native image scaled to `dw` x `dh`, by nearest sampling. */
export function scaleRegion(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  dw: number,
  dh: number,
  r: Rect,
): Uint8ClampedArray {
  const [rw, rh] = [r.x1 - r.x0, r.y1 - r.y0]
  const out = new Uint8ClampedArray(rw * rh * 4)
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h)
  const o32 = new Uint32Array(out.buffer)
  for (let y = 0; y < rh; y++) {
    const sy = Math.min(h - 1, Math.floor(((r.y0 + y) * h) / dh))
    for (let x = 0; x < rw; x++) {
      o32[y * rw + x] = s32[sy * w + Math.min(w - 1, Math.floor(((r.x0 + x) * w) / dw))]!
    }
  }
  return out
}
