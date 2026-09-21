// Consumes: editorStore.{l2YOverride, scrollProgress, frameL2}, mapStore.scrollSimulator
import { cellBoxAt, cellBoxAtXY, cellBoxOf } from './RenderTarget'
import type { Phase, RenderTarget } from './RenderTarget'
import type { L2ScrollRange } from '../L2Loader'
import { editorStore } from './stores/editorStore'
import type { MapStore } from './stores/mapStore'
import type { Tile } from './tiles/Tile'

export abstract class L2Layer {
  /**
   * Draw only the cells whose Map16 subtiles carry `phase`. Layer 2 has a
   * genuine priority split on the PPU (BG2.1 sits above OBJ.2, BG2.0 below
   * it), so the compositor drives the two separately.
   */
  abstract render(target: RenderTarget, mapStore: MapStore, phase: Phase): void

  /** Which tile-priority phases this layer has content for. */
  abstract phases(mapStore: MapStore): Set<Phase>

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
   * `page` is 0 or 1 - derived from the preset's BG data address threshold
   * (see `L2_PAGE_THRESHOLD` in L2Loader).
   *
   * `grid` is a 2D table of BG Map16 tile IDs (or null for empty cells),
   * which resolve against the shared `bgTiles` map at render time. This
   * mirrors how vanilla SMW stores the preset - Map16 pointers into the
   * BG table - and keeps the layer a lightweight data structure rather
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
      row.map(id => (id === null ? null : (this.bgTiles.get(id) ?? null))),
    )
  }

  render(target: RenderTarget, mapStore: MapStore, phase: Phase): void {
    for (let y = 0; y < this.grid.length; y++) {
      const row = this.grid[y]
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.bgTiles.get(id)
        if (!tile) continue
        tile.render(target, cellBoxOf(x, y), mapStore, phase)
      }
    }
  }

  phases(mapStore: MapStore): Set<Phase> {
    return gridPhases(this.grid, this.bgTiles, mapStore)
  }
}

export class L2ObjectStream extends L2Layer {
  /**
   * Object-stream L2 shares the L1 Map16 table, so `grid` holds ids
   * that resolve against an L2-specific tile collection. For tilesets
   * 0/1/2/4/5+, the collection IS the L1 atlas. For tileset 3, every
   * tile is wrapped in `PaletteOrBehavior(mask=4)` to mirror the
   * runtime ORA at bank_05.asm:1463-1480 - see `buildL2Tiles` in
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
     * connected component the tile belongs to - derived by
     * `L2Factory.buildTileDyRanges` (BFS flood-fill + per-component
     * column-range union). Tiles in the same contiguous region share
     * one range, so the slider moves the region as a rigid unit.
     *
     * `null` entry = empty tile or component the camera never reached -
     * render skips it. `null` outer = no simulator; render falls back
     * to a global `dy = initialCameraYPx − initialL2YPx`.
     */
    readonly tileDyRanges:
      readonly (readonly ({ min: number; max: number } | null)[])[] | null = null,
  ) {
    super()
  }

  layout(): (Tile | null)[][] {
    return this.grid.map(row =>
      row.map(id => (id === null ? null : (this.l1Tiles.get(id) ?? null))),
    )
  }

  render(target: RenderTarget, mapStore: MapStore, phase: Phase): void {
    // Three render modes, in priority order:
    //
    //   1. **Frame-accurate mode** (auto-scroll level: `mapStore
    //      .scrollSimulator` exists AND `editorStore.frameL2 >= 0`).
    //      `L2ObjectStream.render` queries the simulator for the L2
    //      frame state and shifts every tile by
    //      `(layer1{X,Y}Pos − layer2{X,Y}Pos)` at that frame. Using
    //      ONLY `frameL2` (not `frameL1`) means the L2 plane reflects
    //      the SNES viewport offset at L2's chosen point in time -
    //      which is the natural mental model for the scrub: scrolling
    //      L2 alone moves L2; scrolling L1 alone moves the L1 path
    //      overlay but leaves L2 untouched.
    //
    //   2. **Per-tile dy-range lerp** (`tileDyRanges` non-null and
    //      frame mode inactive). Each tile picks up its 2D-connected-
    //      component range from `tileDyRanges` and lerps within it by
    //      `editorStore.scrollProgress` (0..255 → 0..1). Legacy path
    //      for clients that don't drive `frameL2`.
    //
    //   3. **Static fallback** (no `tileDyRanges`). Global `dy =
    //      initialCameraYPx − l2YOverride` for non-auto-scroll levels.
    const sim = mapStore.scrollSimulator
    const frameL2 = editorStore.frameL2
    if (sim !== null && frameL2 >= 0) {
      const s = sim.stateAtFrame(frameL2)
      // Signed (l1Pos − l2Pos) deltas in pixels. Both fields are 16-bit
      // unsigned in WRAM; reinterpret as signed for the display shift.
      const dxRaw = (s.layer1XPos - s.layer2XPos) | 0
      const dyRaw = (s.layer1YPos - s.layer2YPos) | 0
      let dx = ((dxRaw + 0x8000) & 0xffff) - 0x8000
      let dy = ((dyRaw + 0x8000) & 0xffff) - 0x8000
      // SNES BG2 plane wraparound. Cmd $09 / $0D Fast-BG-scroll levels
      // ($0C8, $122) push `l2x` arbitrarily far past `l1x`, so the
      // raw delta `(l1x − l2x)` saturates at large negative values
      // and the L2 grid renders entirely off the left of the canvas.
      // The actual SNES BG plane is a fixed-size tilemap (32×32
      // 16x16-tiles = 512×512 px in standard SMW BG2 mode) that
      // tiles infinitely as the camera scrolls - same Map16 strips
      // cycle through.
      //
      // For our editor we model this by wrapping the offset modulo
      // the L2 grid pixel size: each tile renders once at a
      // canonical wrapped position. Levels where the grid is wider
      // than the visible canvas show one wrapped copy; smaller
      // grids would need multi-copy tiling (follow-up if any vanilla
      // level needs it).
      const gridPxW = (this.grid[0]?.length ?? 0) * 16
      const gridPxH = this.grid.length * 16
      if (gridPxW > 0) dx = ((dx % gridPxW) + gridPxW) % gridPxW
      if (gridPxH > 0) dy = ((dy % gridPxH) + gridPxH) % gridPxH
      // Pick the wrapped value closest to 0 so a small forward dx
      // shifts the grid right (intuitive) rather than wrapping all
      // the way to the right edge. Only the magnitude matters for
      // visibility - the modular reduction was the actual fix.
      if (gridPxW > 0 && dx > gridPxW / 2) dx -= gridPxW
      if (gridPxH > 0 && dy > gridPxH / 2) dy -= gridPxH
      // SNES BG2 tiles infinitely. For small grids (cmd $09/$0D levels
      // with a one-screen-wide plane) the primary wrapped copy leaves
      // canvas to either side empty. Render up to 3×3 copies offset by
      // integer multiples of (gridPxW, gridPxH) to fill the visible area.
      for (let cy = -1; cy <= 1; cy++) {
        for (let cx = -1; cx <= 1; cx++) {
          const tdx = dx + cx * gridPxW
          const tdy = dy + cy * gridPxH
          for (let y = 0; y < this.grid.length; y++) {
            const row = this.grid[y]
            for (let x = 0; x < row.length; x++) {
              const id = row[x]
              if (id === null) continue
              const tile = this.l1Tiles.get(id)
              if (!tile) continue
              const box = tdx === 0 && tdy === 0 ? cellBoxOf(x, y) : cellBoxAtXY(x, y, tdx, tdy)
              tile.render(target, box, mapStore, phase)
            }
          }
        }
      }
      return
    }

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
        let cellDy: number
        if (useRanges) {
          const r = tileRow?.[x] ?? null
          if (!r) continue // null = empty cell, or component camera never reached
          cellDy = Math.round(r.min + (r.max - r.min) * t)
        } else {
          cellDy = fallbackDy
        }
        const box = cellDy === 0 ? cellBoxOf(x, y) : cellBoxAt(x, y, cellDy)
        tile.render(target, box, mapStore, phase)
      }
    }
  }

  phases(mapStore: MapStore): Set<Phase> {
    return gridPhases(this.grid, this.l1Tiles, mapStore)
  }
}

/**
 * Phases a Map16 id grid occupies, sampled from each distinct id's subtile
 * quad. Evidence scope: the quad is the tile's static Map16 definition, so
 * a behavior that swaps quads per cell (pipe screen variants) is read at
 * whichever cell the id first appears on.
 */
function gridPhases(
  grid: (number | null)[][],
  tiles: Map<number, Tile>,
  mapStore: MapStore,
): Set<Phase> {
  const out = new Set<Phase>()
  const seen = new Set<number>()
  for (let y = 0; y < grid.length && out.size < 2; y++) {
    const row = grid[y]
    if (!row) continue
    for (let x = 0; x < row.length && out.size < 2; x++) {
      const id = row[x]
      if (id === null || seen.has(id)) continue
      seen.add(id)
      for (const sub of tiles.get(id)?.quadAt(cellBoxOf(x, y), mapStore) ?? []) {
        out.add(sub.priority ? 'priority' : 'nonPriority')
      }
    }
  }
  return out
}
