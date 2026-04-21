import type { RgbaColor } from '../../GraphicsDecoder'
import type { RenderContext } from '../RenderTarget'

export interface ColorBehavior {
  rgba(ctx: RenderContext): RgbaColor
}
