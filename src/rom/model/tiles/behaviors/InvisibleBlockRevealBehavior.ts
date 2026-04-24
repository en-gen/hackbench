import type { CellBox, RenderContext, RenderTarget } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Editor-only reveal for tiles that are invisible in Map16 but should
 * be shown as a visible counterpart so designers can see what's there.
 * Canonical case: tile $021 (invisible coin block) is rendered as tile
 * $123 (the visible ? coin block graphic) at a fixed `alpha` (default
 * 0.5), so the designer sees *what kind of block is there* without
 * mistaking it for a solid opaque one.
 *
 * If `rewardOverlayQuad` is provided, a reward indicator is drawn in
 * the pre-pass: 16×16 at offset (0, -8) from the cell's top-left, at a
 * constant 0.5 alpha. Unlike the vine / 1-up / star overlays, this one
 * does NOT flip to full opacity on cursor hover — the invisible block
 * itself is already a faint hint, so keeping the reward indicator
 * uniformly faint avoids a jarring pop when the designer mouses over
 * it. For $021 this is tile $02B (coin).
 *
 * We deliberately don't draw the post-hit form ($132 used block) — that
 * tile is the shared exhausted state for ~18 different block types
 * (coin, item, invisible wings, turn blocks) per DATA_00F0C8
 * (bank_00.asm:12766), so it would conflate distinct block semantics.
 *
 * Unlike `PSwitchRevealBehavior`, there is no reactive state that flips
 * this tile back to full opacity — invisible coin blocks have no editor
 * toggle.
 */
const OVERLAY_OFFSETS = [
  { dx: 0, dy: -8 }, { dx: 8, dy: -8 },
  { dx: 0, dy:  0 }, { dx: 8, dy:  0 },
] as const

export class InvisibleBlockRevealBehavior implements TileBehavior {
  constructor(
    readonly revealedQuad: SubtileQuad,
    readonly rewardOverlayQuad: SubtileQuad | null = null,
    readonly alpha: number = 0.5,
  ) {}

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.revealedQuad
  }

  selectAlpha(_ctx: RenderContext): number {
    return this.alpha
  }

  renderOverlay(ctx: RenderContext, target: RenderTarget, cell: CellBox): void {
    if (!this.rewardOverlayQuad) return
    for (let i = 0; i < 4; i++) {
      const { dx, dy } = OVERLAY_OFFSETS[i]
      this.rewardOverlayQuad[i].render(ctx, target, { x: cell.tl.x + dx, y: cell.tl.y + dy }, 0.5)
    }
  }
}
