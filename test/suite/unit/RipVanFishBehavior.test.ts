/**
 * RipVanFishBehavior - detection-radius constant matches the ROM port.
 *
 * The wake-up test in `CODE_02C02E` (bank_02.asm:8533-8542) does
 *   `ADC #$30; CMP #$60` on both axes - the standard SMW
 * `|signed| >= $30` shortcut. Anything within ±$30 px on each axis
 * triggers the wake-up. `RipVanFishAppearance.render` reads this constant
 * directly to pick the sleeping or chasing pose; this test pins it.
 *
 * The `RipVanFishBehavior` class that used to wrap this constant (with a
 * `detectHalfPx` getter no Appearance ever called) was removed as dead
 * movement-simulation code; see docs/sprites/sprite-overlay-removal.md.
 */
import { describe, expect, it } from 'vitest'
import { RIP_VAN_FISH_DETECT_HALF_PX } from '../../../src/rom/model/sprites/behaviors/RipVanFishBehavior'

describe('RipVanFishBehavior detection constant', () => {
  it('detect half-width matches the ROM constant ($30 = 48 px)', () => {
    expect(RIP_VAN_FISH_DETECT_HALF_PX).toBe(0x30)
    expect(RIP_VAN_FISH_DETECT_HALF_PX).toBe(48)
  })
})
