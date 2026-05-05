/**
 * Animated camera-viewport overlay driven by the Scroll panel's Play
 * button. Draws ONE 256x224 rect at the L1 viewport position for the
 * current `scrollPlaybackFrame` sample of `mapData.header.scrollPath`.
 * As the playback advances the frame index, the rect slides through
 * the level — visualizing how the auto-scroll routine carries the
 * camera through the map at game speed.
 */

import type { ScrollPathSample } from './drawScrollPath'

export interface ScrollPlaybackDrawCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle:   string | CanvasGradient | CanvasPattern
  lineWidth:   number
  font:        string
  save(): void
  restore(): void
  beginPath(): void
  rect(x: number, y: number, w: number, h: number): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
}

const VIEWPORT_W = 256
const VIEWPORT_H = 224

const FILL_COLOR   = 'rgba(255, 80, 80, 0.05)'
const STROKE_COLOR = 'rgba(255, 80, 80, 0.95)'
const LABEL_COLOR  = 'rgba(255, 200, 200, 0.95)'
const LINE_WIDTH   = 2.5
const LABEL_FONT   = 'bold 11px monospace'

export function drawScrollPlayback(
  ctx: ScrollPlaybackDrawCtx,
  samples: readonly ScrollPathSample[],
  frameIdx: number,
): void {
  if (frameIdx < 0 || samples.length === 0) return
  const idx = Math.max(0, Math.min(samples.length - 1, frameIdx))
  const s = samples[idx]
  ctx.save()
  ctx.fillStyle   = FILL_COLOR
  ctx.strokeStyle = STROKE_COLOR
  ctx.lineWidth   = LINE_WIDTH
  ctx.beginPath()
  ctx.rect(s.l1x, s.l1y, VIEWPORT_W, VIEWPORT_H)
  ctx.fill()
  ctx.stroke()

  ctx.font = LABEL_FONT
  ctx.fillStyle = LABEL_COLOR
  ctx.fillText(`f ${s.f}`, s.l1x + 4, s.l1y + 12)
  ctx.restore()
}
