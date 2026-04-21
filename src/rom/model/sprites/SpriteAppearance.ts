import type { RenderContext, RenderTarget } from '../RenderTarget'

export interface SpriteAppearance {
  render(ctx: RenderContext, target: RenderTarget, x: number, y: number): void
}
