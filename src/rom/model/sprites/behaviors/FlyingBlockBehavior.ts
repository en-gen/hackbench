import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $83 Left Flying ? Block / $84 Flying ? Block — Flying_Block handler at
 * bank_01.asm:6171.
 *
 * BOTH sprites drift LEFT while oscillating in Y. The difference is only
 * in how X speed is acquired:
 *
 *   $83: XSpeed is force-set to $F4 (−12 signed) every frame at
 *        CODE_01ADE8 — constant leftward drift from the first frame.
 *
 *   $84: XSpeed ramps from 0 toward $F0 (−16 signed) via DATA_01AD68[0]=$FF
 *        (−1) added every 4th global frame (TrueFrame & $03 == 0), until the
 *        clamp is hit at $F0. At that point SpriteMisc1540 is set to $20 (32)
 *        and the direction toggle increments — but SpriteMisc1540 is NEVER
 *        decremented inside Flying_Block (CODE_019E95 is a pure graphics
 *        helper that pushes/pops all state and leaves $1540 untouched).
 *        So the decel lock persists forever: $84 drifts at −16 permanently
 *        after its ~64-frame acceleration phase.
 *
 * Y oscillation (both):
 *   Every other global frame (TrueFrame & $01 == 0), DATA_01AD68[yToggle]
 *   ($FF=−1 or $01=+1) is added to SpriteYSpeed. When SpriteYSpeed reaches
 *   DATA_01AD6A[yToggle] ($F4=−12 or $0C=+12) the toggle flips.
 *   SubSprYPosNoGrvty multiplies speed by 16 then adds to the 8-bit sub-pixel
 *   accumulator (256 sub-pixels = 1 pixel), same scale as every other SMW
 *   sprite using this routine.
 *
 * Overlay strategy:
 *   Simulate FRAMES frames from spawn, sample every SAMPLE_STEP frames, draw
 *   as a dashed polyline + arrowhead — same vocabulary as Bouncing Koopa /
 *   Para-Goomba. Both sprites produce a sinusoidal path drifting left; $84's
 *   path has wider horizontal spacing after the acceleration phase.
 */

// DATA_01AD68 — shared speed delta table ($FF = −1, $01 = +1)
const DELTA  = [0xFF, 0x01] as const
// DATA_01AD6A — Y speed clamp ($F4 = −12 signed, $0C = +12 signed)
const Y_CLAMP = [0xF4, 0x0C] as const
// DATA_01AD6C — X speed clamp for $84 ($F0 = −16 signed, $10 = +16 signed)
const X_CLAMP_84 = [0xF0, 0x10] as const
// $83 fixed X speed: LDA #$F4; STA SpriteXSpeed,X  (CODE_01ADE8)
const X_SPEED_83 = 0xF4

// Simulate this many frames — covers ≈2.5 Y oscillation cycles and ~8 tiles
// of leftward travel for both sprites.
const FRAMES      = 240
const SAMPLE_STEP = 4    // 60 points total

function signed8(v: number): number {
  return v >= 0x80 ? v - 256 : v
}

/** One step of the shared 8-bit sub-pixel accumulator. Returns the whole-pixel
 *  delta and updates acc in-place via the returned newAcc. */
function stepSubpx(
  acc: number,
  speed8: number,   // signed interpreted
): { wholePx: number; newAcc: number } {
  const raw = acc + speed8 * 16
  const whole = Math.floor(raw / 256)
  const newAcc = ((raw % 256) + 256) % 256
  return { wholePx: whole, newAcc }
}

export class FlyingBlockBehavior extends MovementBehavior {
  readonly kind = 'flying_block' as const

  constructor(readonly spriteId: 0x83 | 0x84, meta?: BehaviorMeta) {
    super(meta)
  }

  /**
   * Simulate FRAMES frames from spawn and return sampled (x, y) path points.
   * Coordinates are in level pixels; both components reference body centre
   * (+8, +8 from sprite top-left).
   *
   * The simulation faithfully implements Flying_Block (bank_01.asm:6171):
   * - Y speed updated on even global frames (TrueFrame & $01 == 0)
   * - $83 X: force $F4 every frame (CODE_01ADE8)
   * - $84 X: delta on TrueFrame & $03 == 0; SpriteMisc1540 never decremented
   */
  computePath(spawnX: number, spawnY: number): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = []

    let x = spawnX + 8
    let y = spawnY + 8
    let sx = 0        // SpriteYPosSpx / XPosSpx sub-pixel accumulators
    let sy = 0

    // Y speed state (both sprites)
    let ySpeedRaw = 0
    let yToggle   = 0

    // X speed state ($84 only)
    let xSpeedRaw = 0
    let xToggle   = 0
    let xDecel    = 0  // SpriteMisc1540 — set to 32 on clamp, never decremented

    for (let f = 0; f < FRAMES; f++) {
      // --- Y speed update: every other global frame (TrueFrame & 1 == 0) ---
      if ((f & 1) === 0) {
        ySpeedRaw = (ySpeedRaw + DELTA[yToggle]) & 0xFF
        if (ySpeedRaw === Y_CLAMP[yToggle]) yToggle ^= 1
      }

      // --- Y position ---
      const vy = stepSubpx(sy, signed8(ySpeedRaw))
      y  += vy.wholePx
      sy  = vy.newAcc

      // --- X speed + position ---
      if (this.spriteId === 0x83) {
        // CODE_01ADE8: LDA #$F4; STA SpriteXSpeed,X — forced every frame
        const vx = stepSubpx(sx, signed8(X_SPEED_83))
        x  += vx.wholePx
        sx  = vx.newAcc
      } else {
        // $84: accumulate speed toward $F0 every 4 frames when not locked
        if (xDecel === 0 && (f & 3) === 0) {
          xSpeedRaw = (xSpeedRaw + DELTA[xToggle]) & 0xFF
          if (xSpeedRaw === X_CLAMP_84[xToggle]) {
            xToggle ^= 1
            xDecel = 32  // SpriteMisc1540 = $20; never decremented by Flying_Block
          }
        }
        const vx = stepSubpx(sx, signed8(xSpeedRaw))
        x  += vx.wholePx
        sx  = vx.newAcc
      }

      if (f % SAMPLE_STEP === 0) points.push({ x, y })
    }

    return points
  }
}
