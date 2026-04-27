import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  drawSpawnDrop, rgba, WALL_ALPHA, WALL_LINE_WIDTH,
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
 *     turns 90° at the ledge and drops two tiles below the floor.
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

    const BODY_H    = 32   // sprite body height — 2 tiles for koopas
    const HALF_BODY = 16   // 50% sprite height — patrol line offset from floor
    const FALL_HORIZ = 32  // dashed extension past a fall ledge
    const FALL_VERT  = 32  // dashed drop length below the floor
    const last  = bottom.length - 1
    const color = COLORS.patrolPath

    ctx.save()

    // Dashed patrol path — single polyline at sprite midline. Includes the
    // L-fall extension on whichever side `fallSide` is set: the line bends
    // 90° past the ledge and drops below the floor (open bottom — koopa
    // keeps falling past the rendered drop zone).
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()

    if (r.fallSide === 'left') {
      const fallEndX = bottom[0][0] - FALL_HORIZ
      const fallBotY = bottom[0][1] + FALL_VERT
      const midY     = bottom[0][1] - HALF_BODY
      ctx.moveTo(fallEndX, fallBotY)         // bottom of drop (open at this end)
      ctx.lineTo(fallEndX, midY)             // up the far edge to midline
      ctx.lineTo(bottom[0][0], midY)         // across to corridor start
    } else {
      ctx.moveTo(bottom[0][0], bottom[0][1] - HALF_BODY)
    }

    for (let i = 1; i <= last; i++) {
      ctx.lineTo(bottom[i][0], bottom[i][1] - HALF_BODY)
    }

    if (r.fallSide === 'right') {
      const fallEndX = bottom[last][0] + FALL_HORIZ
      const fallBotY = bottom[last][1] + FALL_VERT
      const midY     = bottom[last][1] - HALF_BODY
      ctx.lineTo(fallEndX, midY)             // continue across past ledge
      ctx.lineTo(fallEndX, fallBotY)         // drop down (open bottom)
    }

    ctx.stroke()
    ctx.setLineDash([])

    // Solid vertical line at each turnaround boundary (wall or turnLedge).
    // Drawn full body height so it reads as "sprite stops here".
    if (solidLeft || solidRight) {
      ctx.lineWidth   = WALL_LINE_WIDTH
      ctx.strokeStyle = rgba(color, WALL_ALPHA)
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

    if (r.spawnDropFromY !== undefined) {
      // Find the floor Y at the spawn column's centre pixel for the drop line.
      const spawnPx  = x + 8
      const spawnCol = Math.floor(spawnPx / 16)
      const spawnSlope = getL1(spawnCol, spawnFloorRow)?.collision?.slope
      const spawnFloorY = spawnSlope
        ? spawnFloorRow * 16 + (spawnSlope.heights[spawnPx - spawnCol * 16] & 0x0F)
        : r.bottomY
      drawSpawnDrop(ctx, spawnPx, r.spawnDropFromY, spawnFloorY, color)
    }

    ctx.restore()
  }
}
