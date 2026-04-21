import type { RgbaColor } from '../../../GraphicsDecoder'
import type { RenderContext } from '../../RenderTarget'
import type { ColorBehavior } from '../ColorBehavior'

/**
 * A palette cell that cycles through a list of frames driven by
 * `ctx.palAnimFrame`. The cell's position is wherever the palette
 * places it — the behavior only owns the frame sequence.
 *
 * SMW level mode: one CyclingColor at CGRAM $64 (row 6 col 4).
 * SMW overworld: two CyclingColor cells at $6D (row 6 col 13) and
 * $7D (row 7 col 13). Frames come from
 * PaletteAnimationLoader.loadPaletteAnimData — no hardcoded colors.
 */
export class CyclingColor implements ColorBehavior {
  constructor(readonly frames: readonly RgbaColor[]) {}

  rgba(ctx: RenderContext): RgbaColor {
    return this.frames[ctx.palAnimFrame.value % this.frames.length]
  }
}
