/**
 * Toggleable grid drawn ABOVE a content canvas, shared by GFX and Map16 (and
 * Maps later, with `tiers` for sub-screen and screen lines).
 *
 * It is its own canvas at screen resolution rather than lines baked into the
 * content bitmap: the bitmap is zoomed by CSS, so baked lines would thicken
 * with zoom and blur. The host must be `position: relative` and exactly the
 * content canvas's size (see `.hb-grid-host`); the overlay ignores the pointer.
 *
 * Test hook: `data-grid-lines` holds the `GridLines` JSON that was drawn,
 * `data-grid-cell-px` the screen px between base lines (cellSize * zoom).
 */
import * as React from '@theia/core/shared/react'
import { computeGridLines, GridSpec } from './grid-lines'

/** Foreground at partial opacity: reads on light and dark content alike. */
const GRID_ALPHA = 0.4

export function GridOverlay(spec: GridSpec): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const lines = computeGridLines(spec)
  const w = Math.ceil(spec.width * spec.zoom)
  const h = Math.ceil(
    spec.bands
      ? Math.max(...spec.bands.map(b => b.top + b.height)) * spec.zoom
      : spec.height * spec.zoom,
  )
  // No dependency list: the theme color is read at draw time, so every render repaints.
  React.useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = getComputedStyle(canvas).color
    ctx.globalAlpha = GRID_ALPHA
    for (const l of lines.x) {
      // The last line would sit one pixel past the canvas, so it is pulled inside.
      const x = Math.min(Math.round(l.pos), w - l.weight)
      ctx.fillRect(x, Math.round(l.from), l.weight, Math.round(l.to - l.from))
    }
    for (const l of lines.y) {
      const y = Math.min(Math.round(l.pos), h - l.weight)
      ctx.fillRect(Math.round(l.from), y, Math.round(l.to - l.from), l.weight)
    }
  })
  return (
    <canvas
      ref={ref}
      className="hb-grid-overlay"
      width={w}
      height={h}
      data-grid-cell-px={spec.cellSize * spec.zoom}
      data-grid-lines={JSON.stringify(lines)}
    />
  )
}
