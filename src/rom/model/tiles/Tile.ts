import { NO_COLLISION, type TileCollision } from './TileCollision'
import type { CellBox, Phase, PixelPos, RenderTarget } from '../RenderTarget'
import type { MapStore } from '../stores/mapStore'
import type { SubTile } from './SubTile'
import type { TileBehavior } from './TileBehavior'

export type SubtileQuad = readonly [SubTile, SubTile, SubTile, SubTile]

export class Tile {
  /**
   * @param id         Map16 tile id this tile occupies in the tilemap.
   * @param behavior   Rendering behavior (static, pipe variants, vine source…).
   *                   Dispatched by `TileFactory` from the acts-like value
   *                   so e.g. a page-1 tile that acts-like $2B renders a
   *                   normal quad but carries `VineSourceBehavior` semantics.
   * @param actsLike   Tile id whose game behavior this tile dispatches as.
   *                   Defaults to `id` (identity). Lunar Magic's acts-like
   *                   override lets custom tiles behave as vanilla ones.
   * @param collision  Pre-computed per-direction collision classification —
   *                   horizontal wall / top-stand / bottom-bonk. Pulls from
   *                   the ROM's block-behavior table + acts-like ranges at
   *                   factory time so the overlay predicates don't have to
   *                   re-derive per draw. Defaults to `NO_COLLISION` for
   *                   tiles constructed without classification (test fixtures).
   */
  constructor(
    readonly id: number,
    readonly behavior: TileBehavior,
    readonly actsLike: number = id,
    readonly collision: TileCollision = NO_COLLISION,
  ) {}

  renderOverlay(target: RenderTarget, cell: CellBox, mapStore: MapStore): void {
    this.behavior.renderOverlay?.(target, cell, mapStore)
  }

  render(target: RenderTarget, cell: CellBox, mapStore: MapStore, phase: Phase): void {
    // Pass `cell` through so behaviors can self-select per-cell state
    // (e.g. PipeVariantsBehavior resolves its own screen idx from cell.tl).
    const quad = this.behavior.selectQuad(cell, mapStore)
    const alpha = this.behavior.selectAlpha?.(cell, mapStore)
    const positions: readonly [SubTile, PixelPos][] = [
      [quad[0], cell.tl],
      [quad[1], cell.tr],
      [quad[2], cell.bl],
      [quad[3], cell.br],
    ]
    for (const [sub, pos] of positions) {
      const subPhase: Phase = sub.priority ? 'priority' : 'nonPriority'
      if (subPhase !== phase) continue
      sub.render(target, pos, mapStore.palette, alpha)
    }
  }
}
