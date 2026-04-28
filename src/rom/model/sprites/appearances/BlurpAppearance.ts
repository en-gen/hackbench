import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  drawArrowHead, rgba,
} from '../../overlays/primitives'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'
import { BLURP_FADE_LENGTH_PX } from '../behaviors/BlurpBehavior'

/**
 * $C2 Blurp — appearance + swim-path overlay.
 *
 * Renders the static sprite parts via `StaticSpriteAppearance`, plus a
 * dashed horizontal swim line in the FaceMario-determined direction
 * with a chevron arrowhead at the far end. The fish swims off-screen
 * indefinitely so the line just runs to `BLURP_FADE_LENGTH_PX` from
 * spawn.
 *
 * Y-amplitude apex stubs are intentionally omitted — the ±4 px triangle
 * wave is small enough relative to the sprite body that the dashed
 * centerline reads cleanly on its own.
 */

export class BlurpAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:          OverlayContext,
    x:            number,
    y:            number,
    isActive:     boolean,
    _getL1:       GetL1Tile,
    _levelCols:   number,
    _levelRows:   number,
    _behavior?:   unknown,
    marioSpawnX?: number,
  ): void {
    if (!isActive) return
    const color   = COLORS.patrolPath
    const centerX = x + 8
    const centerY = y + 8
    // Direction toward Mario at spawn (FaceMario init at bank_01.asm:847).
    // marioSpawnX defaults to 0 — for typical horizontal levels Mario
    // enters at the left, so any sprite past column 0 swims left.
    const mx       = marioSpawnX ?? 0
    const swimDir  = centerX > mx ? -1 : +1
    const farX     = centerX + swimDir * BLURP_FADE_LENGTH_PX

    ctx.save()

    // Dashed centerline.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(centerX, centerY)
    ctx.lineTo(farX,    centerY)
    ctx.stroke()
    ctx.setLineDash([])

    // Arrowhead at the far end.
    drawArrowHead(ctx, farX, centerY, centerX, centerY, color, DASH_ALPHA)

    ctx.restore()
  }
}
