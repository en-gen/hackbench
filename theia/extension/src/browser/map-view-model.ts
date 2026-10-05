/**
 * The map tab's per-tab state as a cache key: which switch palaces are
 * pressed and which char switches are on both change the picture, so both
 * key a cached screen. Pure, so it is unit tested without a DOM.
 */
import type { MapSpriteDto, SwitchFlagsDto, SwitchStateDto } from '../common/project-protocol'
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

/** Blanks a sprite canvas that still shows an earlier fetch's sprites. */
export function clearSpriteCanvas(canvas: {
  width: number
  height: number
  dataset: DOMStringMap
  getContext(id: '2d'): { clearRect(x: number, y: number, w: number, h: number): void } | null
}): void {
  if (canvas.dataset.drawn === undefined) return
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  delete canvas.dataset.drawn
}
