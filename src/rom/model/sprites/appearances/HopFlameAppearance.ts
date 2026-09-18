// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $1D Hopping Flame - static appearance.
 *
 * The bounce-envelope annotation that used to live here was removed; see
 * docs/sprite-overlay-removal.md. `HopFlameBehavior` still owns the
 * movement simulation it was drawn from.
 */
export class HopFlameAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
