import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  drawApexLine,
  drawVertLane,
} from '../../overlays/primitives'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $18 Surface Jumping fish — vertical jump zone overlay.
 *
 * Handler: `JumpingFish` (bank_01.asm:6743). Purely vertical movement:
 *   - Three-state jump sequence, Y speeds from DATA_01B1B1 `db $D0,$D0,$B0`:
 *       State 1/2: $D0 = −48 sub-px/frame → apex ≈ 25 px (≈1.6 tiles)
 *       State 3:   $B0 = −80 sub-px/frame → apex ≈ 69 px (≈4.3 tiles)
 *   - Gravity from SubUpdateSprPos: DATA_019030[0] = $03 sub-px/frame².
 *   - No horizontal movement; X stays at spawn.
 *
 * Max apex for the overlay = Σ(−80+3i)/16 for i=0..26 ≈ 69 px (worst-case
 * state-3 jump). The overlay draws a 16-px-wide column with apex line.
 */
const JUMP_H = 69   // Σ(-80+3i)/16 for i=0..26 ≈ 69 px (state-3 / $B0 jump)
const HALF_W = 8    // 16 px body centred on spawn

export class JumpingFishAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:      OverlayContext,
    x:        number,
    y:        number,
    isActive: boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
  ): void {
    if (!isActive) return

    const centerX = x + HALF_W
    const jumpTop = y - JUMP_H

    ctx.save()
    drawVertLane(ctx, centerX, jumpTop, y, HALF_W, COLORS.tealJump)
    drawApexLine(ctx, x, x + 16, jumpTop, COLORS.tealJump)
    ctx.restore()
  }
}
