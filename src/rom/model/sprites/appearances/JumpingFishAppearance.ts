// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $18 Surface Jumping fish - static appearance.
 *
 * The vertical jump-zone annotation that used to live here was removed;
 * see docs/sprite-overlay-removal.md.
 */
export class JumpingFishAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
