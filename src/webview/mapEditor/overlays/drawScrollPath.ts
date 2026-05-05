/**
 * Visualizes the L1 camera-viewport trajectory across the level.
 *
 * Drawn over the L1 canvas:
 *   - L1 viewport path (cyan polyline): traces the center of the L1
 *     viewport `(Layer1XPos + 128, Layer1YPos + 112)` over the level's
 *     auto-scroll lifetime. Shows where the camera goes through the L1
 *     plane.
 *   - Periodic viewport rectangles (cyan, faint): drawn at sampled
 *     points along the path so the user can see the actual visible
 *     window size (256×224) at each scroll moment.
 *
 * Why no L2 path: from the player's perspective the L2 viewport
 * doesn't move vertically — it stays anchored to the screen alongside
 * L1's viewport. What changes is the L2 sub-area being shown inside
 * it. The L2 motion the player perceives shows up in the editor as
 * the per-column `dy` offset applied to L2 cells in the main canvas
 * (`L2ObjectStream.render`). Drawing a separate "L2 path" polyline at
 * `Layer2YPos` would show the L2 plane's perspective, which doesn't
 * match what the player sees.
 *
 * `samples` come from the host-side `sampleViewportPath` walking the
 * scroll simulator at 8-frame strides.
 */

export interface ScrollPathSample {
  f: number
  l1x: number
  l1y: number
  l2x: number
  l2y: number
}

export interface ScrollPathDrawCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  fillStyle:   string | CanvasGradient | CanvasPattern
  lineWidth:   number
  font:        string
  globalAlpha: number
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  rect(x: number, y: number, w: number, h: number): void
  fill(): void
  stroke(): void
  fillText(text: string, x: number, y: number): void
}

const VIEWPORT_W = 256
const VIEWPORT_H = 224
const HALF_W     = VIEWPORT_W / 2
const HALF_H     = VIEWPORT_H / 2

const PATH_COLOR  = 'rgba(80, 200, 255, 0.85)'   // cyan
const RECT_COLOR  = 'rgba(80, 200, 255, 0.18)'   // cyan faint
const DOT_COLOR   = 'rgba(80, 200, 255, 0.95)'
const LABEL_COLOR = 'rgba(220, 240, 255, 0.9)'
const LABEL_FONT  = 'bold 10px monospace'
const LINE_WIDTH  = 2
const RECT_LINE_W = 1
/** How often to draw a full 256x224 viewport rect along the polyline.
 *  1 sample per 8 frames upstream; 1 rect per 32 samples = 1 rect per
 *  256 frames, ~30 rects across an 8000-frame level. Tight enough to
 *  visualize the path's coverage, loose enough to not clutter. */
const RECT_STRIDE = 32

export function drawScrollPath(
  ctx: ScrollPathDrawCtx,
  samples: readonly ScrollPathSample[],
): void {
  if (samples.length < 2) return
  ctx.save()

  // L1 viewport polyline — center of camera over time.
  ctx.strokeStyle = PATH_COLOR
  ctx.lineWidth   = LINE_WIDTH
  ctx.beginPath()
  ctx.moveTo(samples[0].l1x + HALF_W, samples[0].l1y + HALF_H)
  for (let i = 1; i < samples.length; i++) {
    ctx.lineTo(samples[i].l1x + HALF_W, samples[i].l1y + HALF_H)
  }
  ctx.stroke()

  // Periodic viewport rectangles — show the full 256x224 visible
  // window at sampled points so the user can see how it covers L1.
  ctx.strokeStyle = RECT_COLOR
  ctx.lineWidth   = RECT_LINE_W
  for (let i = 0; i < samples.length; i += RECT_STRIDE) {
    const s = samples[i]
    ctx.beginPath()
    ctx.rect(s.l1x, s.l1y, VIEWPORT_W, VIEWPORT_H)
    ctx.stroke()
  }

  // Endpoint dots + labels.
  const drawDot = (x: number, y: number) => {
    ctx.fillStyle = DOT_COLOR
    ctx.beginPath()
    ctx.arc(x, y, 3, 0, Math.PI * 2)
    ctx.fill()
  }
  const first = samples[0]
  const last  = samples[samples.length - 1]
  drawDot(first.l1x + HALF_W, first.l1y + HALF_H)
  drawDot(last.l1x  + HALF_W, last.l1y  + HALF_H)

  ctx.font = LABEL_FONT
  ctx.fillStyle = LABEL_COLOR
  ctx.fillText('L1 start', first.l1x + HALF_W + 6, first.l1y + HALF_H + 4)
  ctx.fillText('L1 end',   last.l1x  + HALF_W + 6, last.l1y  + HALF_H + 4)

  ctx.restore()
}
