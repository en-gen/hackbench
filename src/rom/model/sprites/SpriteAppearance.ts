import type { RenderContext, RenderTarget } from '../RenderTarget'
import type { SpriteBehavior } from './SpriteBehavior'

/** Axis-aligned hit rectangle in sprite-local pixel space. */
export interface HitRect {
  dx: number  // left edge relative to sprite origin
  dy: number  // top edge relative to sprite origin
  w:  number
  h:  number
}

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

  /** Pixel-space bounding rect relative to the sprite origin. Used for cursor hit-testing. */
  readonly hitRect: HitRect
}
