import { HopFlameBehavior } from '../behaviors/HopFlameBehavior'
import { solidityFromL1 } from '../MovementBehavior'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  drawApexLine,
  drawBounceArc,
  drawCorridor,
} from '../../overlays/primitives'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $1D Hopping Flame — draws the reachable-area rect computed by
 * `HopFlameBehavior.simulateBounds`. All movement physics and collision
 * decisions live in the behavior (a direct port of the HoppingFlame ASM
 * handler in bank_01.asm:2187). This appearance is just the skin on top:
 * it translates simulated bounds into a translucent orange envelope, a
 * bounce-arc polyline, an apex line, and a highlighted ground row.
 *
 * Because the bounds are derived from `spawnX`/`spawnY` plus the L1
 * acts-like grid (priority-aware solidity), they re-derive automatically
 * when the sprite is moved or the surrounding geometry changes — there is
 * no stored path state.
 *
 * Bug-fix note (user reported "overlay extended into the ground, didn't
 * illustrate jump height"): the behavior's `simulateBounds` now clamps
 * `maxY` to `groundY + 16` so the envelope's bottom edge is the resting
 * row, not the lowest simulation sample. The appearance additionally
 * draws:
 *   - a ground band at the resting row (walk zone),
 *   - an explicit apex line at the envelope top,
 *   - a bounce-arc polyline through the sampled hop path so the jump
 *     height reads visually instead of being implied by the envelope rect.
 */
export class HopFlameAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    getL1:      GetL1Tile,
    levelCols:  number,
    levelRows:  number,
    behavior?:  SpriteBehavior,
  ): void {
    if (!isActive) return
    if (!(behavior instanceof HopFlameBehavior)) return

    const { solidH, solidV } = solidityFromL1(getL1)
    const bounds = behavior.simulateBounds(x, y, solidH, solidV, levelCols, levelRows)
    const path   = behavior.computeBouncePath(x, y, solidH, solidV, levelCols, levelRows)

    const { minX, maxX, minY, maxY, groundY } = bounds

    ctx.save()

    // Envelope + bounce-arc polyline — drawBounceArc stacks the rect + path.
    drawBounceArc(
      ctx,
      { minX, maxX, minY, maxY },
      path,
      COLORS.orangeHop,
    )

    // Ground band: brighter corridor at the resting row for the walk phase.
    drawCorridor(
      ctx,
      minX, maxX,
      groundY, groundY + 16,
      COLORS.orangeGround,
      { solidBottom: true },
    )

    // Apex marker at the top of the envelope (maximum reachable height).
    drawApexLine(ctx, minX, maxX, minY + 0.5, COLORS.orangeGround)

    ctx.restore()
  }
}
