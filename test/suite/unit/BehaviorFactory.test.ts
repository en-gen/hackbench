/**
 * BehaviorFactory.buildMovementBehavior — switch-case branch coverage.
 *
 * Every case label is a V8 branch. Calling buildMovementBehavior with each
 * registered sprite id locks the dispatch branch for that id. The instanceof
 * assertion proves the correct class was constructed; the `kind` prefix check
 * confirms common metadata was merged in.
 *
 * Sprite ids covered:
 *   KoopaWalk   : 0x00–0x07, 0x0C, 0x0F, 0x30, 0x32   (12 cases)
 *   WingedGoomba: 0x10
 *   FlyingLeft  : 0x08
 *   Bouncing    : 0x09
 *   Sinusoidal V: 0x0A
 *   Sinusoidal H: 0x0B
 *   HopFlame    : 0x1D
 *   Thwimp      : 0x27
 *   RipVanFish  : 0x3D
 *   Blurp       : 0xC2
 *   LineBrownPlt: 0x62
 *   FlyingBlock : 0x83, 0x84
 *   SuperKoopa  : 0x71, 0x72, 0x73
 *   SumoBrother : 0x9A
 *   default     : 0xFF (plain-object fallback)
 */

import { describe, it, expect } from 'vitest'
import { buildMovementBehavior } from '../../../src/rom/model/sprites/behaviors/BehaviorFactory'
import { KoopaWalkBehavior }           from '../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { WingedGoombaBehavior }        from '../../../src/rom/model/sprites/behaviors/WingedGoombaBehavior'
import { FlyingLeftKoopaBehavior }     from '../../../src/rom/model/sprites/behaviors/FlyingLeftKoopaBehavior'
import { BouncingKoopaBehavior }       from '../../../src/rom/model/sprites/behaviors/BouncingKoopaBehavior'
import { SinusoidalParaKoopaBehavior } from '../../../src/rom/model/sprites/behaviors/SinusoidalParaKoopaBehavior'
import { HopFlameBehavior }            from '../../../src/rom/model/sprites/behaviors/HopFlameBehavior'
import { ThwimpBounceBehavior }        from '../../../src/rom/model/sprites/behaviors/ThwimpBounceBehavior'
import { RipVanFishBehavior }          from '../../../src/rom/model/sprites/behaviors/RipVanFishBehavior'
import { BlurpBehavior }               from '../../../src/rom/model/sprites/behaviors/BlurpBehavior'
import { LineBrownPlatBehavior }       from '../../../src/rom/model/sprites/behaviors/LineBrownPlatBehavior'
import { FlyingBlockBehavior }         from '../../../src/rom/model/sprites/behaviors/FlyingBlockBehavior'
import { SuperKoopaBehavior }          from '../../../src/rom/model/sprites/behaviors/SuperKoopaBehavior'
import { SumoBrotherBehavior }         from '../../../src/rom/model/sprites/behaviors/SumoBrotherBehavior'

const META = {}

// ── KoopaWalkBehavior dispatch (12 case labels) ───────────────────────────────

describe('buildMovementBehavior — KoopaWalk sprite ids', () => {
  const KOOPA_WALK_IDS = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0C, 0x0F, 0x30, 0x32]

  KOOPA_WALK_IDS.forEach(id => {
    it(`$${id.toString(16).toUpperCase().padStart(2,'0')} → KoopaWalkBehavior`, () => {
      const b = buildMovementBehavior(id, META)
      expect(b).toBeInstanceOf(KoopaWalkBehavior)
    })
  })
})

// ── Single-id cases ───────────────────────────────────────────────────────────

describe('buildMovementBehavior — single-id dispatch cases', () => {
  it('$08 → FlyingLeftKoopaBehavior', () => {
    expect(buildMovementBehavior(0x08, META)).toBeInstanceOf(FlyingLeftKoopaBehavior)
  })

  it('$09 → BouncingKoopaBehavior', () => {
    expect(buildMovementBehavior(0x09, META)).toBeInstanceOf(BouncingKoopaBehavior)
  })

  it('$0A → SinusoidalParaKoopaBehavior (vertical axis)', () => {
    const b = buildMovementBehavior(0x0A, META)
    expect(b).toBeInstanceOf(SinusoidalParaKoopaBehavior)
    expect((b as SinusoidalParaKoopaBehavior).axis).toBe('vertical')
  })

  it('$0B → SinusoidalParaKoopaBehavior (horizontal axis)', () => {
    const b = buildMovementBehavior(0x0B, META)
    expect(b).toBeInstanceOf(SinusoidalParaKoopaBehavior)
    expect((b as SinusoidalParaKoopaBehavior).axis).toBe('horizontal')
  })

  it('$10 → WingedGoombaBehavior', () => {
    expect(buildMovementBehavior(0x10, META)).toBeInstanceOf(WingedGoombaBehavior)
  })

  it('$1D → HopFlameBehavior', () => {
    expect(buildMovementBehavior(0x1D, META)).toBeInstanceOf(HopFlameBehavior)
  })

  it('$27 → ThwimpBounceBehavior', () => {
    expect(buildMovementBehavior(0x27, META)).toBeInstanceOf(ThwimpBounceBehavior)
  })

  it('$3D → RipVanFishBehavior', () => {
    expect(buildMovementBehavior(0x3D, META)).toBeInstanceOf(RipVanFishBehavior)
  })

  it('$62 → LineBrownPlatBehavior', () => {
    expect(buildMovementBehavior(0x62, META)).toBeInstanceOf(LineBrownPlatBehavior)
  })

  it('$9A → SumoBrotherBehavior', () => {
    expect(buildMovementBehavior(0x9A, META)).toBeInstanceOf(SumoBrotherBehavior)
  })

  it('$C2 → BlurpBehavior', () => {
    expect(buildMovementBehavior(0xC2, META)).toBeInstanceOf(BlurpBehavior)
  })
})

// ── FlyingBlock ($83 / $84) ───────────────────────────────────────────────────

describe('buildMovementBehavior — FlyingBlock ($83 / $84)', () => {
  it('$83 → FlyingBlockBehavior', () => {
    expect(buildMovementBehavior(0x83, META)).toBeInstanceOf(FlyingBlockBehavior)
  })

  it('$84 → FlyingBlockBehavior', () => {
    expect(buildMovementBehavior(0x84, META)).toBeInstanceOf(FlyingBlockBehavior)
  })
})

// ── SuperKoopa ($71 / $72 / $73) ─────────────────────────────────────────────

describe('buildMovementBehavior — SuperKoopa ($71 / $72 / $73)', () => {
  it('$71 → SuperKoopaBehavior', () => {
    expect(buildMovementBehavior(0x71, META)).toBeInstanceOf(SuperKoopaBehavior)
  })

  it('$72 → SuperKoopaBehavior', () => {
    expect(buildMovementBehavior(0x72, META)).toBeInstanceOf(SuperKoopaBehavior)
  })

  it('$73 → SuperKoopaBehavior', () => {
    expect(buildMovementBehavior(0x73, META)).toBeInstanceOf(SuperKoopaBehavior)
  })
})

// ── default (plain-object fallback) ──────────────────────────────────────────

describe('buildMovementBehavior — default (unknown sprite id)', () => {
  it('$FF → plain object with kind=sprite_ff', () => {
    const b = buildMovementBehavior(0xFF, META)
    expect(b).not.toBeInstanceOf(KoopaWalkBehavior)
    expect(b.kind).toBe('sprite_ff')
  })

  it('$50 → plain object (unregistered mid-range id)', () => {
    const b = buildMovementBehavior(0x50, META)
    expect(b.kind).toBe('sprite_50')
  })
})

// ── common metadata merge ─────────────────────────────────────────────────────

describe('buildMovementBehavior — common metadata merging', () => {
  it('displayName from meta is propagated to returned behavior', () => {
    const b = buildMovementBehavior(0x04, { displayName: 'Green Koopa', spawns: 2, isGenerator: false, reactRangeDy: 32 })
    expect(b.displayName).toBe('Green Koopa')
    expect(b.spawns).toBe(2)
    expect(b.reactRangeDy).toBe(32)
  })

  it('kind override from common is set on KoopaWalk behavior', () => {
    // buildMovementBehavior does Object.assign(behavior, common) — kind is sprite_4
    const b = buildMovementBehavior(0x04, META)
    expect(b.kind).toBe('sprite_4')
  })
})
