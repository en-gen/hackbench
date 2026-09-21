/**
 * RipVanFishBehavior - detection-radius constant matches the ROM port.
 *
 * The wake-up test in `CODE_02C02E` (bank_02.asm:8533-8542) does
 *   `ADC #$30; CMP #$60` on both axes - the standard SMW
 * `|signed| >= $30` shortcut. Anything within ±$30 px on each axis
 * triggers the wake-up. The behavior exposes that half-width as
 * `detectHalfPx` for the appearance overlay; this test pins it.
 */
import { describe, expect, it } from 'vitest'
import {
  RipVanFishBehavior,
  RIP_VAN_FISH_DETECT_HALF_PX,
} from '../../../src/rom/model/sprites/behaviors/RipVanFishBehavior'

describe('RipVanFishBehavior', () => {
  it('detect half-width matches the ROM constant ($30 = 48 px)', () => {
    expect(RIP_VAN_FISH_DETECT_HALF_PX).toBe(0x30)
    expect(RIP_VAN_FISH_DETECT_HALF_PX).toBe(48)
  })

  it('exposes detectHalfPx on the behavior instance', () => {
    const beh = new RipVanFishBehavior()
    expect(beh.detectHalfPx).toBe(RIP_VAN_FISH_DETECT_HALF_PX)
  })

  it('kind tag identifies the behavior class', () => {
    const beh = new RipVanFishBehavior()
    expect(beh.kind).toBe('rip_van_fish')
  })
})
