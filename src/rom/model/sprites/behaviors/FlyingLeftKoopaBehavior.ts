import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $08 Green Para-Koopa (horizontal flier) - GreenParaKoopa handler at
 * bank_01.asm:1817, $08 branch at line 1835.
 *
 * Physics:
 *   - vx = Spr0to13SpeedX[dir]. The init routine InitGrnBounceKoopa seeds
 *     the direction based on (spawn-Y bit 4); in-game this produces either
 *     left or right flyers per-spawn. The OVERLAY shows the worst-case
 *     leftward fade (bug 3 in the plan: "some koopas fly left forever");
 *     right-flyers are mirror-symmetric and handled by factory config.
 *   - vy alternates between $FC (-4 sub-px) and +$04 based on
 *     `SpriteMisc1570 & $20`. Bit 5 of the 1570 counter flips every 32
 *     frames, giving a 64-frame vertical bob period.
 *   - Handler calls `SubSprXPosNoGrvty` + `SubSprYPosNoGrvty` only -
 *     `CODE_019140` (full collision) is NOT called. `SpriteBlockedDirs` is
 *     never set. The sprite passes through walls until it despawns
 *     offscreen via the sprite offscreen bookkeeping.
 *
 * Overlay strategy:
 *   A short fade-to-transparent corridor (6 tiles = 96 px) to the left of
 *   spawn conveys "flies this direction, forever". Extending it further
 *   would clutter the level view and isn't necessary - the fade itself is
 *   the signal. Walls visible in that span do NOT block the sprite.
 */

/** vx from Spr0to13SpeedX[1] = $F8 (signed -8). */
export const FLY_XSPEED = -8

/** Y-bob lower bound - $FC (signed -4). */
export const FLY_Y_BOB_LOW = -4

/** Y-bob upper bound - +4 (signed +$04). */
export const FLY_Y_BOB_HIGH = +4

/** Fade corridor length in pixels (6 tiles). Long enough to read direction
 *  of travel; short enough to not dominate the level view. */
export const FADE_LENGTH_PX = 96

/** Fade corridor height in pixels: body (16) + bob amplitude (±4) + margin. */
export const FADE_HEIGHT_PX = 24

export interface FadeCorridor {
  originX: number
  originY: number
  endX: number
  heightPx: number
}

export class FlyingLeftKoopaBehavior extends MovementBehavior {
  readonly kind = 'flying_left_koopa'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * The fade corridor drawn by the overlay. Purely geometric - doesn't
   * depend on L1 solidity because the sprite passes through walls.
   */
  computeFadeCorridor(spawnX: number, spawnY: number): FadeCorridor {
    return {
      originX: spawnX,
      originY: spawnY,
      endX: spawnX - FADE_LENGTH_PX,
      heightPx: FADE_HEIGHT_PX,
    }
  }

  /**
   * Deterministic position after N frames since spawn. Exposed for tests
   * and eventually for a scrubbable "preview" affordance in the editor.
   *
   * X: each frame adds -8 sub-px (vx × 16 scale = -128/frame into the
   *    8-bit accumulator). Alternates whole-pixel moves 1/0/1/0 → 0.5 px/frame.
   * Y: SpriteMisc1570 bit 5 flips every 32 frames. When clear, vy=-4
   *    (-64/frame into accumulator → 1 px every 4 frames). Flipped, vy=+4
   *    (symmetric down). Full cycle period = 64 frames, amplitude ≈ 8 px.
   *
   * Implementation runs the full sub-pixel sim so it's faithful to ASM.
   */
  computeFlightPosition(spawnX: number, spawnY: number, frame: number): { x: number; y: number } {
    let x = spawnX,
      y = spawnY
    let sx = 0,
      sy = 0
    for (let f = 0; f < frame; f++) {
      // X sub-pixel step: vx = -8 sub-px → -8 × 16 = -128 per frame total.
      const dxSub = FLY_XSPEED * 16
      const newSx = sx + dxSub
      const wholeDx = Math.floor(newSx / 256)
      sx = ((newSx % 256) + 256) % 256
      x += wholeDx

      // Y sub-pixel step: vy depends on frame % 64.
      const vy = ((f >>> 5) & 1) === 0 ? FLY_Y_BOB_LOW : FLY_Y_BOB_HIGH
      const dySub = vy * 16
      const newSy = sy + dySub
      const wholeDy = Math.floor(newSy / 256)
      sy = ((newSy % 256) + 256) % 256
      y += wholeDy
    }
    return { x, y }
  }
}
