// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $47 Swimming/Jumping fish - static appearance.
 *
 * Handler: `SwimJumpFishMain` -> `CODE_02E727` (bank_02.asm:13649-13735).
 *
 * The swim/jump path annotation that used to live here, together with the
 * frame-by-frame ASM physics simulation that fed it, was removed; see
 * docs/sprites/sprite-overlay-removal.md.
 */
export class SwimJumpFishAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
