import type { RenderContext } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

/**
 * Editor-only reveal for blue-P-switch-gated "hidden" tiles.
 *
 * In the ROM the hidden tiles ($27/$28/$29/$2A) are rendered as blank
 * 16×16 cells until the player stomps a blue P-switch, at which point
 * the game's DMA swaps them to visible door/block/coin tiles. The editor
 * can't ship empty cells — a designer needs to see what's there — so we
 * always render the revealed artwork but fade it to `offAlpha` (default
 * 0.5) when the P-switch is inactive. Tap the toolbar's blue P-switch
 * button to bring the tile up to full opacity.
 *
 * `revealedQuad` is the substitute tile's subtile layout, with any
 * palette override baked in by the factory (silver doors use palette 4
 * instead of their substitute's brown palette 6).
 *
 * Matches legacy editor semantics from `pSwitchReveal(tileId)` +
 * `ctx.globalAlpha = pSwitchBlueOn ? 1.0 : 0.5`.
 */
export class PSwitchReveal implements TileBehavior {
  constructor(
    readonly revealedQuad: SubtileQuad,
    readonly offAlpha: number = 0.5,
  ) {}

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.revealedQuad
  }

  selectAlpha(ctx: RenderContext): number {
    return ctx.pSwitchActive.value ? 1 : this.offAlpha
  }
}
