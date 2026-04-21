import type { RenderContext } from '../RenderTarget'

export interface CharBehavior {
  getPixels(ctx: RenderContext): Uint8Array
}
