import type { RenderContext, RenderTarget } from '../RenderTarget'
import type { SpriteAppearance } from './SpriteAppearance'
import type { SpriteBehavior } from './SpriteBehavior'

export class Sprite {
  constructor(
    readonly id: number,
    readonly x: number,
    readonly y: number,
    readonly appearance: SpriteAppearance,
    readonly behavior: SpriteBehavior,
  ) {}

  render(ctx: RenderContext, target: RenderTarget): void {
    this.appearance.render(ctx, target, this.x, this.y, this.behavior)
  }

  /**
   * Returns `this` when (levelPx, levelPy) is inside the sprite's hit rect,
   * else null. Subclasses override to drill into nested children.
   */
  pickAt(levelPx: number, levelPy: number): Sprite | null {
    const hr = this.appearance.hitRect
    if (levelPx >= this.x + hr.dx && levelPx < this.x + hr.dx + hr.w
     && levelPy >= this.y + hr.dy && levelPy < this.y + hr.dy + hr.h) {
      return this
    }
    return null
  }
}
