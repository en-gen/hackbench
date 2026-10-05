/**
 * Where a grid overlay's lines fall, as pure arithmetic (no DOM, no Theia).
 *
 * Positions and weights are in SCREEN pixels: the overlay is drawn at screen
 * resolution, so a 1px line stays 1px at any zoom instead of scaling with the
 * bitmap it sits on. Kept free of `@theia/core` so vitest can load it in CI,
 * where `theia/node_modules` does not exist (see zoom-controller.ts).
 */

/** A heavier line every `every` cells, counted from each band's own origin. */
export interface GridTier {
  every: number
  /** Omitted: both axes. */
  axis?: 'x' | 'y'
  /** Screen pixels. */
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
  /** Screen pixels per content pixel. */
  zoom: number
  tiers?: readonly GridTier[]
  /** Default: one band over the whole height. */
  bands?: readonly GridBand[]
}

export interface GridLine {
  /** Screen px of the line's leading edge, along the axis it divides. */
  pos: number
  /** Screen px thick. */
  weight: number
  /** Screen px extent across the other axis. */
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

export function computeGridLines(spec: GridSpec): GridLines {
  const { cellSize, width, height, zoom } = spec
  const tiers = spec.tiers ?? []
  const bands = spec.bands ?? [{ top: 0, height }]
  const out: GridLines = { x: [], y: [] }
  if (!(cellSize > 0) || !(zoom > 0)) return out
  for (const band of bands) {
    const from = band.top * zoom
    const to = (band.top + band.height) * zoom
    for (let i = 0; i * cellSize <= width; i++) {
      out.x.push({ pos: i * cellSize * zoom, weight: weightAt(i, 'x', tiers), from, to })
    }
    for (let k = 0; k * cellSize <= band.height; k++) {
      out.y.push({
        pos: (band.top + k * cellSize) * zoom,
        weight: weightAt(k, 'y', tiers),
        from: 0,
        to: width * zoom,
      })
    }
  }
  return out
}
