// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $C2 Blurp - static appearance.
 *
 * Renders the sprite's pixel parts via `StaticSpriteAppearance`. The
 * swim-path annotation that used to live here was removed; see
 * docs/sprites/sprite-overlay-removal.md.
 */

export class BlurpAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
