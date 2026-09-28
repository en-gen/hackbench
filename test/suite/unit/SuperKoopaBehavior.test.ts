/**
 * ASM-derived tests for $71/$72/$73 Super Koopa feather-drop rule.
 *
 *   dropsFeather
 *     ├─ $71 → always false (Sprite1686Vals[$71]=$10, TweakerE bit 6 clear)
 *     ├─ $72 → always false (Sprite1686Vals[$72]=$10, TweakerE bit 6 clear)
 *     ├─ $73 even slot (spritePx & $10 == 0) → true
 *     │   ASM: InitSuperKoopaFthr falls through → INC Misc1534, TweakerE stays $50
 *     └─ $73 odd slot (spritePx & $10 != 0) → false
 *         ASM: InitSuperKoopaFthr writes TweakerE=$10 clearing bit 6
 */

import { describe, expect, it } from 'vitest'
import { SuperKoopaBehavior } from '../../../src/rom/model/sprites/behaviors/SuperKoopaBehavior'

describe('SuperKoopaBehavior.dropsFeather', () => {
  it('$71 never drops a feather', () => {
    const b = new SuperKoopaBehavior(0x71)
    for (let x = 0; x < 512; x += 16) {
      expect(b.dropsFeather(x)).toBe(false)
    }
  })

  it('$72 never drops a feather', () => {
    const b = new SuperKoopaBehavior(0x72)
    for (let x = 0; x < 512; x += 16) {
      expect(b.dropsFeather(x)).toBe(false)
    }
  })

  it('$73 drops a feather when SpriteXPosLow bit 4 is clear', () => {
    const b = new SuperKoopaBehavior(0x73)
    // ASM: InitSuperKoopaFthr (bank_01.asm:804) - LDA SpriteXPosLow / AND #$10 / BEQ +
    // The even-16-px-slot branch keeps TweakerE=$50 → bit 6 set → drops feather.
    expect(b.dropsFeather(0x00)).toBe(true)
    expect(b.dropsFeather(0x20)).toBe(true)
    expect(b.dropsFeather(0x40)).toBe(true)
    expect(b.dropsFeather(0x100)).toBe(true)
    expect(b.dropsFeather(0x120)).toBe(true)
  })

  it('$73 does not drop a feather when SpriteXPosLow bit 4 is set', () => {
    const b = new SuperKoopaBehavior(0x73)
    // Odd-16-px slot → init writes TweakerE=$10 → bit 6 clear → no feather.
    expect(b.dropsFeather(0x10)).toBe(false)
    expect(b.dropsFeather(0x30)).toBe(false)
    expect(b.dropsFeather(0x50)).toBe(false)
    expect(b.dropsFeather(0x110)).toBe(false)
    expect(b.dropsFeather(0x130)).toBe(false)
  })
})
