/**
 * Toggleable grid drawn ABOVE a content canvas, shared by GFX and Map16 (and
 * Maps later, with `tiers` for sub-screen and screen lines).
 *
 * It is its own canvas at DEVICE resolution rather than lines baked into the
 * content bitmap: the bitmap is zoomed by CSS, so baked lines would thicken
 * with zoom and blur. The host must be `position: relative` and exactly the
 * content canvas's size (see `.hb-grid-host`); the overlay ignores the pointer.
 *
 * Test hook: `data-grid-lines` holds the `GridLines` JSON that was drawn,
 * `data-grid-cell-px` the CSS px between base lines (cellSize * zoom),
 * `data-grid-dpr` the device pixel ratio it was drawn for.
 */
import * as React from '@theia/core/shared/react'
import { computeGridLines, GridSpec } from './grid-lines'

/** Foreground at partial opacity: reads on light and dark content alike. */
const GRID_ALPHA = 0.4

/** The display's current device pixel ratio, re-read when it changes (window moved, browser zoom). */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = React.useState(() => window.devicePixelRatio || 1)
  React.useEffect(() => {
    // `resolution` matches only the current ratio, so the query fires once
    // when it changes and has to be re-armed for the new value.
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const onChange = (): void => setDpr(window.devicePixelRatio || 1)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [dpr])
  return dpr
}

export function GridOverlay(spec: GridSpec): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const dpr = useDevicePixelRatio()
  const { cellSize, width, height, zoom } = spec
  const tiersKey = JSON.stringify(spec.tiers ?? [])
  const bandsKey = JSON.stringify(spec.bands ?? null)
  const lines = React.useMemo(
    () => computeGridLines({ ...spec, dpr }),
    // `tiers` and `bands` arrive as fresh arrays every render; their JSON is the identity.
    [cellSize, width, height, zoom, dpr, tiersKey, bandsKey],
  )
  const bottom = spec.bands ? Math.max(0, ...spec.bands.map(b => b.top + b.height)) : height
  const cssW = width * zoom
  const cssH = bottom * zoom
  const devW = Math.round(cssW * dpr)
  const devH = Math.round(cssH * dpr)
  const linesJson = JSON.stringify(lines)
  // Read at render so a theme switch (which re-renders the widget) changes the key.
  const color = getComputedStyle(document.body).getPropertyValue('--theia-foreground').trim()
  // Repaint only when what is drawn changes: a Map16 animation tick re-renders
  // the widget many times a second with identical lines.
  React.useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, devW, devH)
    ctx.fillStyle = color || '#888888'
    ctx.globalAlpha = GRID_ALPHA
    for (const l of lines.x) ctx.fillRect(l.start, l.from, l.size, l.to - l.from)
    for (const l of lines.y) ctx.fillRect(l.from, l.start, l.to - l.from, l.size)
  }, [linesJson, devW, devH, color, lines])
  return (
    <canvas
      ref={ref}
      className="hb-grid-overlay"
      width={devW}
      height={devH}
      style={{ width: `${cssW}px`, height: `${cssH}px` }}
      data-grid-cell-px={cellSize * zoom}
      data-grid-dpr={dpr}
      data-grid-lines={linesJson}
    />
  )
}
