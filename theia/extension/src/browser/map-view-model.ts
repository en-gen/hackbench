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
import { BLOCK, halve, paintIndicator, type Box } from '../common/block-indicator'
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

/** The indicator art of one item, as drawn at rest (half scale) and on hover (the whole block). */
export interface IndicatorArt {
  rest: Uint8ClampedArray
  full: Uint8ClampedArray
}

/** Decodes a reply's arts once; `halve` is the resting scale. */
export function decodeArts(arts: Record<string, string>): Map<string, IndicatorArt> {
  return new Map(
    Object.entries(arts).map(([k, v]) => {
      const full = decodeRgba(v)
      return [k, { rest: halve(full), full }]
    }),
  )
}

/** A block-content indicator with its plane, as `mapBlockContents` replies. */
export type Indicator = BlockIndicatorDto

const blockRect = (i: Indicator) => ({ x0: i.x, y0: i.y, x1: i.x + BLOCK, y1: i.y + BLOCK })
const screenOrigin = (screen: number, g: ScreenGeometry): [number, number] =>
  g.orientation === 'vertical' ? [0, screen * g.height] : [screen * g.width, 0]

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
  /** The item box in this screen's pixels, x1 and y1 exclusive. */
  box: Box
}

/**
 * Paints the indicators of ONE plane onto that plane's screen pixels (a copy
 * is the caller's to make), so hiding the plane hides them. Returns what it
 * painted, for the view to publish.
 */
export function paintPlaneIndicators(
  data: Uint8ClampedArray,
  plane: Indicator['plane'],
  screen: number,
  g: ScreenGeometry,
  list: readonly Indicator[],
  arts: ReadonlyMap<string, IndicatorArt>,
  hoverId: string | undefined,
): PaintedIndicator[] {
  const [left, top] = screenOrigin(screen, g)
  const out: PaintedIndicator[] = []
  for (const i of list) {
    const art = arts.get(i.art)
    const r = blockRect(i)
    if (i.plane !== plane || !art) continue
    if (r.x1 <= left || r.x0 >= left + g.width || r.y1 <= top || r.y0 >= top + g.height) continue
    const hover = indicatorId(i) === hoverId
    const p = paintIndicator(data, g.width, g.height, i.x - left, i.y - top, art, hover)
    out.push({ id: indicatorId(i), hover, box: p.box })
  }
  return out
}
