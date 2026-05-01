// Consumes: (none directly — overlay only)

import type { Char } from '../../chars/Char'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS,
  DASH_ALPHA,
  DASH_LINE_WIDTH,
  DEFAULT_DASH,
  rgba,
  type RGBA,
  WALL_ALPHA,
  WALL_LINE_WIDTH,
} from '../../overlays/primitives'
import type { MapStore } from '../../stores/mapStore'
import { SumoBrotherBehavior } from '../behaviors/SumoBrotherBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $9A (Sumo Brother) — patrol-and-projectile enemy.
 *
 * Custom OAM build via `SumoBroGfx` (bank_02.asm:12456). The handler reads
 * 4 tile slots per pose from `SumoBrosTiles` / `SumoBrosDispX` /
 * `SumoBrosDispY` / `SumoBrosTileSize` (bank_02.asm:12436–12454).
 *
 * Pose 0 (resting/walking idle, `Misc1602 = 0`, left-facing `Misc157C = 1`):
 *   - 8×8  tile $98 at (−1, −8)   ← head left
 *   - 8×8  tile $99 at (+7, −8)   ← head right
 *   - 16×16 tile $A7 at (−4,  0)  ← body left  (4 chars: $A7,$A8,$B7,$B8)
 *   - 16×16 tile $A8 at (+4,  0)  ← body right (4 chars: $A8,$A9,$B8,$B9)
 *
 * Palette/charHigh: SumoBroGfx hard-codes `LDA #$34` then `ADC _2` with
 * carry set for tile != $66. Result `$35` = palette index 2 (CGRAM row
 * 8 + 2 = 10) and `c = 1` (charHigh = $100 within the OBJ tile bank).
 *
 * Overlay vocabulary:
 *   - Dashed horizontal patrol line with solid wall caps at both ends —
 *     Sumo turns around at the extents of its short, fixed-width pace
 *     (`COLORS.patrolPath`, hot pink).
 *   - Dashed vertical lightning-fall line from sprite bottom down to the
 *     first solid floor at SumoX+4 (`COLORS.redWarning`, hostile attack).
 *   - Dashed horizontal fire-spread band on the impact row, spanning the
 *     5 cluster-fire spawn extents (SumoX−32 to SumoX+48). Lightning
 *     stays as fire for 34 frames after hitting the ground while
 *     `Misc1570` indexes 5 cluster-sprite spawns.
 */
export class SumoBrotherAppearance extends StaticSpriteAppearance {
  static fromTables(
    chars: Map<number, Char>,
    placeholder: Char,
  ): SumoBrotherAppearance {
    const OBJ_BASE = 0x400
    const charHigh = 0x100
    const palette  = 10  // CGRAM row 8 + (($34 >> 1) & 0x07) = 8 + 2 = 10

    const part = (
      tile: number, dx: number, dy: number,
    ): SpritePart => ({
      char:    chars.get(OBJ_BASE + charHigh + (tile & 0x1FF)) ?? placeholder,
      palette, flipX: false, flipY: false, dx, dy,
    })

    // SNES 16×16 OBJ: base N → [N, N+1, N+$10, N+$11] at (0,0)/(8,0)/(0,8)/(8,8).
    const bigTile = (baseTile: number, bdx: number, bdy: number): SpritePart[] => [
      part(baseTile + 0x00, bdx,     bdy),
      part(baseTile + 0x01, bdx + 8, bdy),
      part(baseTile + 0x10, bdx,     bdy + 8),
      part(baseTile + 0x11, bdx + 8, bdy + 8),
    ]

    // Pose 0, left-facing (initial pose: 157C toggles to 1 at end of init's
    // state-3 attack window, so first pacing entry walks left).
    const parts: SpritePart[] = [
      part(0x98, -1, -8),     // head L (8×8)
      part(0x99,  7, -8),     // head R (8×8)
      ...bigTile(0xA7, -4, 0), // body L (16×16)
      ...bigTile(0xA8,  4, 0), // body R (16×16) — overlaps body L's right column
                               // with identical chars ($A8/$B8); benign duplication
                               // matches the in-game OAM layout.
    ]
    return new SumoBrotherAppearance(parts)
  }

  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    getL1:      GetL1Tile,
    levelCols:  number,
    levelRows:  number,
    behavior:   SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive || !(behavior instanceof SumoBrotherBehavior)) return

    const patrolColor    = COLORS.patrolPath
    const lightningColor = COLORS.redWarning

    ctx.save()

    // ── Patrol line ──────────────────────────────────────────────
    const { leftX, rightX } = behavior.getPatrolRange(x, levelCols)
    const midY = y + 8

    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(patrolColor, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(leftX,  midY + 0.5)
    ctx.lineTo(rightX, midY + 0.5)
    ctx.stroke()
    ctx.setLineDash([])

    // Solid end caps: direction-flip turn-around markers.
    const capHalf = 4
    ctx.lineWidth   = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(patrolColor, WALL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(leftX  + 0.5, midY - capHalf)
    ctx.lineTo(leftX  + 0.5, midY + capHalf)
    ctx.moveTo(rightX + 0.5, midY - capHalf)
    ctx.lineTo(rightX + 0.5, midY + capHalf)
    ctx.stroke()

    // ── Lightning attack ─────────────────────────────────────────
    const fall = behavior.getLightningFall(x, y, getL1, levelCols, levelRows)

    // Render only when a real floor exists in the lightning's column —
    // a Sumo placed over a pit shouldn't sprout phantom fires at the
    // level bottom.
    if (fall.hasFloor) {
      // Vertical fall path: sprite bottom → impact Y. Suppress when
      // Sumo is standing directly on the floor (zero-distance fall):
      // the lightning lands at his feet, the fire footprints alone
      // communicate the attack.
      if (fall.groundY > fall.fallTopY) {
        ctx.lineWidth   = DASH_LINE_WIDTH
        ctx.strokeStyle = rgba(lightningColor, DASH_ALPHA)
        ctx.setLineDash([...DEFAULT_DASH])
        ctx.beginPath()
        ctx.moveTo(fall.fallX + 0.5, fall.fallTopY)
        ctx.lineTo(fall.fallX + 0.5, fall.groundY - 0.5)
        ctx.stroke()
        ctx.setLineDash([])
      }

      // Fire footprints: 5 semi-transparent flame-shape silhouettes,
      // one per cluster-fire spawn slot (DATA_02DF22 indexed by
      // Misc1570). Each footprint is 16 px wide and bottom-anchored
      // to the local surface Y so it correctly hugs slopes. The flame
      // body is drawn with a wavy top edge so it reads as fire rather
      // than a generic box.
      for (const fx of behavior.getClusterFireXs(x, levelCols)) {
        const cx    = fx + 8
        const surfY = surfaceYAt(fall.surfacePoints, cx) ?? fall.groundY
        drawFlameFootprint(ctx, fx, surfY, lightningColor)
      }
    }

    ctx.restore()
  }
}

/**
 * Draw a single 16-px-wide stylised flame silhouette, bottom-anchored
 * at `surfY` (the local floor height for that fire's X). The shape has
 * a flat base, vertical sides rising ~10 px, then a 3-peak crest with
 * a tall centre lobe and two shorter shoulder lobes — reads as "fire"
 * at SMW's small overlay scale without needing actual sprite pixels.
 *
 * Filled at 50 % alpha so the underlying floor remains legible; outline
 * at higher alpha so the silhouette stays readable on light tiles.
 */
function drawFlameFootprint(
  ctx:   OverlayContext,
  leftX: number,
  surfY: number,
  color: RGBA,
): void {
  const W      = 16
  const H      = 16
  const cx     = leftX + W / 2
  const baseY  = surfY
  const topY   = surfY - H
  const sideY  = topY + 6   // where the flat sides cap and crest begins
  const shldrY = topY + 1   // shoulder peak height
  const dipY   = topY + 4   // dip between peaks

  ctx.beginPath()
  ctx.moveTo(leftX,       baseY)
  ctx.lineTo(leftX,       sideY)
  ctx.lineTo(leftX + 3,   shldrY)   // left shoulder peak
  ctx.lineTo(cx - 1,      dipY)     // dip
  ctx.lineTo(cx,          topY)     // centre peak (tallest)
  ctx.lineTo(cx + 1,      dipY)     // dip
  ctx.lineTo(leftX + W - 3, shldrY) // right shoulder peak
  ctx.lineTo(leftX + W,   sideY)
  ctx.lineTo(leftX + W,   baseY)
  ctx.closePath()

  ctx.fillStyle = rgba(color, 0.5)
  ctx.fill()
  ctx.lineWidth   = 1
  ctx.strokeStyle = rgba(color, 0.85)
  ctx.stroke()
}

/**
 * Linear-interpolate the surface Y at `targetX` from the polyline.
 * Returns `null` if the X is outside the polyline range.
 */
function surfaceYAt(
  points:  ReadonlyArray<readonly [number, number]>,
  targetX: number,
): number | null {
  if (points.length === 0) return null
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1]!
    const [x1, y1] = points[i]!
    if (x0 <= targetX && targetX <= x1 && x1 - x0 <= 16) {
      const t = x1 === x0 ? 0 : (targetX - x0) / (x1 - x0)
      return y0 + (y1 - y0) * t
    }
  }
  return null
}
