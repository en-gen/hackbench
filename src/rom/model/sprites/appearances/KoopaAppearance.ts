import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  drawArrowHead, drawSpawnDrop, rgba, WALL_ALPHA, WALL_LINE_WIDTH,
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
 * a movement overlay derived from `KoopaWalkBehavior.computePatrolRange`.
 *
 * Overlay vocabulary (shared across all patrol-style sprites):
 *   - **Dashed centerline** at 50% sprite height tracks where the koopa
 *     walks. The line follows terrain — slopes shift it column-by-column.
 *   - **Solid vertical** at left/right boundary indicates the koopa
 *     turns around there (wall or turnLedge — `solidLeft`/`solidRight`).
 *   - **Dashed L-extension** past a fallLedge (only one side, decided by
 *     `fallSide`) shows the koopa walks off and falls. The dashed line
 *     turns 90° at the ledge and drops one tile below the floor into the pit.
 *   - **Toward-Mario clipping**: non-turning sprites (fall-off walkers like
 *     $04, $07, $0F) show only the corridor arm from spawn toward Mario when
 *     `marioSpawnX` is available. Both arms are shown for turning sprites.
 *   - **Spawn drop**: dotted vertical line if the sprite spawns airborne.
 *
 * Color is `COLORS.patrolPath` — same lime accent every patrol-style
 * sprite uses, so the visual vocabulary is consistent across koopas,
 * super koopas, sinusoidal para-koopas, etc.
 */
export class KoopaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:          OverlayContext,
    x:            number,
    y:            number,
    isActive:     boolean,
    getL1:        GetL1Tile,
    levelCols:    number,
    levelRows:    number,
    behavior?:    SpriteBehavior,
    marioSpawnX?: number,
  ): void {
    if (!isActive || !(behavior instanceof KoopaWalkBehavior)) return
    const { solidH, solidV } = solidityFromL1(getL1)
    const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows, getL1)
    const { solidLeft, solidRight } = r

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

    const BODY_H     = behavior.tall ? 32 : 16  // 2 tiles for koopas, 1 tile for goombas
    const HALF_BODY  = BODY_H / 2              // patrol centerline offset from floor
    const FALL_HORIZ = HALF_BODY               // L-arm horizontal = same as centerline height
    const FALL_DEPTH = 16                      // extra drop below floor into the pit
    const last  = bottom.length - 1
    const color = COLORS.patrolPath

    // Non-turning sprites (fall-off walkers) show only the toward-Mario arm
    // of the patrol corridor when marioSpawnX is known AND the toward-Mario
    // terminus is an open fall (no wall to bounce off). If the toward-Mario
    // side ends at a wall the sprite will flip and patrol back the other way,
    // so both arms are shown. Both arms are always shown for turning sprites
    // (perpetual patrol) or when Mario's position is unavailable.
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

    // Dashed patrol path — single polyline at sprite midline. Includes the
    // L-fall extension on whichever side `fallSide` is visible: the line
    // bends 90° past the ledge and drops one tile below the floor level
    // (open bottom — sprite keeps falling past the rendered drop zone).
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()

    if (showLeftFall) {
      const fallEndX = bottom[0][0] - FALL_HORIZ
      const midY     = bottom[0][1] - HALF_BODY
      const fallBotY = bottom[0][1] + FALL_DEPTH  // one tile below floor into the pit
      ctx.moveTo(fallEndX, fallBotY)               // bottom of drop (open at this end)
      ctx.lineTo(fallEndX, midY)                   // up the far edge to midline
      ctx.lineTo(bottom[startIdx][0], midY)        // across to corridor start
    } else {
      ctx.moveTo(bottom[startIdx][0], bottom[startIdx][1] - HALF_BODY)
    }

    for (let i = startIdx + 1; i <= endIdx; i++) {
      ctx.lineTo(bottom[i][0], bottom[i][1] - HALF_BODY)
    }

    if (showRightFall) {
      const fallEndX = bottom[last][0] + FALL_HORIZ
      const midY     = bottom[last][1] - HALF_BODY
      const fallBotY = bottom[last][1] + FALL_DEPTH  // one tile below floor into the pit
      ctx.lineTo(fallEndX, midY)                      // continue across past ledge
      ctx.lineTo(fallEndX, fallBotY)                  // drop down into the pit
    }

    ctx.stroke()
    ctx.setLineDash([])

    // Downward arrowhead at the open bottom of each L-fall drop zone,
    // indicating the koopa continues falling past the drawn range.
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

    // Solid vertical line at each visible turnaround boundary (wall or turnLedge).
    // Drawn full body height so it reads as "sprite stops here".
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
      // Find the floor Y at the spawn column's centre pixel for the drop line.
      const spawnPx  = x + 8
      const spawnCol = Math.floor(spawnPx / 16)
      // Priority-1 cells pass through sprite collision — they should not
      // contribute slope-snap data to the spawn-drop line.
      const spawnCell  = getL1(spawnCol, spawnFloorRow)
      const spawnSlope = spawnCell && !spawnCell.isPriority
        ? spawnCell.collision?.slope
        : undefined
      const spawnFloorY = spawnSlope
        ? spawnFloorRow * 16 + (spawnSlope.heights[spawnPx - spawnCol * 16] & 0x0F)
        : r.bottomY
      drawSpawnDrop(ctx, spawnPx, r.spawnDropFromY, spawnFloorY, color)
    }

    ctx.restore()
  }
}
