/**
 * BehaviorFactory.buildMovementBehavior - switch-case branch coverage.
 *
 * Every case label is a V8 branch. Calling buildMovementBehavior with each
 * registered sprite id locks the dispatch branch for that id. The instanceof
 * assertion proves the correct class was constructed; the `kind` prefix check
 * confirms common metadata was merged in.
 *
 * Sprite ids covered:
 *   LineBrownPlt: 0x62
 *   SuperKoopa  : 0x71, 0x72, 0x73
 *   default     : everything else, including the ten sprite ids that used
 *     to construct a dead `MovementBehavior` subclass (see BehaviorFactory.ts
 *     doc comment and docs/sprites/sprite-overlay-removal.md).
 */

import { describe, it, expect } from 'vitest'
import { buildMovementBehavior } from '../../../src/rom/model/sprites/behaviors/BehaviorFactory'
import { LineBrownPlatBehavior } from '../../../src/rom/model/sprites/behaviors/LineBrownPlatBehavior'
import { SuperKoopaBehavior } from '../../../src/rom/model/sprites/behaviors/SuperKoopaBehavior'

const META = {}

// ── LineBrownPlat ($62) ───────────────────────────────────────────────────────

describe('buildMovementBehavior - LineBrownPlat ($62)', () => {
  it('$62 → LineBrownPlatBehavior', () => {
    expect(buildMovementBehavior(0x62, META)).toBeInstanceOf(LineBrownPlatBehavior)
  })
})

// ── SuperKoopa ($71 / $72 / $73) ─────────────────────────────────────────────

describe('buildMovementBehavior - SuperKoopa ($71 / $72 / $73)', () => {
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

describe('buildMovementBehavior - default (unknown or retired sprite id)', () => {
  it('$FF → plain object with kind=sprite_ff', () => {
    const b = buildMovementBehavior(0xff, META)
    expect(b).not.toBeInstanceOf(LineBrownPlatBehavior)
    expect(b.kind).toBe('sprite_ff')
  })

  it('$50 → plain object (unregistered mid-range id)', () => {
    const b = buildMovementBehavior(0x50, META)
    expect(b.kind).toBe('sprite_50')
  })

  it('$04 → plain object (Koopa Walk dispatch retired, falls to default)', () => {
    const b = buildMovementBehavior(0x04, META)
    expect(b.kind).toBe('sprite_4')
  })
})

// ── common metadata merge ─────────────────────────────────────────────────────

describe('buildMovementBehavior - common metadata merging', () => {
  it('displayName from meta is propagated to returned behavior', () => {
    const b = buildMovementBehavior(0x04, {
      displayName: 'Green Koopa',
      spawns: 2,
      isGenerator: false,
      reactRangeDy: 32,
    })
    expect(b.displayName).toBe('Green Koopa')
    expect(b.spawns).toBe(2)
    expect(b.reactRangeDy).toBe(32)
  })

  it('common metadata is also merged onto a constructed instance (LineBrownPlat)', () => {
    // buildMovementBehavior does Object.assign(instance, common) - kind
    // ends up as the common sprite_XX form even for a registered id.
    const b = buildMovementBehavior(0x62, { displayName: 'Brown Platform' })
    expect(b).toBeInstanceOf(LineBrownPlatBehavior)
    expect(b.kind).toBe('sprite_62')
    expect(b.displayName).toBe('Brown Platform')
  })
})
