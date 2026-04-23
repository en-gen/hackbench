import type { RgbaColor } from '../../../GraphicsDecoder'
import type { RenderContext } from '../../RenderTarget'
import type { ColorBehavior } from '../ColorBehavior'

export class StaticColorBehavior implements ColorBehavior {
  constructor(readonly value: RgbaColor) {}

  rgba(_ctx: RenderContext): RgbaColor {
    return this.value
  }
}
