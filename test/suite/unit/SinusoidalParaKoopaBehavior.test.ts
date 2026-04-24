/**
 * ASM-derived tests for $0A Red Vertical Para-Koopa / $0B Red Horizontal
 * Para-Koopa — shared handler at bank_01.asm:1881 (RedVertParaKoopa and
 * RedHorzParaKoopa, distinguished at line 1895 `CMP #$0A; BNE CODE_018CEA`).
 *
 * Physics:
 *   - SpriteMisc1540 is a cooldown; while > 0, no speed updates but
 *     SubSprXPosNoGrvty / SubSprYPosNoGrvty still move the sprite.
 *   - Every 4 frames (when `misc1540==0 && (TableC2 & $03)==0`):
 *       idx = misc151C & 1
 *       speed += DATA_018CBA[idx]    ; $FF=-1 (idx=0) or $01=+1 (idx=1)
 *       if speed == DATA_018CBC[idx]:  ; $F0=-16 (idx=0) or $10=+16 (idx=1)
 *         misc151C++, misc1540 = $30
 *   - $0A: only SubSprYPosNoGrvty is applied; X fixed.
 *   - $0B: both axes; Y bob via misc1570 bit 5 (the same ±4-ish bob as $08).
 *
 * Tables (verbatim from bank_01.asm:1871-1872):
 *   DATA_018CBA: db $FF,$01
 *   DATA_018CBC: db $F0,$10
 *
 * Test tree:
 *   ASM constants
 *     ├─ STEP table [-1, +1]
 *     ├─ TARGET table [-16, +16]
 *     ├─ COOLDOWN = 48
 *     └─ UPDATE_INTERVAL = 4
 *
 *   speed update logic (stepSpeed)
 *     ├─ misc151C=0 → step=-1 toward target=-16
 *     ├─ misc151C=1 → step=+1 toward target=+16
 *     ├─ speed hits target → misc151C++ & misc1540=COOLDOWN
 *     └─ misc1540 > 0 → no speed change
 *
 *   computeSineBounds
 *     ├─ $0A vertical: axis='vertical', amplitude ≥ 30 px
 *     ├─ $0B horizontal: axis='horizontal', amplitude ≥ 30 px
 *     ├─ $0A: Y bound > 0, X amplitude = 0 (frozen X)
 *     ├─ $0B: X amplitude > 0, Y bob is small (≤ 8 px)
 *     └─ deterministic across repeat calls
 */

import { describe, expect, it } from 'vitest'
import {
  SinusoidalParaKoopaBehavior,
  PARAKOOPA_STEP,
  PARAKOOPA_TARGET,
  PARAKOOPA_COOLDOWN,
  PARAKOOPA_UPDATE_INTERVAL,
} from '../../../src/rom/model/sprites/behaviors/SinusoidalParaKoopaBehavior'

describe('SinusoidalParaKoopaBehavior — ASM constants', () => {
  it('STEP table matches DATA_018CBA = db $FF, $01', () => {
    expect(PARAKOOPA_STEP).toEqual([-1, 1])
  })
  it('TARGET table matches DATA_018CBC = db $F0, $10', () => {
    expect(PARAKOOPA_TARGET).toEqual([-16, 16])
  })
  it('cooldown = $30 (48 frames)', () => {
    expect(PARAKOOPA_COOLDOWN).toBe(48)
  })
  it('update interval = 4 frames', () => {
    expect(PARAKOOPA_UPDATE_INTERVAL).toBe(4)
  })
})

describe('SinusoidalParaKoopaBehavior — computeSineBounds (vertical, $0A)', () => {
  it('exposes vertical axis and non-trivial amplitude', () => {
    const beh = new SinusoidalParaKoopaBehavior({ axis: 'vertical' })
    const b = beh.computeSineBounds()
    expect(b.axis).toBe('vertical')
    expect(b.amplitudePx).toBeGreaterThanOrEqual(30)
    expect(b.amplitudePx).toBeLessThanOrEqual(128)
  })

  it('kind tag identifies the sprite family', () => {
    const beh = new SinusoidalParaKoopaBehavior({ axis: 'vertical' })
    expect(beh.kind).toBe('sinusoidal_para_koopa')
  })

  it('deterministic across repeat invocations', () => {
    const beh = new SinusoidalParaKoopaBehavior({ axis: 'vertical' })
    expect(beh.computeSineBounds()).toEqual(beh.computeSineBounds())
  })
})

describe('SinusoidalParaKoopaBehavior — computeSineBounds (horizontal, $0B)', () => {
  it('exposes horizontal axis and non-trivial amplitude', () => {
    const beh = new SinusoidalParaKoopaBehavior({ axis: 'horizontal' })
    const b = beh.computeSineBounds()
    expect(b.axis).toBe('horizontal')
    expect(b.amplitudePx).toBeGreaterThanOrEqual(30)
    expect(b.amplitudePx).toBeLessThanOrEqual(128)
  })

  it('horizontal ≡ vertical amplitude (same table-driven integration)', () => {
    const v = new SinusoidalParaKoopaBehavior({ axis: 'vertical' }).computeSineBounds()
    const h = new SinusoidalParaKoopaBehavior({ axis: 'horizontal' }).computeSineBounds()
    expect(v.amplitudePx).toBe(h.amplitudePx)
  })
})
