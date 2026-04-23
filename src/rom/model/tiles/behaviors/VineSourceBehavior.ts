import type { CellBox, RenderContext, RenderTarget } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Vine-source tile behavior.
 *
 * Visually renders as a normal static quad — the "acts-like" semantic is
 * carried by the class itself so callers can identify vine sources via
 * `tile.behavior instanceof VineSourceBehavior` without reasoning about tile ids.
 * Attached by `TileFactory` when the tile's acts-like value has low byte
 * $2A or $2B, matching the vanilla block-hit dispatch that reaches
 * `GeneratedTiles[3] = CODE_00C077` (vine) via DATA_00F05C[25/26] = $03.
 *
 * If `overlayQuad` is provided (tile $006's quad), a semi-transparent vine
 * icon is drawn above the block in the pre-pass `renderOverlay`, so the tile's
 * own pixels cover the icon's lower half — giving a "peek from behind" effect.
 */
export class VineSourceBehavior implements TileBehavior {
  constructor(
    readonly quad: SubtileQuad,
    readonly overlayQuad: SubtileQuad | null = null,
  ) {}

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.quad
  }

  renderOverlay(ctx: RenderContext, target: RenderTarget, cell: CellBox): void {
    if (!this.overlayQuad) return
    const cursor = ctx.cursorPx?.value
    const hovered = cursor !== null && cursor !== undefined
      && cursor.x >= cell.tl.x && cursor.x < cell.tl.x + 16
      && cursor.y >= cell.tl.y && cursor.y < cell.tl.y + 16
    const alpha = hovered ? 1.0 : 0.5
    const offsets = [
      { dx: 0, dy: -8 }, { dx: 8, dy: -8 },
      { dx: 0, dy:  0 }, { dx: 8, dy:  0 },
    ] as const
    for (let i = 0; i < 4; i++) {
      this.overlayQuad[i].render(ctx, target, { x: cell.tl.x + offsets[i].dx, y: cell.tl.y + offsets[i].dy }, alpha)
    }
  }
}
