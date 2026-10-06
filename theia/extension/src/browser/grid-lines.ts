/**
 * Where a grid overlay's lines fall, as pure arithmetic (no DOM, no Theia).
 *
 * The overlay is drawn at DEVICE resolution, so a weight-1 line is exactly one
 * device pixel at any zoom and any display scaling, where a line baked into
 * the zoomed bitmap would thicken and blur. `pos` stays in CSS px (cell size
 * times zoom, the number a test can reason about); every other field is in
 * device px, ready to hand to fillRect. At `dpr` 1 the two coincide.
 *
 * Kept free of `@theia/core` so vitest can load it in CI, where
 * `theia/node_modules` does not exist (see zoom-controller.ts).
 */

/** A heavier line every `every` cells, counted from each band's own origin. */
export interface GridTier {
  every: number
  /** Omitted: both axes. */
  axis?: 'x' | 'y'
  /** Device px. Odd, so the line centres exactly on its boundary. */
  weight: number
}

/** A vertical run of content (content px) the grid covers; the gaps between bands get no lines. */
export interface GridBand {
  top: number
  height: number
}

export interface GridSpec {
  /** Content pixels per cell. */
  cellSize: number
  /** Content pixels. */
  width: number
  height: number
  /** CSS pixels per content pixel. */
  zoom: number
  /** Device pixels per CSS pixel. Default 1. */
  dpr?: number
  tiers?: readonly GridTier[]
  /** Default: one band over the whole height. */
  bands?: readonly GridBand[]
}

export interface GridLine {
  /** CSS px of the cell boundary this line sits on. */
  pos: number
  /** Requested thickness, device px. */
  weight: number
  /** Device px: where the drawn line starts and how thick it is, after clipping. */
  start: number
  size: number
  /** Device px extent across the other axis. */
  from: number
  to: number
}

export interface GridLines {
  x: GridLine[]
  y: GridLine[]
}

export const BASE_GRID_WEIGHT = 1

function weightAt(index: number, axis: 'x' | 'y', tiers: readonly GridTier[]): number {
  let weight = BASE_GRID_WEIGHT
  for (const t of tiers) {
    if (t.axis && t.axis !== axis) continue
    if (t.every > 0 && index % t.every === 0) weight = Math.max(weight, t.weight)
  }
  return weight
}

/**
 * Places one line of `weight` on the boundary at device px `at`, inside
 * [lo, hi). A single pixel takes the boundary's leading pixel, pulled inside
 * when the boundary is the trailing edge (otherwise it would be invisible).
 * A wider line is centred and CLIPPED at the edges, never shifted inward, so
 * its centre stays on the boundary. Even weights centre half a pixel early.
 */
export function place(
  at: number,
  weight: number,
  lo: number,
  hi: number,
): [number, number] | undefined {
  if (weight <= 1) {
    const s = Math.min(Math.max(at, lo), hi - 1)
    return hi > lo ? [s, 1] : undefined
  }
  const a = Math.max(at - Math.floor(weight / 2), lo)
  const b = Math.min(at - Math.floor(weight / 2) + weight, hi)
  return b > a ? [a, b - a] : undefined
}

export function computeGridLines(spec: GridSpec): GridLines {
  const { cellSize, width, height, zoom } = spec
  const dpr = spec.dpr ?? 1
  const tiers = spec.tiers ?? []
  const bands = spec.bands ?? [{ top: 0, height }]
  const out: GridLines = { x: [], y: [] }
  if (!(cellSize > 0) || !(zoom > 0) || !(dpr > 0)) return out
  const dev = (css: number): number => Math.round(css * dpr)
  const xEnd = dev(width * zoom)
  for (const band of bands) {
    const from = dev(band.top * zoom)
    const to = dev((band.top + band.height) * zoom)
    for (let i = 0; i * cellSize <= width; i++) {
      const pos = i * cellSize * zoom
      const weight = weightAt(i, 'x', tiers)
      const p = place(dev(pos), weight, 0, xEnd)
      if (p) out.x.push({ pos, weight, start: p[0], size: p[1], from, to })
    }
    for (let k = 0; k * cellSize <= band.height; k++) {
      const pos = (band.top + k * cellSize) * zoom
      const weight = weightAt(k, 'y', tiers)
      const p = place(dev(pos), weight, from, to)
      if (p) out.y.push({ pos, weight, start: p[0], size: p[1], from: 0, to: xEnd })
    }
  }
  return out
}
