/**
 * Toggleable grid drawn ABOVE a content canvas: GridOverlay for GFX and Map16
 * (content-sized), MapGridOverlay for Maps (viewport-sized, see below).
 *
 * It is its own canvas at DEVICE resolution rather than lines baked into the
 * content bitmap: the bitmap is zoomed by CSS, so baked lines would thicken
 * with zoom and blur. The host must be `position: relative` and exactly the
 * content canvas's size (see `.hb-grid-host`), or pass `locate`; the overlay
 * ignores the pointer.
 *
 * Test hook: `data-grid-lines` holds the `GridLines` JSON that was drawn,
 * `data-grid-cell-px` the CSS px between base lines (cellSize * zoom),
 * `data-grid-dpr` the device pixel ratio it was drawn for.
 */
import * as React from '@theia/core/shared/react'
import { computeGridLines, GridLines, GridSpec } from './grid-lines'
import { computeMapGridLines } from './map-grid'

/** Foreground at partial opacity: reads on light and dark content alike. */
const GRID_ALPHA = 0.4

/** The display's current device pixel ratio, re-read when it changes (window moved, browser zoom). */
export function useDevicePixelRatio(): number {
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

export interface GridOverlayProps extends GridSpec {
  /**
   * For a host that cannot give the overlay a positioned wrapper of its own:
   * where, in the overlay's containing block, the content canvas's top-left is.
   * Read after every commit, so a remounted canvas is never located stale.
   */
  locate?: () => { left: number; top: number } | undefined
}

/**
 * The canvas itself: sized in device px, shown at CSS size, repainted only
 * when the lines, size or color change (a Map16 animation tick or any other
 * unrelated render re-renders it with identical props and paints nothing).
 */
export function GridCanvas(props: {
  lines: GridLines
  devW: number
  devH: number
  cssW: number
  cssH: number
  cellPx: number
  dpr: number
  locate?: () => { left: number; top: number } | undefined
}): React.ReactElement {
  const { lines, devW, devH, cssW, cssH, cellPx, dpr } = props
  const ref = React.useRef<HTMLCanvasElement>(null)
  React.useLayoutEffect(() => {
    const at = props.locate?.()
    if (ref.current && at) {
      ref.current.style.left = `${at.left}px`
      ref.current.style.top = `${at.top}px`
    }
  })
  const linesJson = JSON.stringify(lines)
  // Read at render so a theme switch (which re-renders the widget) changes the key.
  const color = getComputedStyle(document.body).getPropertyValue('--theia-foreground').trim()
  React.useEffect(() => {
    const ctx = ref.current?.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, devW, devH)
    ctx.fillStyle = color || '#888888'
    ctx.globalAlpha = GRID_ALPHA
    for (const l of lines.x) ctx.fillRect(l.start, l.from, l.size, l.to - l.from)
    for (const l of lines.y) ctx.fillRect(l.from, l.start, l.to - l.from, l.size)
  }, [linesJson, devW, devH, color])
  return (
    <canvas
      ref={ref}
      className="hb-grid-overlay"
      width={devW}
      height={devH}
      style={{ width: `${cssW}px`, height: `${cssH}px` }}
      data-grid-cell-px={cellPx}
      data-grid-dpr={dpr}
      data-grid-lines={linesJson}
    />
  )
}

export function GridOverlay(spec: GridOverlayProps): React.ReactElement {
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
  return (
    <GridCanvas
      lines={lines}
      devW={Math.round(cssW * dpr)}
      devH={Math.round(cssH * dpr)}
      cssW={cssW}
      cssH={cssH}
      cellPx={cellSize * zoom}
      dpr={dpr}
      locate={spec.locate}
    />
  )
}

/**
 * The Maps grid: a canvas the size of the scroller's VIEWPORT, never of the
 * content (a wide level at 4x is tens of thousands of px, past canvas limits).
 * It sits over the scroller (not inside it), reads the scroll offsets and
 * client size, and draws only the lines in view, so it follows scroll, zoom
 * (fractional Fit included) and resize.
 */
export function MapGridOverlay(props: {
  scroller: HTMLElement | null
  vertical: boolean
  screenCount: number
  zoom: number
}): React.ReactElement | null {
  const { scroller, vertical, screenCount, zoom } = props
  const dpr = useDevicePixelRatio()
  const read = (): MapView => ({
    scrollX: scroller?.scrollLeft ?? 0,
    scrollY: scroller?.scrollTop ?? 0,
    viewW: scroller?.clientWidth ?? 0,
    viewH: scroller?.clientHeight ?? 0,
  })
  const [view, setView] = React.useState<MapView>(read)
  const sync = (): void => setView(v => (sameView(v, read()) ? v : read()))
  React.useLayoutEffect(() => {
    if (!scroller) return
    scroller.addEventListener('scroll', sync, { passive: true })
    const ro = new ResizeObserver(sync)
    ro.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', sync)
      ro.disconnect()
    }
  }, [scroller])
  // After EVERY commit: a zoom resizes the content and the wheel anchor then
  // moves the scroll, in that order, so the offsets read during render are stale.
  React.useLayoutEffect(sync)
  const v = view
  const lines = React.useMemo(
    () => computeMapGridLines({ vertical, screenCount, zoom, dpr, ...v }),
    [vertical, screenCount, zoom, dpr, v.scrollX, v.scrollY, v.viewW, v.viewH],
  )
  if (!scroller || v.viewW <= 0 || v.viewH <= 0) return null
  return (
    <GridCanvas
      lines={lines}
      devW={Math.round(v.viewW * dpr)}
      devH={Math.round(v.viewH * dpr)}
      cssW={v.viewW}
      cssH={v.viewH}
      cellPx={16 * zoom}
      dpr={dpr}
    />
  )
}

interface MapView {
  scrollX: number
  scrollY: number
  viewW: number
  viewH: number
}
const sameView = (a: MapView, b: MapView): boolean =>
  a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.viewW === b.viewW && a.viewH === b.viewH
