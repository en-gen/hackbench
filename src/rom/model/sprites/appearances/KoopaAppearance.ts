// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Ground-walking koopa appearance - $04 Green / $05 Red / $06 Blue /
 * $07 Yellow (and the rest of the Spr0to13Main family: $0F Goomba, $11
 * Buzzy Beetle, $13 Spiny).
 *
 * Renders the sprite's pixel parts via `StaticSpriteAppearance`. The
 * patrol-path annotation that used to live here was removed; see
 * docs/sprites/sprite-overlay-removal.md.
 */
export class KoopaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }
}
