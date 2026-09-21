import type { Sprite } from '../../rom/model/sprites/Sprite'
import {
  blitPartsRgba,
  partBounds,
  partsBounds,
  previewScale,
  type PaletteRows,
  type PreviewBounds,
  type RgbaBuffer,
} from './spritePixels'

/**
 * One 8x8 OAM part, reduced to what the inspector shows. `pixels` is the
 * 64-entry colour-index tile snapshotted at selection time, the same array
 * `StaticSpriteAppearance.render` blits, so the pane cannot drift from the
 * map. Not re-read afterwards: the pane is a still, not a player.
 */
export interface SpritePartInfo {
  char: number
  palette: number
  flipX: boolean
  flipY: boolean
  dx: number
  dy: number
  pixels: Uint8Array
}

/**
 * Read-only inspector view of a selected sprite. Every field comes from
 * the model graph the webview already holds; nothing here reads the ROM
 * or needs anything added to the map payload.
 */
export interface SpriteProps {
  id: number
  displayName?: string
  col: number
  row: number
  /** null when the appearance does not expose a flat part list. */
  parts: SpritePartInfo[] | null
  /** Distinct CGRAM rows the parts draw with, ascending. Empty when parts are unknown. */
  paletteRows: number[]
  animated: boolean
}

const TILE_PX = 16

/**
 * Stable identity for a placed sprite. Same `id:x,y` form the annotation
 * toggle set uses, so both features key off one convention.
 */
export function spriteSelectionKey(sprite: Sprite): string {
  return `${sprite.id}:${sprite.x},${sprite.y}`
}

export function spriteProps(sprite: Sprite): SpriteProps {
  const raw = sprite.appearance.parts
  const parts = raw
    ? raw.map(p => ({
        char: p.char.id,
        palette: p.palette,
        flipX: p.flipX,
        flipY: p.flipY,
        dx: p.dx,
        dy: p.dy,
        pixels: p.char.getPixels(),
      }))
    : null
  return {
    id: sprite.id,
    displayName: sprite.behavior.displayName,
    col: Math.floor(sprite.x / TILE_PX),
    row: Math.floor(sprite.y / TILE_PX),
    parts,
    paletteRows: parts ? [...new Set(parts.map(p => p.palette))].sort((a, b) => a - b) : [],
    animated: typeof sprite.appearance.tickAnimation === 'function',
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

const hex2 = (n: number): string => `$${n.toString(16).padStart(2, '0').toUpperCase()}`
const hex3 = (n: number): string => `$${n.toString(16).padStart(3, '0').toUpperCase()}`

const LABEL = 'font-size:9px;font-weight:700;letter-spacing:.08em;color:#888;margin-bottom:4px;'

function section(title: string, body: string): string {
  return `<div style="margin-bottom:8px;"><div style="${LABEL}">${title}</div>${body}</div>`
}

/** Swatch strip for one CGRAM row, mirroring the tile pane's rendering. */
function paletteRowHtml(rowIdx: number, paletteRows: PaletteRows): string {
  const swatches = (paletteRows[rowIdx] ?? [])
    .map(
      ([r, g, b]) =>
        `<span class="pp-swatch" style="display:inline-block;width:9px;height:9px;background:rgb(${r},${g},${b});flex-shrink:0;"></span>`,
    )
    .join('')
  return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">
      <span style="font-family:monospace;color:#ccc;">${rowIdx}</span>
      <div style="display:flex;gap:1px;flex-wrap:wrap;">${swatches}</div>
    </div>`
}

/**
 * Canvas placeholders, painted later by `paintSpritePreviews`. Intrinsic
 * size is the art's own pixel size and CSS size is the integer upscale, so
 * the browser does the magnification; `pixelated` keeps it nearest-neighbour.
 */
const CANVAS_STYLE =
  'image-rendering:pixelated;background:#1b1b1b;border:1px solid #333;display:block;'

function canvasHtml(attr: string, b: PreviewBounds, scale: number): string {
  return (
    `<canvas ${attr} width="${b.w}" height="${b.h}" ` +
    `style="${CANVAS_STYLE}width:${b.w * scale}px;height:${b.h * scale}px;"></canvas>`
  )
}

/** The whole sprite, parts placed at their own dx/dy. */
function compositeHtml(parts: readonly SpritePartInfo[]): string {
  const b = partsBounds(parts)
  const scale = previewScale(b.w, b.h)
  return (
    `<div style="display:flex;justify-content:center;padding:2px 0;">` +
    `${canvasHtml('data-pp-composite="1"', b, scale)}</div>` +
    `<div style="text-align:center;font-family:monospace;font-size:9px;color:#666;margin-top:3px;">` +
    `${b.w}x${b.h} px &middot; ${scale}x</div>`
  )
}

/** 8x8 at 4x is 32px: big enough to recognise, narrow enough for five columns. */
const TILE_SCALE = 4
/** Above this the grid opens collapsed; $9F Banzai Bill has 64 parts. */
const PARTS_OPEN_MAX = 12
/** Bounded so the grid scrolls inside the pane instead of pushing later sections off it. */
const PARTS_MAX_HEIGHT = 168

function partsHtml(parts: readonly SpritePartInfo[]): string {
  const cells = parts
    .map((p, i) => {
      const flip = `${p.flipX ? 'X' : ''}${p.flipY ? 'Y' : ''}`
      const flipTag = flip ? `<span style="color:#d08770;"> ${flip}</span>` : ''
      return (
        `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;">` +
        `${canvasHtml(`data-pp-part="${i}"`, partBounds(p), TILE_SCALE)}` +
        `<span style="font-family:monospace;font-size:9px;color:#5b9cf6;white-space:nowrap;">` +
        `${hex3(p.char)}${flipTag}</span></div>`
      )
    })
    .join('')
  return (
    `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px 4px;` +
    `max-height:${PARTS_MAX_HEIGHT}px;overflow-y:auto;">${cells}</div>`
  )
}

/** A section the reader can fold away. The pane has more facets coming; see docs/ideas/sprite-properties-panel.md. */
function foldSection(title: string, open: boolean, body: string): string {
  return (
    `<details${open ? ' open' : ''} style="margin-bottom:8px;">` +
    `<summary style="${LABEL}cursor:pointer;user-select:none;">${title}</summary>${body}</details>`
  )
}

/** Render the sprite pane body. `paletteRows` is the payload's 16x16 CGRAM snapshot. */
export function spritePropsHtml(p: SpriteProps, paletteRows: PaletteRows): string {
  const name = p.displayName
    ? `<div style="color:#ccc;margin-bottom:2px;">${esc(p.displayName)}</div>`
    : ''
  const head = section(
    'SPRITE',
    `${name}<div style="font-family:monospace;color:#5b9cf6;">${hex2(p.id)}</div>`,
  )
  const art = p.parts && p.parts.length > 0 ? section('APPEARANCE', compositeHtml(p.parts)) : ''
  const pos = section(
    'POSITION',
    `<div style="font-family:monospace;color:#ccc;">col ${p.col}&nbsp;&nbsp;row ${p.row}</div>`,
  )
  const pal =
    p.paletteRows.length > 0
      ? section('PALETTE ROW', p.paletteRows.map(r => paletteRowHtml(r, paletteRows)).join(''))
      : ''
  const parts = p.parts
    ? foldSection(`PARTS (${p.parts.length})`, p.parts.length <= PARTS_OPEN_MAX, partsHtml(p.parts))
    : section(
        'PARTS',
        '<span style="color:#555;font-style:italic;">not exposed by this appearance</span>',
      )
  // `animated` is "does this appearance implement tickAnimation", which is a
  // fact about our renderer and not about the cart. Most unanimated sprites
  // are unanimated because nobody has modelled them yet, so the wording names
  // the editor as the subject the way the parts fallback names the appearance.
  const anim = section(
    'ANIMATION',
    p.animated
      ? '<div style="color:#ccc;">animated in the editor</div>'
      : '<span style="color:#555;font-style:italic;">not animated in the editor;' +
          ' no frames modelled for this appearance</span>',
  )
  return head + art + pos + pal + parts + anim
}

/**
 * Paint the placeholders `spritePropsHtml` emitted. Structural interfaces
 * rather than DOM types, so the mapping from `data-pp-*` to pixels is
 * testable without a canvas implementation.
 */
export interface PreviewCanvas {
  getAttribute(name: string): string | null
  getContext(id: '2d'): { putImageData(image: never, dx: number, dy: number): void } | null
}

export function paintSpritePreviews(
  canvases: Iterable<PreviewCanvas>,
  parts: readonly SpritePartInfo[] | null,
  paletteRows: PaletteRows,
  makeImage: (data: RgbaBuffer, w: number, h: number) => unknown,
): void {
  if (!parts || parts.length === 0) return
  for (const canvas of canvases) {
    const partAttr = canvas.getAttribute('data-pp-part')
    let draw: readonly SpritePartInfo[]
    let bounds: PreviewBounds
    if (partAttr !== null) {
      const part = parts[Number(partAttr)]
      if (!part) continue
      draw = [part]
      bounds = partBounds(part)
    } else if (canvas.getAttribute('data-pp-composite') !== null) {
      draw = parts
      bounds = partsBounds(parts)
    } else {
      continue
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.putImageData(
      makeImage(blitPartsRgba(draw, paletteRows, bounds), bounds.w, bounds.h) as never,
      0,
      0,
    )
  }
}
