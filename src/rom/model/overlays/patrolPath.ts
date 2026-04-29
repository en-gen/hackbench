import type { GetL1Tile, OverlayContext } from '../OverlayContext'
import { buildSurfacePath, type SurfaceEntry } from '../SurfacePath'
import { KoopaWalkBehavior } from '../sprites/behaviors/KoopaWalkBehavior'
import { solidityFromL1 } from '../sprites/MovementBehavior'
import { spriteCollisionFromL1 } from '../sprites/SpriteCollision'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  drawArrowHead, drawSpawnDrop, rgba, WALL_ALPHA, WALL_LINE_WIDTH,
} from './primitives'

/**
 * Shared patrol-corridor overlay for any ground-walking sprite that uses
 * `KoopaWalkBehavior` — Koopa family ($04–$07/$0C/$0F) and Dry Bones
 * ($30/$32).
 *
 * Draws a dashed midline that follows the terrain, solid wall markers at
 * stopping boundaries, an L-fall extension on the side the sprite falls off
 * (when applicable), and a spawn-drop dotted line when the sprite is placed
 * above its patrol floor.
 */
export function drawPatrolPath(
  ctx:          OverlayContext,
  behavior:     KoopaWalkBehavior,
  x:            number,
  y:            number,
  getL1:        GetL1Tile,
  levelCols:    number,
  levelRows:    number,
  marioSpawnX?: number,
): void {
  const { solidH, solidV } = solidityFromL1(getL1)
  const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows, getL1)
  const { solidLeft, solidRight } = r

  const spawnFloorRow = Math.floor(r.bottomY / 16)
  const colStart      = Math.floor(r.leftX   / 16)
  const colEnd        = Math.ceil (r.rightX  / 16)
  const sprCol        = Math.max(colStart, Math.min(colEnd - 1, Math.floor(x / 16)))

  const path = buildSurfacePath(getL1, levelCols, levelRows)
  let spawnSurf: SurfaceEntry | null = null
  for (const s of path.surfacesAt(sprCol)) {
    if (s.yMid >= r.bottomY) { spawnSurf = s; break }
  }
  if (!spawnSurf) {
    spawnSurf = { yLeft: r.bottomY, yRight: r.bottomY, yMid: r.bottomY, floorRow: spawnFloorRow }
  }

  const colFloorRow = new Int32Array(colEnd - colStart).fill(spawnSurf.floorRow)
  let prev = spawnSurf
  for (let c = sprCol + 1; c < colEnd; c++) {
    const next = path.nextSurface(c, prev.yRight, +1)
    if (next === null) break
    colFloorRow[c - colStart] = next.floorRow
    prev = next
  }
  prev = spawnSurf
  for (let c = sprCol - 1; c >= colStart; c--) {
    const next = path.nextSurface(c, prev.yLeft, -1)
    if (next === null) break
    colFloorRow[c - colStart] = next.floorRow
    prev = next
  }

  const bottom: Array<[number, number]> = []
  for (let c = colStart; c < colEnd; c++) {
    const tileX   = c * 16
    const cellRow = colFloorRow[c - colStart]
    const cell    = getL1(c, cellRow)
    const slope   = cell?.collision?.slope
    const tileTopY = cellRow * 16
    if (slope) {
      for (let px = 0; px < 16; px++) {
        bottom.push([tileX + px, tileTopY + (slope.heights[px] & 0x0F)])
      }
      bottom.push([tileX + 16, tileTopY + (slope.heights[15] & 0x0F)])
    } else {
      bottom.push([tileX,      tileTopY])
      bottom.push([tileX + 16, tileTopY])
    }
  }
  if (bottom.length < 2) return

  const BODY_H     = behavior.tall ? 32 : 16
  const HALF_BODY  = BODY_H / 2
  const FALL_HORIZ = HALF_BODY
  const FALL_DEPTH = 16
  const last  = bottom.length - 1
  const color = COLORS.patrolPath

  let startIdx = 0, endIdx = last
  if (!behavior.turnsAtLedges && marioSpawnX !== undefined) {
    const towardLeft = marioSpawnX < x + 8
    const towardMarioWalled = towardLeft ? solidLeft : solidRight
    if (!towardMarioWalled) {
      const sprColPx = sprCol * 16
      let pivotIdx = bottom.findIndex(([bx]) => bx >= sprColPx)
      if (pivotIdx < 0) pivotIdx = last
      if (towardLeft) endIdx   = pivotIdx
      else            startIdx = pivotIdx
    }
  }

  const showLeftFall  = r.fallSide === 'left'  && startIdx === 0
  const showRightFall = r.fallSide === 'right' && endIdx   === last

  ctx.save()

  ctx.lineWidth   = DASH_LINE_WIDTH
  ctx.strokeStyle = rgba(color, DASH_ALPHA)
  ctx.setLineDash([...DEFAULT_DASH])
  ctx.beginPath()

  if (showLeftFall) {
    const fallEndX = bottom[0][0] - FALL_HORIZ
    const midY     = bottom[0][1] - HALF_BODY
    const fallBotY = bottom[0][1] + FALL_DEPTH
    ctx.moveTo(fallEndX, fallBotY)
    ctx.lineTo(fallEndX, midY)
    ctx.lineTo(bottom[startIdx][0], midY)
  } else {
    ctx.moveTo(bottom[startIdx][0], bottom[startIdx][1] - HALF_BODY)
  }

  for (let i = startIdx + 1; i <= endIdx; i++) {
    ctx.lineTo(bottom[i][0], bottom[i][1] - HALF_BODY)
  }

  if (showRightFall) {
    const fallEndX = bottom[last][0] + FALL_HORIZ
    const midY     = bottom[last][1] - HALF_BODY
    const fallBotY = bottom[last][1] + FALL_DEPTH
    ctx.lineTo(fallEndX, midY)
    ctx.lineTo(fallEndX, fallBotY)
  }

  ctx.stroke()
  ctx.setLineDash([])

  if (showLeftFall) {
    const fallEndX = bottom[0][0] - FALL_HORIZ
    const fallBotY = bottom[0][1] + FALL_DEPTH
    drawArrowHead(ctx, fallEndX, fallBotY, fallEndX, fallBotY - FALL_DEPTH, color, DASH_ALPHA)
  }
  if (showRightFall) {
    const fallEndX = bottom[last][0] + FALL_HORIZ
    const fallBotY = bottom[last][1] + FALL_DEPTH
    drawArrowHead(ctx, fallEndX, fallBotY, fallEndX, fallBotY - FALL_DEPTH, color, DASH_ALPHA)
  }

  if ((solidLeft && startIdx === 0) || (solidRight && endIdx === last)) {
    ctx.lineWidth   = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    if (solidLeft && startIdx === 0) {
      ctx.moveTo(bottom[0][0], bottom[0][1] - BODY_H)
      ctx.lineTo(bottom[0][0], bottom[0][1])
    }
    if (solidRight && endIdx === last) {
      ctx.moveTo(bottom[last][0], bottom[last][1] - BODY_H)
      ctx.lineTo(bottom[last][0], bottom[last][1])
    }
    ctx.stroke()
  }

  if (r.spawnDropFromY !== undefined) {
    const spawnPx  = x + 8
    const spawnCol = Math.floor(spawnPx / 16)
    const spawnSlope  = spriteCollisionFromL1(getL1).slopeAt(spawnCol, spawnFloorRow)
    const spawnFloorY = spawnSlope
      ? spawnFloorRow * 16 + (spawnSlope.heights[spawnPx - spawnCol * 16]! & 0x0F)
      : r.bottomY
    drawSpawnDrop(ctx, spawnPx, r.spawnDropFromY, spawnFloorY, color)
  }

  ctx.restore()
}
