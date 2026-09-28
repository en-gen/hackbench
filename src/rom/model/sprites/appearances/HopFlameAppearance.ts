// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $1D Hopping Flame - static appearance.
 *
 * The bounce-envelope annotation that used to live here was removed; see
 * docs/sprites/sprite-overlay-removal.md. `HopFlameBehavior`, the movement
 * simulator it was drawn from, had no other reader and was deleted as dead
 * code in the same cleanup.
 */
export class HopFlameAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
