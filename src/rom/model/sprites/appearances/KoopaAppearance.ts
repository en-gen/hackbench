import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH, FILL_ALPHA,
  drawFallL, drawSpawnDrop, rgba, WALL_ALPHA, WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import { buildSurfacePath, type SurfaceEntry } from '../../SurfacePath'
import { KoopaWalkBehavior } from '../behaviors/KoopaWalkBehavior'
import { solidityFromL1 } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Ground-walking koopa appearance — $04 Green / $05 Red / $06 Blue /
 * $07 Yellow (and future Spr0to13Main family: $0F Goomba, $11 Buzzy
 * Beetle, $13 Spiny).
 *
 * Renders the sprite's pixel parts via `StaticSpriteAppearance` and adds
 * an overlay that shows the walk corridor. The corridor comes from the
 * attached `KoopaWalkBehavior.computePatrolRange` — walls in body rows
 * and (for ledge-turners $05/$06) missing floors bound the patrol
 * region.
 *
 * Walls render as solid boundary lines. Non-turning koopas ($04/$07/$0C)
 * that actually reach a fallLedge (factoring in initial-LEFT direction
 * and wall bounces) get an L-shaped "falls off here" indicator on that
 * side — horizontal band extending past the ledge, then a vertical band
 * dropping down. Only one L ever appears; the first obstacle the koopa
 * reaches settles the outcome.
 *
 * On slope tiles the corridor polygon's bottom (and top) follow the
 * DATA_00E632 height profile — same sample data used by drawSurfaces —
 * so the band visually hugs the terrain instead of clipping through it.
 */
export class KoopaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
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
    behavior?: SpriteBehavior,
  ): void {
    if (!isActive || !(behavior instanceof KoopaWalkBehavior)) return
    const { solidH, solidV } = solidityFromL1(getL1)
    const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows, getL1)
    const solidLeft  = r.leftKind  === 'wall' || r.leftKind  === 'turnLedge'
    const solidRight = r.rightKind === 'wall' || r.rightKind === 'turnLedge'

    // Build the bottom-edge profile from the same SurfacePath the patrol
    // scan uses. Walking outward from sprCol via `nextSurface` follows
    // the connected polyline drawn by "Show surfaces" — at slope corners
    // the polygon hugs the koopa's actual walking surface instead of
    // teleporting up to a parallel slope.
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

    // Per-column floor rows, scanned outward from sprCol via edge-matched
    // surface continuity. If the path runs out before the patrol bound
    // (shouldn't normally happen — bounds come from the same scan), the
    // remaining columns fall back to the last known floor row, leaving
    // the polygon truncated rather than asserting.
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

    const BODY_H = 32  // sprite body height — 2 tiles
    const last   = bottom.length - 1

    ctx.save()

    // Filled body: polygon whose bottom follows terrain and top is 32px above.
    //   top-left → top-right (top profile) → bottom-right → bottom-left (bottom profile) → close
    ctx.fillStyle = rgba(COLORS.greenGround, FILL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(bottom[0][0], bottom[0][1] - BODY_H)
    for (let i = 1; i <= last; i++) ctx.lineTo(bottom[i][0], bottom[i][1] - BODY_H)
    ctx.lineTo(bottom[last][0], bottom[last][1])
    for (let i = last - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1])
    ctx.closePath()
    ctx.fill()

    // Dashed outline around the same polygon.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(COLORS.greenGround, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(bottom[0][0], bottom[0][1] - BODY_H)
    for (let i = 1; i <= last; i++) ctx.lineTo(bottom[i][0], bottom[i][1] - BODY_H)
    ctx.lineTo(bottom[last][0], bottom[last][1])
    for (let i = last - 1; i >= 0; i--) ctx.lineTo(bottom[i][0], bottom[i][1])
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])

    // Solid wall lines on bounded sides (wall or turnLedge).
    if (solidLeft || solidRight) {
      ctx.lineWidth   = WALL_LINE_WIDTH
      ctx.strokeStyle = rgba(COLORS.greenGround, WALL_ALPHA)
      ctx.beginPath()
      if (solidLeft) {
        ctx.moveTo(bottom[0][0], bottom[0][1] - BODY_H)
        ctx.lineTo(bottom[0][0], bottom[0][1])
      }
      if (solidRight) {
        ctx.moveTo(bottom[last][0], bottom[last][1] - BODY_H)
        ctx.lineTo(bottom[last][0], bottom[last][1])
      }
      ctx.stroke()
    }

    const leftTopY  = bottom[0][1]    - BODY_H
    const rightTopY = bottom[last][1] - BODY_H
    if (r.fallSide === 'left') {
      drawFallL(ctx, r.leftX,  leftTopY,  bottom[0][1],    -1, COLORS.greenGround)
    } else if (r.fallSide === 'right') {
      drawFallL(ctx, r.rightX, rightTopY, bottom[last][1], +1, COLORS.greenGround)
    }

    if (r.spawnDropFromY !== undefined) {
      // Find the floor Y at the spawn column's centre pixel for the drop line.
      const spawnPx  = x + 8
      const spawnCol = Math.floor(spawnPx / 16)
      const spawnSlope = getL1(spawnCol, spawnFloorRow)?.collision?.slope
      const spawnFloorY = spawnSlope
        ? spawnFloorRow * 16 + (spawnSlope.heights[spawnPx - spawnCol * 16] & 0x0F)
        : r.bottomY
      drawSpawnDrop(ctx, spawnPx, r.spawnDropFromY, spawnFloorY, COLORS.greenGround)
    }

    ctx.restore()
  }
}
