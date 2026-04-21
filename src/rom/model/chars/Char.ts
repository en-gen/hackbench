import type { RenderContext } from '../RenderTarget'
import type { CharBehavior } from './CharBehavior'

export class Char {
  constructor(readonly id: number, readonly behavior: CharBehavior) {}

  getPixels(ctx: RenderContext): Uint8Array {
    return this.behavior.getPixels(ctx)
  }
}
