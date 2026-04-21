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
    this.appearance.render(ctx, target, this.x, this.y)
  }
}
