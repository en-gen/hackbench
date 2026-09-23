/**
 * SwimJumpFishAppearance: sprite $47 static appearance.
 *
 * The frame-by-frame FISH_PATH / FISH_BOUNDS simulation this file used to
 * exercise existed only to feed the swim/jump path annotation, and went
 * with it (see docs/sprites/sprite-overlay-removal.md). What is left is a bare
 * StaticSpriteAppearance subclass, so the only behaviour worth locking is
 * that it still inherits the part-driven hit rect.
 */

import { describe, it, expect } from 'vitest'
import { SwimJumpFishAppearance } from '../../../../src/rom/model/sprites/appearances/SwimJumpFishAppearance'

describe('SwimJumpFishAppearance inherits StaticSpriteAppearance', () => {
  it('hitRect is the 16x16 default when constructed with empty parts', () => {
    const app = new SwimJumpFishAppearance([])
    expect(app.hitRect).toEqual({ dx: 0, dy: 0, w: 16, h: 16 })
  })
})
