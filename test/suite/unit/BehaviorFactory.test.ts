/**
 * BehaviorFactory.buildMovementBehavior - switch-case branch coverage.
 *
 * Every case label is a V8 branch. Calling buildMovementBehavior with each
 * registered sprite id locks the dispatch branch for that id. The instanceof
 * assertion proves the correct class was constructed; the `kind` prefix check
 * confirms common metadata was merged in.
 *
 * Sprite ids covered:
 *   SuperKoopa : 0x71, 0x72, 0x73 (the only registered class left)
 *   default    : everything else, swept explicitly for the 24 sprite ids
 *     that used to dispatch to one of the eleven now-deleted
 *     `MovementBehavior` subclasses (see BehaviorFactory.ts's doc comment
 *     and docs/sprites/sprite-overlay-removal.md's update section), plus
 *     $62 separately (its `LineBrownPlatBehavior` case was dropped because
 *     it produced output identical to `default`, not because it was dead).
 */

import { describe, it, expect } from 'vitest'
import { buildMovementBehavior } from '../../../src/rom/model/sprites/behaviors/BehaviorFactory'
import { SuperKoopaBehavior } from '../../../src/rom/model/sprites/behaviors/SuperKoopaBehavior'

const META = {}

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

// ── default: the 24 retired sprite ids ───────────────────────────────────────

/**
 * Every sprite id that used to construct one of the eleven deleted
 * `MovementBehavior` subclasses. Grouped by the class that used to own
 * them, matching the enumeration in docs/sprites/sprite-overlay-removal.md.
 */
const RETIRED_IDS: Record<string, readonly number[]> = {
  KoopaWalkBehavior: [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0c, 0x0f, 0x30, 0x32],
  WingedGoombaBehavior: [0x10],
  FlyingLeftKoopaBehavior: [0x08],
  BouncingKoopaBehavior: [0x09],
  SinusoidalParaKoopaBehavior: [0x0a, 0x0b],
  HopFlameBehavior: [0x1d],
  ThwimpBounceBehavior: [0x27],
  RipVanFishBehavior: [0x3d],
  BlurpBehavior: [0xc2],
  SumoBrotherBehavior: [0x9a],
  FlyingBlockBehavior: [0x83, 0x84],
}

const RETIRED_ID_COUNT = Object.values(RETIRED_IDS).reduce((n, ids) => n + ids.length, 0)

describe('buildMovementBehavior - retired ids fall through to default', () => {
  it('the sweep table covers exactly the 24 ids the eleven deleted classes registered', () => {
    expect(RETIRED_ID_COUNT).toBe(24)
    expect(Object.keys(RETIRED_IDS)).toHaveLength(11)
  })

  for (const [className, ids] of Object.entries(RETIRED_IDS)) {
    for (const id of ids) {
      const hex = id.toString(16).toUpperCase().padStart(2, '0')
      it(`$${hex} (formerly ${className}) → plain object, kind=sprite_${id.toString(16)}`, () => {
        const b = buildMovementBehavior(id, META)
        expect(Object.getPrototypeOf(b)).toBe(Object.prototype)
        expect(b.kind).toBe(`sprite_${id.toString(16)}`)
      })
    }
  }
})

// ── default: unregistered and redundant ids ──────────────────────────────────

describe('buildMovementBehavior - default (unknown or redundant sprite id)', () => {
  it('$FF → plain object with kind=sprite_ff (never registered)', () => {
    const b = buildMovementBehavior(0xff, META)
    expect(b).not.toBeInstanceOf(SuperKoopaBehavior)
    expect(b.kind).toBe('sprite_ff')
  })

  it('$50 → plain object (unregistered mid-range id)', () => {
    const b = buildMovementBehavior(0x50, META)
    expect(b.kind).toBe('sprite_50')
  })

  it('$62 → plain object, same shape `default` produces for any id (LineBrownPlat case dropped as redundant)', () => {
    // LineBrownPlatBehavior's case was removed because Object.assign(instance,
    // common) made its output indistinguishable from `default` for every
    // field any live caller reads - not because it was dead code. This pins
    // that: $62 is a plain object with exactly the common shape, not a
    // LineBrownPlatBehavior instance carrying extra fields nothing reads.
    const meta = { displayName: 'Brown Platform', spawns: 1 }
    const b = buildMovementBehavior(0x62, meta)
    expect(b).toStrictEqual({
      kind: 'sprite_62',
      displayName: 'Brown Platform',
      spawns: 1,
      isGenerator: undefined,
      reactRangeDy: undefined,
    })
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

  it('common metadata is also merged onto a constructed instance (SuperKoopa)', () => {
    // buildMovementBehavior does Object.assign(instance, common) - kind
    // ends up as the common sprite_XX form even for a registered id.
    const b = buildMovementBehavior(0x71, { displayName: 'Super Koopa' })
    expect(b).toBeInstanceOf(SuperKoopaBehavior)
    expect(b.kind).toBe('sprite_71')
    expect(b.displayName).toBe('Super Koopa')
  })
})
