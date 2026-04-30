import type { SmwMap } from '../../../rom/model/SmwMap'
import { L3TilemapLayer } from '../../../rom/model/L3Layer'

/**
 * Minimal Canvas2D subset needed by `drawL3Range`. Mirrors the pattern in
 * `drawSurfaces.ts` so both overlays are testable against the same mock.
 */
export interface L3RangeDrawCtx {
  fillStyle:   string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth:   number
  /** Set to 'round' when drawing outlined text — default 'miter' produces
   *  visible spike artifacts at sharp letter corners (e.g. inside the M). */
  lineJoin:    CanvasLineJoin
  font:        string
  save(): void
  restore(): void
  beginPath(): void
  rect(x: number, y: number, w: number, h: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
  /** Used to draw a dark outline behind tide labels for legibility. */
  strokeText(text: string, x: number, y: number): void
}

const FILL_COLOR        = 'rgba(0, 180, 255, 0.12)'
const STROKE_COLOR      = 'rgba(0, 180, 255, 0.55)'
// Bright magenta for tide lines — high contrast against cyan water, teal
// mountains, green hills, and brown ground. Stays readable on every vanilla
// L3 background tile.
const TIDE_LINE_COLOR   = 'rgba(255, 60, 220, 0.95)'
const LABEL_COLOR       = 'rgba(120, 220, 255, 0.95)'
const TIDE_LABEL_COLOR  = 'rgba(255, 80, 230, 1.00)'
/** Black drop-shadow stroke around tide labels so the text stays legible
 *  on any underlying tile content. */
const LABEL_OUTLINE_COLOR = 'rgba(0, 0, 0, 0.85)'
const LABEL_OUTLINE_WIDTH = 3
const LINE_WIDTH        = 1.5
const TIDE_LINE_WIDTH   = 2
const LABEL_FONT        = 'bold 11px monospace'
const LABEL_PAD_X       = 4
const LABEL_PAD_Y       = 12
/** Vertical offset for the tide-line labels so they sit just above the line. */
const TIDE_LABEL_OFFSET = -3

const KIND_LABEL: Record<string, string> = {
  // Tide kind shows distinct HIGH / LOW labels at each line, so the
  // top-of-rect header label is omitted (was redundant with the per-line
  // labels).
  fixed:            'L3 range — fixed',
  'camera-tracked': 'L3 range — camera-tracked',
}

/**
 * Render the L3 BG-coverage rectangle at the level pixel coords carried in
 * `map.l3.scrollRange`. Drawn as a translucent fill + thin stroke + label,
 * skipped when the level has no L3 (`scrollRange.kind === 'none'`).
 *
 * Coordinates are level pixels; the caller has already applied any zoom
 * transform via the canvas context. `map.l3` is null for levels without an
 * L3 layer; nothing is drawn in that case.
 */
export function drawL3Range(ctx: L3RangeDrawCtx, map: SmwMap): void {
  const l3 = map.l3
  if (!(l3 instanceof L3TilemapLayer)) return
  const range = l3.scrollRange
  if (!range || range.kind === 'none') return

  const w = range.xMax - range.xMin
  const h = range.yMax - range.yMin
  if (w <= 0 || h <= 0) return

  ctx.save()
  ctx.fillStyle   = FILL_COLOR
  ctx.strokeStyle = STROKE_COLOR
  ctx.lineWidth   = LINE_WIDTH
  ctx.beginPath()
  ctx.rect(range.xMin, range.yMin, w, h)
  ctx.fill()
  ctx.stroke()

  ctx.font = LABEL_FONT

  // For tide kind, the rect-header label is dropped (the per-line "L3 High
  // Tide" / "L3 Low Tide" labels already convey the range and kind). For
  // fixed / camera-tracked kinds, draw the kind label on the rect.
  const kindLabel = KIND_LABEL[range.kind]
  if (kindLabel !== undefined) {
    ctx.fillStyle = LABEL_COLOR
    ctx.fillText(kindLabel, range.xMin + LABEL_PAD_X, range.yMin + LABEL_PAD_Y)
  }

  // Tide-only: draw explicit HIGH and LOW reference lines so both extremes
  // are clearly visible. The translucent rect alone gets visually confused
  // with the L3 plane drawn at its rest position; bright magenta lines with
  // outlined labels stand out against any underlying tile content.
  if (range.kind === 'tide' && range.yHighTide !== undefined && range.yLowTide !== undefined) {
    ctx.strokeStyle = TIDE_LINE_COLOR
    ctx.lineWidth   = TIDE_LINE_WIDTH
    ctx.beginPath()
    ctx.moveTo(range.xMin, range.yHighTide)
    ctx.lineTo(range.xMax, range.yHighTide)
    ctx.moveTo(range.xMin, range.yLowTide)
    ctx.lineTo(range.xMax, range.yLowTide)
    ctx.stroke()

    // Outlined labels: black stroke first (provides drop-shadow effect for
    // legibility against any underlying tile color), magenta fill on top.
    drawOutlinedLabel(ctx, 'L3 Max', range.xMin + LABEL_PAD_X, range.yHighTide + TIDE_LABEL_OFFSET)
    drawOutlinedLabel(ctx, 'L3 Min', range.xMin + LABEL_PAD_X, range.yLowTide  + TIDE_LABEL_OFFSET)
  }

  ctx.restore()
}

function drawOutlinedLabel(ctx: L3RangeDrawCtx, text: string, x: number, y: number): void {
  ctx.strokeStyle = LABEL_OUTLINE_COLOR
  ctx.lineWidth   = LABEL_OUTLINE_WIDTH
  // Round joins prevent the default miter from extending into spikes at the
  // sharp interior corners of letters like 'M' / 'A' / 'V'.
  ctx.lineJoin    = 'round'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = TIDE_LABEL_COLOR
  ctx.fillText(text, x, y)
}
