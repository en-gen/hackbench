import type { Sprite } from '../../rom/model/sprites/Sprite'
import {
  paintSpritePreviews, spriteProps, spritePropsHtml,
  type PreviewCanvas,
} from './spriteProps'
import type { PaletteRows, RgbaBuffer } from './spritePixels'

/**
 * Minimal DOM subset the inspector panes need. Same structural-interface
 * pattern the overlay renderers use for Canvas2D: a real `Document` and
 * `HTMLElement` satisfy these, and a plain object does too, so the pane
 * wiring is testable without a DOM implementation.
 */
export interface PaneEl {
  style:       { display: string }
  innerHTML:   string
  textContent: string | null
  setAttribute(name: string, value: string): void
  /** Present on a real element; how the pane finds its preview canvases. */
  querySelectorAll?(selectors: string): Iterable<PreviewCanvas>
}
export interface PaneHost { getElementById(id: string): PaneEl | null }

export type PropContext = 'tile' | 'sprite' | 'object' | 'empty'

const PANES: readonly PropContext[] = ['tile', 'sprite', 'object', 'empty']

/** Show the pane for `type` and hide the rest; `label` heads the panel. */
export function setPropContext(host: PaneHost, type: PropContext, label = ''): void {
  const ctx = host.getElementById('props-ctx')
  if (ctx) {
    ctx.textContent = label
    ctx.setAttribute('style', label
      ? 'color:#ccc;font-style:normal;'
      : 'color:#888;font-style:italic;')
  }
  for (const t of PANES) {
    const el = host.getElementById(`pp-${t}`)
    if (el) el.style.display = t === type ? (t === 'empty' ? 'flex' : 'block') : 'none'
  }
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0').toUpperCase()

/**
 * Default `ImageData` factory. Guarded because vitest runs this module under
 * `environment: 'node'`, where the constructor does not exist.
 */
const domImageData = (data: RgbaBuffer, w: number, h: number): unknown =>
  new ImageData(data, w, h)

/** Fill the sprite pane for `sprite`, paint its previews, bring it to the front. */
export function showSpriteProps(
  host: PaneHost,
  sprite: Sprite,
  paletteRows: PaletteRows,
  makeImage: (data: RgbaBuffer, w: number, h: number) => unknown = domImageData,
): void {
  const props = spriteProps(sprite)
  const pane = host.getElementById('pp-sprite')
  if (pane) {
    pane.innerHTML = spritePropsHtml(props, paletteRows)
    const canvases = pane.querySelectorAll?.('canvas[data-pp-part],canvas[data-pp-composite]')
    if (canvases) paintSpritePreviews(canvases, props.parts, paletteRows, makeImage)
  }
  setPropContext(host, 'sprite', props.displayName ?? `Sprite $${hex2(props.id)}`)
}
