import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import { solidityFromL1 } from '../MovementBehavior'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  rgba, WALL_ALPHA, WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $15 (horizontal) and $16 (vertical) Cheep-Cheep swim-corridor overlay.
 *
 * Movement from `Fish` + `CODE_01B0A7` (bank_01.asm:6555/6606):
 *   $15 — SpriteMisc151C=0 → X speed ±8 sub-px/frame (±0.5 px/frame), Y=0.
 *     Bounces on `SpriteBlockedDirs & $03` (left/right walls).
 *   $16 — SpriteMisc151C=1 → X=0, Y speed ±8 sub-px/frame.
 *     Bounces on `SpriteBlockedDirs & $0C` (top/bottom walls).
 *
 * Overlay vocabulary — same as the koopa-walk and sinusoidal-koopa
 * patrols: dashed centerline along the swim axis, solid endcap stubs
 * perpendicular to the axis at each reversal point. `COLORS.patrolPath`
 * keeps the lime-green accent consistent across all back-and-forth
 * patrol overlays.
 *
 * Serializes transparently as `{kind:'static'}` — no extra payload needed
 * since the sprite ID in the descriptor drives class selection on rehydration.
 */
const ENDCAP_HALF = 8  // half body — endcap = sprite-sized stub

export class CheepCheepAppearance extends StaticSpriteAppearance {
  constructor(
    parts: SpritePart[],
    /** true for $16 (vertical movement), false for $15 (horizontal). */
    readonly vertical: boolean,
  ) {
    super(parts)
  }

  override renderOverlay(
    ctx:       OverlayContext,
    x:         number,
    y:         number,
    isActive:  boolean,
    getL1:     GetL1Tile,
    levelCols: number,
    levelRows: number,
  ): void {
    if (!isActive) return
    const color = COLORS.patrolPath
    const centerX = x + 8, centerY = y + 8
    // Use the canonical sprite-collision predicates (priority-filtered,
    // ROM-port range checks via `cell.collision`) so the corridor stops at
    // the same tiles the runtime collision routines treat as solid —
    // including the `$D8+` "solid from above" walls used in underwater
    // stages, which `isActsLikeVertSolid` doesn't recognise.
    const { solidH, solidV } = solidityFromL1(getL1)

    if (!this.vertical) {
      // Horizontal: scan left and right at the fish's centre row.
      const sprRow = Math.floor(centerY / 16)
      const sprCol = Math.floor(centerX / 16)
      let leftX  = 0
      for (let c = sprCol - 1; c >= 0; c--) {
        if (solidH(c, sprRow)) { leftX = (c + 1) * 16; break }
      }
      let rightX = levelCols * 16
      for (let c = sprCol + 1; c < levelCols; c++) {
        if (solidH(c, sprRow)) { rightX = c * 16; break }
      }
      ctx.save()
      ctx.lineWidth   = DASH_LINE_WIDTH
      ctx.strokeStyle = rgba(color, DASH_ALPHA)
      ctx.setLineDash([...DEFAULT_DASH])
      ctx.beginPath()
      ctx.moveTo(leftX,  centerY)
      ctx.lineTo(rightX, centerY)
      ctx.stroke()
      ctx.setLineDash([])
      // Vertical endcap stubs at the wall boundaries.
      ctx.lineWidth   = WALL_LINE_WIDTH
      ctx.strokeStyle = rgba(color, WALL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(leftX,  centerY - ENDCAP_HALF); ctx.lineTo(leftX,  centerY + ENDCAP_HALF)
      ctx.moveTo(rightX, centerY - ENDCAP_HALF); ctx.lineTo(rightX, centerY + ENDCAP_HALF)
      ctx.stroke()
      ctx.restore()
    } else {
      // Vertical: scan up and down at the fish's centre column.
      const sprCol = Math.floor(centerX / 16)
      const sprRow = Math.floor(centerY / 16)
      let topY    = 0
      for (let r = sprRow - 1; r >= 0; r--) {
        if (solidV(sprCol, r)) { topY = (r + 1) * 16; break }
      }
      let bottomY = levelRows * 16
      for (let r = sprRow + 1; r < levelRows; r++) {
        if (solidV(sprCol, r)) { bottomY = r * 16; break }
      }
      ctx.save()
      ctx.lineWidth   = DASH_LINE_WIDTH
      ctx.strokeStyle = rgba(color, DASH_ALPHA)
      ctx.setLineDash([...DEFAULT_DASH])
      ctx.beginPath()
      ctx.moveTo(centerX, topY)
      ctx.lineTo(centerX, bottomY)
      ctx.stroke()
      ctx.setLineDash([])
      // Horizontal endcap stubs at the wall boundaries.
      ctx.lineWidth   = WALL_LINE_WIDTH
      ctx.strokeStyle = rgba(color, WALL_ALPHA)
      ctx.beginPath()
      ctx.moveTo(centerX - ENDCAP_HALF, topY);    ctx.lineTo(centerX + ENDCAP_HALF, topY)
      ctx.moveTo(centerX - ENDCAP_HALF, bottomY); ctx.lineTo(centerX + ENDCAP_HALF, bottomY)
      ctx.stroke()
      ctx.restore()
    }
  }
}
