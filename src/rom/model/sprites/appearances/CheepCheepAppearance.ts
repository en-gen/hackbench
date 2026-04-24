import { isActsLikeHorizSolid, isActsLikeVertSolid, type GetL1Tile, type OverlayContext } from '../../OverlayContext'
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
 * Serializes transparently as `{kind:'static'}` — no extra payload needed
 * since the sprite ID in the descriptor drives class selection on rehydration.
 */
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
    ctx.save()
    if (!this.vertical) {
      // Horizontal: scan left and right at the fish's centre row.
      const sprRow = Math.floor((y + 8) / 16)
      const sprCol = Math.floor((x + 8) / 16)
      const solidH = (c: number, r: number): boolean => {
        const cell = getL1(c, r)
        return cell !== null && !cell.isPriority && isActsLikeHorizSolid(cell.actsLike)
      }
      let leftX  = 0
      for (let c = sprCol - 1; c >= 0; c--) {
        if (solidH(c, sprRow)) { leftX = (c + 1) * 16; break }
      }
      let rightX = levelCols * 16
      for (let c = sprCol + 1; c < levelCols; c++) {
        if (solidH(c, sprRow)) { rightX = c * 16; break }
      }
      ctx.fillStyle = 'rgba(0,160,220,0.15)'
      ctx.fillRect(leftX, y, rightX - leftX, 16)
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = 'rgba(0,180,240,0.55)'
      ctx.strokeRect(leftX + 0.5, y + 0.5, rightX - leftX - 1, 15)
      ctx.setLineDash([])
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(0,180,240,0.90)'
      ctx.beginPath()
      ctx.moveTo(leftX,  y); ctx.lineTo(leftX,  y + 16)
      ctx.moveTo(rightX, y); ctx.lineTo(rightX, y + 16)
      ctx.stroke()
    } else {
      // Vertical: scan up and down at the fish's centre column.
      const sprCol = Math.floor((x + 8) / 16)
      const sprRow = Math.floor((y + 8) / 16)
      const solidV = (c: number, r: number): boolean => {
        const cell = getL1(c, r)
        return cell !== null && !cell.isPriority && isActsLikeVertSolid(cell.actsLike)
      }
      let topY    = 0
      for (let r = sprRow - 1; r >= 0; r--) {
        if (solidV(sprCol, r)) { topY = (r + 1) * 16; break }
      }
      let bottomY = levelRows * 16
      for (let r = sprRow + 1; r < levelRows; r++) {
        if (solidV(sprCol, r)) { bottomY = r * 16; break }
      }
      ctx.fillStyle = 'rgba(0,160,220,0.15)'
      ctx.fillRect(x, topY, 16, bottomY - topY)
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.strokeStyle = 'rgba(0,180,240,0.55)'
      ctx.strokeRect(x + 0.5, topY + 0.5, 15, bottomY - topY - 1)
      ctx.setLineDash([])
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(0,180,240,0.90)'
      ctx.beginPath()
      ctx.moveTo(x, topY);    ctx.lineTo(x + 16, topY)
      ctx.moveTo(x, bottomY); ctx.lineTo(x + 16, bottomY)
      ctx.stroke()
    }
    ctx.restore()
  }
}
