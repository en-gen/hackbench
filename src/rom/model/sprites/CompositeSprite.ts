import type { RenderContext, RenderTarget } from '../RenderTarget'
import type { SpriteAppearance } from './SpriteAppearance'
import type { SpriteBehavior } from './SpriteBehavior'
import { Sprite } from './Sprite'

/**
 * A sprite that owns a secondary child sprite rendered on top and
 * participating in hit-testing.
 *
 * Used for SMW sprite pairs where one sprite's runtime handler repositions
 * and drives the other — e.g. Hammer Brother Platform ($9C) places Hammer
 * Brother ($9B) 16px above itself and calls HammerBroGfx for it
 * (bank_02.asm:12115-12148). The primary is the "master" that owns the
 * relationship; the secondary keeps its own `id` / `displayName` /
 * `behavior`, so hover reports the correct sprite per hovered region.
 *
 * The child's (x, y) are absolute level-pixel coordinates — already offset
 * from the primary by whatever the runtime routine would apply.
 * `map.sprites` contains only the primary; the child is reached via
 * `.secondary` and is never iterated at the top level.
 */
export class CompositeSprite extends Sprite {
  constructor(
    id: number,
    x: number,
    y: number,
    appearance: SpriteAppearance,
    behavior: SpriteBehavior,
    readonly secondary?: Sprite,
  ) {
    super(id, x, y, appearance, behavior)
  }

  override render(ctx: RenderContext, target: RenderTarget): void {
    super.render(ctx, target)
    this.secondary?.render(ctx, target)
  }

  override tickAnimation(): void {
    super.tickAnimation()
    this.secondary?.tickAnimation()
  }

  override pickAt(levelPx: number, levelPy: number): Sprite | null {
    // Secondary is drawn on top, so it wins hit-test priority.
    const sHit = this.secondary?.pickAt(levelPx, levelPy)
    if (sHit) return sHit
    return super.pickAt(levelPx, levelPy)
  }
}
