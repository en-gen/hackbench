// Consumes: (none directly — overlay only)

import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  rgba,
  WALL_ALPHA, WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
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
const JUMP_H      = 69  // Σ(-80+3i)/16 for i=0..26 ≈ 69 px (state-3 / $B0 jump)
const ENDCAP_HALF = 8   // half the sprite body width; endcap spans full 16 px

export class JumpingFishAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
    _behavior:  SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive) return

    const centerX = x + ENDCAP_HALF
    const jumpTop = y - JUMP_H
    const color   = COLORS.tealJump

    ctx.save()

    // Dashed vertical centerline — same vocabulary as $47's jump column.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(centerX, y); ctx.lineTo(centerX, jumpTop)
    ctx.stroke()
    ctx.setLineDash([])

    // Solid apex endcap spanning the full 16 px body width.
    ctx.lineWidth   = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(centerX - ENDCAP_HALF, jumpTop)
    ctx.lineTo(centerX + ENDCAP_HALF, jumpTop)
    ctx.stroke()

    ctx.restore()
  }
}
