import type { SmwMap } from '../../../rom/model/SmwMap'
import { L2ObjectStream } from '../../../rom/model/L2Layer'

/**
 * Minimal Canvas2D subset needed by `drawL2Range`. Mirrors the shape of
 * `drawL3Range`'s context so both overlays can share a mock in tests.
 */
export interface L2RangeDrawCtx {
  fillStyle:   string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth:   number
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
  strokeText(text: string, x: number, y: number): void
}

// Amber/orange so the L2 overlay is visually distinct from L3's cyan rects.
const FILL_COLOR    = 'rgba(255, 170, 0, 0.12)'
const STROKE_COLOR  = 'rgba(255, 170, 0, 0.55)'
const LABEL_COLOR   = 'rgba(255, 200, 80, 0.95)'
const LINE_WIDTH    = 1.5
const LABEL_FONT    = 'bold 11px monospace'
const LABEL_PAD_X   = 4
const LABEL_PAD_Y   = 12

/**
 * Render the L2 plane's bounding rectangle (object-stream L2 only) at the
 * pixel coords carried in `map.l2.scrollRange`. Drawn as a translucent fill
 * + stroke + label, skipped when the layer has no bounded content.
 *
 * The label includes the level's L1 scroll-cmd byte when present — diagnostic
 * tag that lets you spot auto-scroll / sink-rise levels (e.g. cmd $0E) at a
 * glance. Per-frame L2Y animation (sink-rise, screen-shake) is not yet
 * decoded into sweep extremes — see issue #246.
 */
export function drawL2Range(ctx: L2RangeDrawCtx, map: SmwMap): void {
  const l2 = map.l2
  if (!(l2 instanceof L2ObjectStream)) return
  const range = l2.scrollRange
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
  ctx.fillStyle = LABEL_COLOR
  const cmdSuffix = range.layer1ScrollCmd !== undefined
    ? ` (L1 cmd $${range.layer1ScrollCmd.toString(16).toUpperCase().padStart(2, '0')})`
    : ''
  ctx.fillText(`L2 range${cmdSuffix}`, range.xMin + LABEL_PAD_X, range.yMin + LABEL_PAD_Y)

  ctx.restore()
}
