// Consumes: (none)

import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import {
  COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH,
  WALL_ALPHA, WALL_LINE_WIDTH, rgba,
} from '../../overlays/primitives'
import type { MapStore } from '../../stores/mapStore'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $B7/$B8 Carrot Top lift — L-shaped diagonal platform with path overlay.
 *
 * CarrotTopLift (bank_03.asm:1535) oscillates along a diagonal axis.
 * SpriteMisc1540 counts down from $80 = 128 frames per phase; at zero the
 * phase (SpriteTableC2 & 3) increments. SubSprYPosNoGrvty (bank_01.asm:5927)
 * multiplies speed by 16 into the subpixel accumulator, which yields 0.5 px
 * net per frame — giving 64 px of travel per phase direction.
 *
 * $B7: YSpeed = −XSpeed (bank_03.asm:1554); spawn is the top-right end of
 *   the path, the far end is 64 px left and 64 px down.
 * $B8: YSpeed = +XSpeed (EQ branch, bank_03.asm:1556); spawn is the
 *   bottom-right end, the far end is 64 px left and 64 px up.
 */

const TRAVEL_PX = 64
const CAP_HALF  = 8  // half-extent of each reversal end-cap, in pixels

export class CarrotTopLiftAppearance extends StaticSpriteAppearance {
  private readonly spriteId: 0xB7 | 0xB8

  constructor(parts: SpritePart[], spriteId: 0xB7 | 0xB8) {
    super(parts)
    this.spriteId = spriteId
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

    const color = COLORS.patrolPath

    // End-cap positions are pinned to the sprite's actual visual corners so
    // the path spans the full positional extent, not just the anchor center.
    //
    // Both diagonals are exactly 45°, so each X offset maps 1:1 to a Y offset
    // along the movement axis — the corner coordinates fall exactly on the line.
    //
    // $B7 (−1,+1)/√2: spawn is top-right end.
    //   Right cap: top-right corner of spawn sprite   → (x+32, y+0)
    //   Left  cap: bottom-left corner of far sprite   → (x−64, y+96)
    //   Verify: (x+32)+(y+0) == (x−64)+(y+96) == x+y+32 ✓
    //
    // $B8 (−1,−1)/√2: spawn is bottom-right end.
    //   Right cap: bottom-right corner of spawn sprite → (x+32, y+32)
    //   Left  cap: top-left corner of far sprite       → (x−64, y−64)
    //   Verify: (x+32)−(y+32) == (x−64)−(y−64) == x−y ✓
    let spawnX: number, spawnY: number, farX: number, farY: number
    if (this.spriteId === 0xB7) {
      spawnX = x + 32;             spawnY = y +  0              // top-right corner of spawn
      farX   = x - TRAVEL_PX;     farY   = y + TRAVEL_PX + 32  // bottom-left corner of far position
    } else {
      spawnX = x + 32;             spawnY = y + 32              // bottom-right corner of spawn
      farX   = x - TRAVEL_PX;     farY   = y - TRAVEL_PX       // top-left corner of far position
    }

    // Perpendicular unit vector (rotated 90° CCW from movement axis).
    const dx  = farX - spawnX
    const dy  = farY - spawnY
    const len = Math.sqrt(dx * dx + dy * dy)
    const px  = -dy / len
    const py  =  dx / len

    ctx.save()

    // Dashed path line from spawn corner to far corner.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(spawnX, spawnY)
    ctx.lineTo(farX,   farY)
    ctx.stroke()
    ctx.setLineDash([])

    // Solid end-cap lines perpendicular to the path at each reversal point.
    ctx.lineWidth   = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    ctx.moveTo(spawnX + CAP_HALF * px, spawnY + CAP_HALF * py)
    ctx.lineTo(spawnX - CAP_HALF * px, spawnY - CAP_HALF * py)
    ctx.moveTo(farX   + CAP_HALF * px, farY   + CAP_HALF * py)
    ctx.lineTo(farX   - CAP_HALF * px, farY   - CAP_HALF * py)
    ctx.stroke()

    ctx.restore()
  }
}
