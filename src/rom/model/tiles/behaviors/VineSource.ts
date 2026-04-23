import type { RenderContext } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Vine-source tile behavior.
 *
 * Visually renders as a normal static quad — the "acts-like" semantic is
 * carried by the class itself so callers can identify vine sources via
 * `tile.behavior instanceof VineSource` without reasoning about tile ids.
 * Attached by `TileFactory` when the tile's acts-like value has low byte
 * $2A or $2B, matching the vanilla block-hit dispatch that reaches
 * `GeneratedTiles[3] = CODE_00C077` (vine) via DATA_00F05C[25/26] = $03.
 */
export class VineSource implements TileBehavior {
  constructor(readonly quad: SubtileQuad) {}

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.quad
  }
}
