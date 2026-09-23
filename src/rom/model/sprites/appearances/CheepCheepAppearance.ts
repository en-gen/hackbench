// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $15 (horizontal) and $16 (vertical) Cheep-Cheep appearance.
 *
 * Serializes transparently as `{kind:'static'}` - no extra payload needed
 * since the sprite ID in the descriptor drives class selection on rehydration.
 *
 * The swim-corridor annotation that used to live here was removed; see
 * docs/sprites/sprite-overlay-removal.md.
 */
export class CheepCheepAppearance extends StaticSpriteAppearance {
  constructor(
    parts: SpritePart[],
    /** true for $16 (vertical movement), false for $15 (horizontal). */
    readonly vertical: boolean,
  ) {
    super(parts)
  }
}
