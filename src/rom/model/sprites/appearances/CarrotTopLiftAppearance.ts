// Consumes: (none)

import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * $B7/$B8 Carrot Top lift - L-shaped diagonal platform.
 *
 * `spriteId` distinguishes the two variants ($B7 spawns at the top-right
 * end of its travel, $B8 at the bottom-right). The diagonal path
 * annotation that consumed it was removed; see
 * docs/sprite-overlay-removal.md.
 */
export class CarrotTopLiftAppearance extends StaticSpriteAppearance {
  constructor(
    parts: SpritePart[],
    readonly spriteId: 0xb7 | 0xb8,
  ) {
    super(parts)
  }
}
