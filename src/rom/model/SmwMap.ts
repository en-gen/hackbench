import { cellBoxOf } from './RenderTarget'
import type { Phase, RenderContext, RenderTarget } from './RenderTarget'
import type { L2Layer } from './L2Layer'
import type { Palette } from './palette/Palette'
import type { Sprite } from './sprites/Sprite'
import type { Tile } from './tiles/Tile'

export type LevelOrientation = 'horizontal' | 'vertical'

export interface LevelHeader {
  mode: number
  music: number
  tileset: number
  orientation: LevelOrientation
  /**
   * Layer-2 scroll settings 0..3 (from $05D710 / $05D720 via the
   * per-level $05F000 byte). Drive the parallax ratio used by the
   * camera-viewport preview.
   */
  vertLayer2Setting?: number
  horizLayer2Setting?: number
}

export class SmwMap {
  constructor(
    readonly id: number,
    readonly header: LevelHeader,
    /**
     * L1 tilemap as a 2D (row, col) table of Map16 ids (or null for
     * empty). The actual Tile instances live in `l1Tiles`; callers that
     * need them resolve `l1Tiles.get(id)`. Storing ids keeps the map a
     * data table and makes the editing model straightforward — replacing
     * a tile is a number write, not a reference swap.
     */
    readonly l1: (number | null)[][],
    readonly l2: L2Layer | null,
    readonly sprites: Sprite[],
    readonly palette: Palette,
    readonly tileset: number,
    readonly screenCount: number,
    readonly screenPipeVariantIdx: number[],
    /** L1 Map16 tile lookup (the 512-entry table this level's tileset
     *  produces). Shared with any L2ObjectStream that points at L1. */
    readonly l1Tiles: Map<number, Tile>,
    /**
     * Full 512-entry BG Map16 tile palette for this level's tileset —
     * always loaded, independent of whether this level's L2 layout
     * references every entry. The Map16 viewer surface (pages 0x80 /
     * 0x81) renders from this, so an editor always shows the whole
     * palette.
     */
    readonly bgTiles: Map<number, Tile>,
  ) {}

  render(ctx: RenderContext, target: RenderTarget): void {
    // Stamp level-wide state onto the ctx once per render pass so tile
    // behaviors can self-select per-cell concerns (e.g. PipeVariants
    // derives its own screen idx from the cell it's drawing onto).
    const levelCtx: RenderContext = {
      ...ctx,
      levelOrientation: this.header.orientation,
      screenPipeVariantIdx: this.screenPipeVariantIdx,
    }
    const toggles = levelCtx.layerToggles.value
    if (toggles.l2) this.l2?.render(levelCtx, target)
    if (toggles.l1) this.renderL1(levelCtx, target, 'nonPriority')
    if (toggles.sprites) {
      for (const sprite of this.sortedSprites()) sprite.render(levelCtx, target)
    }
    if (toggles.l1) this.renderL1(levelCtx, target, 'priority')
  }

  private renderL1(ctx: RenderContext, target: RenderTarget, phase: Phase): void {
    for (let y = 0; y < this.l1.length; y++) {
      const row = this.l1[y]
      if (!row) continue
      for (let x = 0; x < row.length; x++) {
        const id = row[x]
        if (id === null) continue
        const tile = this.l1Tiles.get(id)
        if (!tile) continue
        tile.render(ctx, target, cellBoxOf(x, y), phase)
      }
    }
  }

  private sortedSprites(): Sprite[] {
    const horizontal = this.header.orientation === 'horizontal'
    return [...this.sprites].sort((a, b) => {
      if (horizontal) return a.x - b.x || a.y - b.y
      return a.y - b.y || a.x - b.x
    })
  }
}
