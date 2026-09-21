import { MovementBehavior, type BehaviorMeta } from '../MovementBehavior'

/**
 * $3D Rip Van Fish - `RipVanFishMain` (bank_02.asm:8462).
 *
 * Sleeps until Mario enters the wake-up zone, then chases. The detection
 * test runs on every frame inside the swim state (CODE_02C02E):
 *
 *   JSR CODE_02D4FA       ; _F = mario_y - sprite_y (signed)
 *   LDA _F
 *   ADC #$30
 *   CMP #$60
 *   BCS sleep             ; |dy| >= $30 → stay asleep
 *   JSR CODE_02D50C       ; _E = mario_x - sprite_x
 *   LDA _E
 *   ADC #$30
 *   CMP #$60
 *   BCS sleep             ; |dx| >= $30 → stay asleep
 *   ; otherwise → wake up
 *
 * `(_E + $30) >= $60` is the standard SMW `|signed| >= $30` shorthand:
 * adding $30 maps the [-$30, +$30) range to [0, $60), so anything
 * outside that range BCSs out. The wake-up zone is therefore a
 * **96 × 96 square** (±$30 = ±48 px on each axis) centered on the
 * sprite's spawn position.
 *
 * Chuck-whistling override: when `ChuckIsWhistling != 0` the test is
 * skipped and the fish wakes immediately. Not modeled here - the
 * editor overlay reflects the static distance check only.
 */

/** Half-width of the wake-up zone in pixels (`$30` from the ASM). */
export const RIP_VAN_FISH_DETECT_HALF_PX = 0x30

export class RipVanFishBehavior extends MovementBehavior {
  readonly kind = 'rip_van_fish'

  constructor(meta?: BehaviorMeta) {
    super(meta)
  }

  /** Per-axis half-width of the detection square. */
  get detectHalfPx(): number {
    return RIP_VAN_FISH_DETECT_HALF_PX
  }
}
