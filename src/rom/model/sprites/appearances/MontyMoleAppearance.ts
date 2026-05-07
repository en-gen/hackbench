import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  drawOverlayRect,
} from '../../overlays/primitives'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $4D/$4E Monty Mole (ground / ledge) — horizontal detection-zone overlay.
 *
 * Handler: `MontyMole` → `CODE_01E2E0` (bank_01.asm:13340).
 * State 0 (hiding) activates when Mario's X is within ~96 px:
 *
 *   JSR SubHorizPos           ; _F = low byte of (MarioX − SpriteX)
 *   LDA.B _F
 *   CLC
 *   ADC.B #$60                ; + 96
 *   CMP.B #$C0                ; unsigned compare with 192
 *   BCS CODE_01E305           ; too far → stay hidden
 *
 * The branch is NOT taken for _F in [−96, +95], giving a 192 px detection
 * window (96 px left, 95 px right of the sprite anchor). The overlay shows
 * a 192 px wide horizontal band at the sprite body Y to communicate "mole
 * emerges when Mario enters this column range."
 *
 * $4E-specific: state 1 also calls `JSL GenerateTile` to stamp a mole-hole
 * block at the spawn position (bank_01.asm:13385) before jumping. Both $4D
 * and $4E share the same detection-zone geometry, so one class covers both.
 */
const DETECT_HALF = 96   // px; from ADC #$60 / CMP #$C0 in CODE_01E2E0

export class MontyMoleAppearance extends StaticSpriteAppearance {
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

    // Horizontal detection zone: 192 px wide, 16 px tall at sprite body Y.
    // Centered on sprite anchor X (SpriteXPosLow), matching the ROM check.
    ctx.save()
    drawOverlayRect(ctx, x - DETECT_HALF, y, DETECT_HALF * 2, 16, COLORS.patrolPath)
    ctx.restore()
  }
}
