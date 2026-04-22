import type { RenderContext, RenderTarget } from '../RenderTarget'
import type { SpriteBehavior } from './SpriteBehavior'

export interface SpriteAppearance {
  /**
   * Draw this sprite at the given pixel position. `behavior` is the same
   * object hanging off the parent `Sprite` — appearances that need access
   * to behavioral data (reach, state, etc.) read it here; most ignore it.
   */
  render(
    ctx: RenderContext,
    target: RenderTarget,
    x: number,
    y: number,
    behavior: SpriteBehavior,
  ): void
}
