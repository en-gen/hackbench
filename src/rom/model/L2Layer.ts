// Consumes: editorStore.{l2YOverride, scrollProgress}
import { cellBoxAt, cellBoxOf } from './RenderTarget'
import type { RenderTarget } from './RenderTarget'
import type { L2ScrollRange } from '../L2Loader'
import { editorStore } from './stores/editorStore'
import type { MapStore } from './stores/mapStore'
import type { Tile } from './tiles/Tile'

export abstract class L2Layer {
  abstract render(target: RenderTarget, mapStore: MapStore): void

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

  render(target: RenderTarget, mapStore: MapStore): void {
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y]
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.bgTiles.get(id)
        if (!tile) continue
        const box = cellBoxOf(x, y)
        tile.render(target, box, mapStore, 'nonPriority')
        tile.render(target, box, mapStore, 'priority')
      }
    }
  }
}

export class L2ObjectStream extends L2Layer {
  /**
   * Object-stream L2 shares the L1 Map16 table, so `grid` holds ids
   * that resolve against an L2-specific tile collection. For tilesets
   * 0/1/2/4/5+, the collection IS the L1 atlas. For tileset 3, every
   * tile is wrapped in `PaletteOrBehavior(mask=4)` to mirror the
   * runtime ORA at bank_05.asm:1463-1480 — see `buildL2Tiles` in
   * `L2Factory.ts` and `paletteOrMask` below.
   *
   * `initialLayer2YPx` is the per-level initial `Layer2YPos` (BG2VOFS) byte
   * read from `DATA_05D70C` via `readInitialLayer2YPos` (bank_05.asm:7323-7328).
   * The render path shifts each cell's pixel Y by `initialCameraYPx -
   * initialLayer2YPx` so L2 rows land at the same screen position the live
   * game shows (mirrors the L3 fix shipped in PR #224).
   */
  constructor(
    readonly grid: (number | null)[][],
    readonly l1Tiles: Map<number, Tile>,
    readonly initialLayer2YPx: number = 0,
    readonly scrollRange: L2ScrollRange = { kind: 'none', xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    /**
     * Palette OR mask carried alongside the layer purely so `serialize`
     * can ship it across to the webview rehydrator (which rebuilds the
     * wrapped tile collection itself). The wrapping itself is already
     * baked into `l1Tiles` by the time we reach this constructor.
     */
    readonly paletteOrMask: number = 0,
    /**
     * `Layer2YPos` extremes the level's scroll-cmd setup actually
     * produces (computed once at build time by walking the
     * `ScrollSimulator` forward via `computeLayer2YRange`). Kept as
     * a diagnostic field for tooling that wants the raw range; the
     * Layer-2 slider itself uses `columnDyRanges` below for render
     * positioning. `null` when the level has no scroll sprite.
     */
    readonly layer2YRange: { min: number; max: number } | null = null,
    /**
     * Per-tile `(Layer1YPos − Layer2YPos)` delta ranges, indexed
     * `[row][col]`. Each non-null entry is the (min, max) of the 2D
     * connected component the tile belongs to — derived by
     * `L2Factory.buildTileDyRanges` (BFS flood-fill + per-component
     * column-range union). Tiles in the same contiguous region share
     * one range, so the slider moves the region as a rigid unit.
     *
     * `null` entry = empty tile or component the camera never reached —
     * render skips it. `null` outer = no simulator; render falls back
     * to a global `dy = initialCameraYPx − initialL2YPx`.
     */
    readonly tileDyRanges: readonly (readonly ({ min: number; max: number } | null)[])[] | null = null,
  ) {
    super()
  }

  layout(): (Tile | null)[][] {
    return this.grid.map(row =>
      row.map(id => (id === null ? null : this.l1Tiles.get(id) ?? null)),
    )
  }

  render(target: RenderTarget, mapStore: MapStore): void {
    // Per-tile dy lerped by `editorStore.scrollProgress` (0..255 → 0..1).
    // Each tile looks up its 2D-connected-component range in `tileDyRanges`
    // (indexed [row][col]). All tiles in the same region share one range,
    // so the slider moves each contiguous L2 region as a rigid unit.
    //
    // Levels without a simulator fall back to a global dy from the legacy
    // `l2YOverride` slider semantics (`initialCameraYPx − liveLayer2YPx`).
    const ranges = this.tileDyRanges
    const useRanges = ranges !== null
    const t = (editorStore.scrollProgress | 0) / 255
    const fallbackLiveL2 = editorStore.l2YOverride ?? this.initialLayer2YPx
    const fallbackDy = mapStore.initialCameraYPx - fallbackLiveL2
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y]
      const tileRow = useRanges ? ranges[y] : null
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile) continue
        let dy: number
        if (useRanges) {
          const r = tileRow?.[x] ?? null
          if (!r) continue  // null = empty cell, or component camera never reached
          dy = Math.round(r.min + (r.max - r.min) * t)
        } else {
          dy = fallbackDy
        }
        const box = dy === 0 ? cellBoxOf(x, y) : cellBoxAt(x, y, dy)
        tile.render(target, box, mapStore, 'nonPriority')
        tile.render(target, box, mapStore, 'priority')
      }
    }
  }
}
