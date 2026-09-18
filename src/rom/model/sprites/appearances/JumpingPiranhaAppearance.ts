// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $4F Jumping Piranha Plant - static appearance.
 *
 * The vertical jump-zone annotation that used to live here was removed;
 * see docs/sprite-overlay-removal.md.
 */
export class JumpingPiranhaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
