import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $4D/$4E Monty Mole (ground / ledge) - static appearance.
 *
 * The horizontal detection-zone annotation that used to live here was
 * removed; see docs/sprite-overlay-removal.md.
 */
export class MontyMoleAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
