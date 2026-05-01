// Consumes: (none)

import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

export class StaticQuadBehavior implements TileBehavior {
  constructor(readonly quad: SubtileQuad) {}

  selectQuad(): SubtileQuad {
    return this.quad
  }
}
