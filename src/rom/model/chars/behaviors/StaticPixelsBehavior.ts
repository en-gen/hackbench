// Consumes: (none)

import type { CharBehavior } from '../CharBehavior'

export class StaticPixelsBehavior implements CharBehavior {
  constructor(readonly pixels: Uint8Array) {}

  getPixels(): Uint8Array {
    return this.pixels
  }
}
