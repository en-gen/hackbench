import type { CellBox, Phase, PixelPos, RenderContext, RenderTarget } from '../RenderTarget'
import type { SubTile } from './SubTile'
import type { TileBehavior } from './TileBehavior'

export type SubtileQuad = readonly [SubTile, SubTile, SubTile, SubTile]

export class Tile {
  constructor(readonly id: number, readonly behavior: TileBehavior) {}

  render(ctx: RenderContext, target: RenderTarget, cell: CellBox, phase: Phase): void {
    // Pass `cell` through so behaviors can self-select per-cell state
    // (e.g. PipeVariants resolves its own screen idx from cell.tl).
    const quad = this.behavior.selectQuad(ctx, cell)
    const alpha = this.behavior.selectAlpha?.(ctx, cell)
    const positions: readonly [SubTile, PixelPos][] = [
      [quad[0], cell.tl],
      [quad[1], cell.tr],
      [quad[2], cell.bl],
      [quad[3], cell.br],
    ]
    for (const [sub, pos] of positions) {
      const subPhase: Phase = sub.priority ? 'priority' : 'nonPriority'
      if (subPhase !== phase) continue
      sub.render(ctx, target, pos, alpha)
    }
  }
}
