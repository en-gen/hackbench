import type { GetL1Tile } from '../../OverlayContext'
import { MovementBehavior, type BehaviorMeta, type SolidH, type SolidV } from '../MovementBehavior'
import { spriteCollisionFromL1 } from '../SpriteCollision'
import {
  applyXSpeed,
  applyYSpeed,
  BOUNCE_XSPEED,
  type BouncingState,
} from './BouncingKoopaBehavior'
import { applyGravity, signed8 } from './simulate'

/**
 * $10 WingedGoomba - `WingedGoomba` handler at bank_01.asm:1934.
 *
 * Physics (unlocked path, bank_01.asm:1941-1988):
 *   - CODE_018DBB sets vx from Spr0to13SpeedX[dir] → ±$08, same as $09.
 *   - SubUpdateSprPos + DEC SpriteYSpeed,X → net +2/frame gravity.
 *   - On landing (`IsOnGround`):
 *       - INC SpriteMisc151C (bounce counter 1→2→3→4→reset).
 *       - Counter 1/2/3: vy = $F0 (-16) - short bounce.
 *       - Counter 4: vy = $D0 (-48) - tall bounce, then counter resets.
 *   - FlipIfTouchingObj - wall flip, same as $09.
 *   - FaceMario every 64 ground-frames (bank_01.asm:1967), but the overlay
 *     locks direction to toward-Mario at spawn per `FaceMario` init.
 *
 * The overlay forecasts a configurable number of frames (default
 * `DEFAULT_FORECAST_FRAMES`) and renders the resulting per-frame center
 * polyline. The 4-bounce cycle (3 short + 1 tall) repeats deterministically
 * until the random wait timer fires in-game; this overlay ignores the
 * wait timer so the path keeps tracing the cycle across the simulated
 * window. Future editor tools can pass a larger frame budget to forecast
 * further along the terrain.
 */

const GOOMBA_SHORT_VY = -16 // $F0 signed - bounces 1-3
const GOOMBA_TALL_VY = -48 // $D0 signed - bounce 4
const GRAVITY = 3
const GRAVITY_MAX = 0x40
const BODY_W = 16
const BODY_H = 16

/**
 * Default frame budget for the bounce polyline overlay. ~4 seconds of
 * gameplay at 60fps. One full 4-bounce cycle is ~100 frames, so 256
 * frames covers ~2.5 cycles - enough horizontal distance to show how
 * the path interacts with downstream terrain (slopes, ledges, walls)
 * without flooding the canvas.
 */
export const DEFAULT_FORECAST_FRAMES = 256

export class WingedGoombaBehavior extends MovementBehavior {
  readonly kind = 'winged_goomba'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * Simulate the bounce trajectory toward Mario's spawn X for
   * `forecastFrames` frames. Returns a per-frame center-point polyline
   * threading the 4-bounce cycle (3 short + 1 tall) for as long as the
   * frame budget lasts. Stops early only when the sprite leaves the
   * playfield (`openEnd: true`).
   *
   * Direction: toward Mario at spawn via `FaceMario` init (bank_01.asm:847).
   *
   * `forecastFrames` is configurable so editor tools can let the user
   * trade overlay length against canvas clutter. Default is
   * `DEFAULT_FORECAST_FRAMES`.
   */
  computeBouncePolyline(
    spawnX: number,
    spawnY: number,
    solidH: SolidH,
    solidV: SolidV,
    levelCols: number,
    levelRows: number,
    marioSpawnX: number = 0,
    getL1?: GetL1Tile,
    forecastFrames: number = DEFAULT_FORECAST_FRAMES,
  ): { points: { x: number; y: number }[]; openEnd: boolean } {
    const collision = getL1 ? spriteCollisionFromL1(getL1) : undefined
    const startCol = Math.floor((spawnX + 8) / 16)
    const startRow = Math.floor((spawnY + BODY_H) / 16)
    const groundRow = collision?.findFloorRowBelow(startCol, startRow, levelRows) ?? startRow
    // Slope-correct the initial resting Y so the first arc starts from the
    // actual slope surface rather than the flat tile top.
    const restingY =
      (collision?.surfaceYAt(spawnX + BODY_W / 2, groundRow) ?? groundRow * 16) - BODY_H

    const dir = spawnX > marioSpawnX ? 1 : 0
    const s: BouncingState = {
      x: spawnX,
      y: restingY,
      sx: 0,
      sy: 0,
      vx: 0,
      vy: 0,
      dir,
      ground: true,
      misc160E: 0, // not used by this handler; bounce vy is counter-driven
      blocked: null,
      offgrid: false,
    }

    const points: { x: number; y: number }[] = []
    let bounceCount = 0 // SpriteMisc151C - wraps 1→2→3→4→1 every cycle.

    for (let frame = 0; frame < forecastFrames; frame++) {
      // SubUpdateSprPos + gravity.
      applyXSpeed(s, solidH, levelCols)
      applyYSpeed(s, solidV, levelRows, getL1)
      s.vy = applyGravity(s.vy, GRAVITY, GRAVITY_MAX)

      // DEC SpriteYSpeed,X
      s.vy = signed8(s.vy - 1)

      // CODE_018DBB: set vx from direction.
      s.vx = s.dir === 0 ? +BOUNCE_XSPEED : -BOUNCE_XSPEED

      // IsOnGround → launch with counter-driven vy (bank_01.asm:1964-1985).
      // Unlike $09, WingedGoomba does NOT STZ SpriteXSpeed on landing - vx
      // stays at the value CODE_018DBB just set above (±BOUNCE_XSPEED).
      if (s.ground) {
        bounceCount = (bounceCount % 4) + 1 // 1→2→3→4→1 per ROM INC + reset
        s.vy = bounceCount === 4 ? GOOMBA_TALL_VY : GOOMBA_SHORT_VY
        s.ground = false
      }

      // FlipIfTouchingObj.
      if (s.blocked === (s.dir === 0 ? 'right' : 'left')) {
        s.dir ^= 1
        s.vx = -s.vx
        s.blocked = null
      }

      points.push({ x: s.x + BODY_W / 2, y: s.y + BODY_H / 2 })

      if (s.offgrid) return { points, openEnd: true }
    }
    return { points, openEnd: true }
  }
}
