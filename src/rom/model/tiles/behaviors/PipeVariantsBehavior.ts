import type { CellBox, RenderContext } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Picks one of 4 palette variants for pipe tiles ($133-$13A) based on
 * which screen the tile sits on. Matches MAP16AppTable
 * (bank_05.asm:60-64):
 *   0 = grey    (palette 3)
 *   1 = green   (palette 5)
 *   2 = yellow  (palette 6)
 *   3 = blue    (palette 7)
 *
 * The per-screen variant table + level orientation come from the
 * reactive context; the cell's own position gives the screen index.
 * Falls back to variant 0 when either context field is missing so the
 * behavior still renders something sensible in isolated previews
 * (e.g. the Map16 viewer where "which screen" isn't meaningful).
 */
export class PipeVariantsBehavior implements TileBehavior {
  constructor(readonly variants: readonly SubtileQuad[]) {}

  selectQuad(ctx: RenderContext, cell: CellBox): SubtileQuad {
    const table = ctx.screenPipeVariantIdx
    if (!table || table.length === 0) return this.variants[0]
    const tileCol = Math.floor(cell.tl.x / 16)
    const tileRow = Math.floor(cell.tl.y / 16)
    const screenIdx = ctx.levelOrientation === 'vertical'
      ? Math.floor(tileRow / 16)
      : Math.floor(tileCol / 16)
    const variant = table[screenIdx] ?? 0
    return this.variants[variant] ?? this.variants[0]
  }
}
