import type { RenderContext } from '../../RenderTarget'
import type { CharBehavior } from '../CharBehavior'

export class StaticPixelsBehavior implements CharBehavior {
  constructor(readonly pixels: Uint8Array) {}

  getPixels(_ctx: RenderContext): Uint8Array {
    return this.pixels
  }
}
