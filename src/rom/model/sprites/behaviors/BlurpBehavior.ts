import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $C2 Blurp fish — `Blurp` handler at bank_03.asm:565.
 *
 * Movement (decoded from `BlurpSpeedX`/`BlurpAccelY`/`BlurpMaxSpeedY`,
 * bank_03.asm:556-563):
 *
 *   - Horizontal: `SpriteXSpeed = BlurpSpeedX[157C]` = ±$08 sub-px/frame
 *     (SubSpr position-update scaling: 1 sub-px = 1/16 px → ±0.5 px/frame
 *     average). `157C` is the FaceMario direction byte: 0=face right,
 *     1=face left. The init at bank_01.asm:847 calls FaceMario, so the
 *     fish swims toward Mario from spawn.
 *
 *   - Vertical: triangle-wave bobbing. `SpriteYSpeed` accumulates by
 *     ±1 once every 4 frames (`EffFrame & $03 == 0` gate inside
 *     `Blurp`); when the speed reaches `BlurpMaxSpeedY[C2]` (= +$04 or
 *     -$04 depending on `SpriteTableC2 & 1`), `C2` flips and the accel
 *     direction reverses. Full speed cycle: 0 → +4 → 0 → -4 → 0 over
 *     **64 frames**.
 *
 *   - Position is updated EVERY frame using the current speeds; only
 *     speed changes are gated.
 *
 * Y amplitude: integrating Y-speed across half a cycle gives 64
 * speed-units (1+1+1+1+2+2+2+2+3+3+3+3+4+4+4+4+3+3+3+3+2+2+2+2+1+1+1+1).
 * SubSpr Y position uses `speed * 16` sub-px/frame, so 64 * 16 = 1024
 * sub-pixels = **4 px peak** above (and below) spawn. Tiny for a 16x16
 * sprite, but visible at the editor's display scale.
 *
 * X-direction is set at spawn from FaceMario and never flips during
 * normal play: the fish swims off-screen in one direction.
 */

export const BLURP_X_SPEED_SUBPX     = 0x08   // BlurpSpeedX[0]; ±0.5 px/frame avg
export const BLURP_Y_AMPLITUDE_PX    = 4      // integrated peak from Y triangle wave
export const BLURP_Y_CYCLE_FRAMES    = 64

export class BlurpBehavior extends MovementBehavior {
  readonly kind = 'blurp'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /** ±1: +1 = swims right, -1 = swims left. Mirrors FaceMario init. */
  swimDirection(spawnX: number, marioSpawnX: number): -1 | 1 {
    return spawnX > marioSpawnX ? -1 : +1
  }
}
