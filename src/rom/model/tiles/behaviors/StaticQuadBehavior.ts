import type { RenderContext } from '../../RenderTarget'
import type { SubtileQuad } from '../Tile'
import type { TileBehavior } from '../TileBehavior'

export class StaticQuadBehavior implements TileBehavior {
  constructor(readonly quad: SubtileQuad) {}

  selectQuad(_ctx: RenderContext): SubtileQuad {
    return this.quad
  }
}
