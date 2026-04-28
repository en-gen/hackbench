import { Char } from '../../chars/Char'
import { PSwitchAlternateBehavior } from '../../chars/behaviors/PSwitchAlternateBehavior'
import type { RenderContext } from '../../RenderTarget'
import { SubTile } from '../SubTile'
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
 * The constructor unwraps any `PSwitchAlternateBehavior` on the
 * substitute's chars to its `normal` branch — the substitute for $2A
 * pulls coin chars whose CharFactory wires altFrames (used-block pixels)
 * for the bank_05.asm:4417-4422 DMA swap. Without unwrapping, "P-switch
 * active" would render the alt (turn-block) pixels at full opacity, the
 * exact bug this behavior is meant to suppress: $2A is its own tile with
 * its own visibility rule (alpha only), independent of the coin-DMA
 * shared by char $2B.
 *
 * Matches legacy editor semantics from `pSwitchReveal(tileId)` +
 * `ctx.globalAlpha = pSwitchBlueOn ? 1.0 : 0.5`.
 */
export class PSwitchRevealBehavior implements TileBehavior {
  readonly revealedQuad: SubtileQuad

  constructor(
    revealedQuad: SubtileQuad,
    readonly offAlpha: number = 0.5,
  ) {
    const tl = stripPSwitchAlt(revealedQuad[0])
    const tr = stripPSwitchAlt(revealedQuad[1])
    const bl = stripPSwitchAlt(revealedQuad[2])
    const br = stripPSwitchAlt(revealedQuad[3])
    // Preserve the input array reference when no subtile needed stripping.
    // Stable identity matters: factory-built quads are shared with sibling
    // tiles (palette-override clones, etc) and consumers may compare by
    // reference for memoization.
    this.revealedQuad =
      tl === revealedQuad[0] && tr === revealedQuad[1] &&
      bl === revealedQuad[2] && br === revealedQuad[3]
        ? revealedQuad
        : [tl, tr, bl, br]
  }

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.revealedQuad
  }

  selectAlpha(ctx: RenderContext): number {
    return ctx.pSwitchActive.value ? 1 : this.offAlpha
  }
}

function stripPSwitchAlt(sub: SubTile): SubTile {
  const beh = sub.char.behavior
  if (!(beh instanceof PSwitchAlternateBehavior)) return sub
  return new SubTile(
    new Char(sub.char.id, beh.normal),
    sub.palette,
    sub.flipX,
    sub.flipY,
    sub.priority,
  )
}
