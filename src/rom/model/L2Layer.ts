import { cellBoxOf } from './RenderTarget'
import type { RenderContext, RenderTarget } from './RenderTarget'
import type { Tile } from './tiles/Tile'

export abstract class L2Layer {
  abstract render(ctx: RenderContext, target: RenderTarget): void

  /**
   * 2D (row, col) resolved Tile grid. Callers (camera-viewport parallax,
   * block-view diagnostic) use this view when they need to enumerate
   * Tiles directly. Concrete variants resolve from their id-grids +
   * their lookup tables.
   */
  abstract layout(): (Tile | null)[][]
}

export class L2Preset extends L2Layer {
  /**
   * `page` is 0 or 1 — derived from the preset's BG data address threshold
   * (see `L2_PAGE_THRESHOLD` in L2Loader).
   *
   * `grid` is a 2D table of BG Map16 tile IDs (or null for empty cells),
   * which resolve against the shared `bgTiles` map at render time. This
   * mirrors how vanilla SMW stores the preset — Map16 pointers into the
   * BG table — and keeps the layer a lightweight data structure rather
   * than a copy of Tile references.
   */
  constructor(
    readonly page: number,
    readonly grid: (number | null)[][],
    readonly bgTiles: Map<number, Tile>,
  ) {
    super()
  }

  layout(): (Tile | null)[][] {
    // Resolve the id grid lazily so callers (camera viewport parallax)
    // can still iterate a Tile-valued grid. The common render path
    // overrides `render` below and walks ids directly without this.
    return this.grid.map(row =>
      row.map(id => (id === null ? null : this.bgTiles.get(id) ?? null)),
    )
  }

  render(ctx: RenderContext, target: RenderTarget): void {
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y]
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.bgTiles.get(id)
        if (!tile) continue
        const box = cellBoxOf(x, y)
        tile.render(ctx, target, box, 'nonPriority')
        tile.render(ctx, target, box, 'priority')
      }
    }
  }
}

export class L2ObjectStream extends L2Layer {
  /**
   * Object-stream L2 shares the L1 Map16 table, so `grid` holds ids
   * that resolve against the same `l1Tiles` map the L1 layer uses.
   */
  constructor(
    readonly grid: (number | null)[][],
    readonly l1Tiles: Map<number, Tile>,
  ) {
    super()
  }

  layout(): (Tile | null)[][] {
    return this.grid.map(row =>
      row.map(id => (id === null ? null : this.l1Tiles.get(id) ?? null)),
    )
  }

  render(ctx: RenderContext, target: RenderTarget): void {
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y]
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile) continue
        const box = cellBoxOf(x, y)
        tile.render(ctx, target, box, 'nonPriority')
        tile.render(ctx, target, box, 'priority')
      }
    }
  }
}
