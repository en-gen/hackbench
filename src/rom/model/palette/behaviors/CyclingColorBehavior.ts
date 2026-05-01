// Consumes: editorStore.palAnimFrame

import type { RgbaColor } from '../../../GraphicsDecoder'
import { editorStore } from '../../stores/editorStore'
import type { ColorBehavior } from '../ColorBehavior'

/**
 * A palette cell that cycles through a list of frames driven by
 * `editorStore.palAnimFrame`. The cell's position is wherever the palette
 * places it — the behavior only owns the frame sequence.
 *
 * SMW level mode: one CyclingColorBehavior at CGRAM $64 (row 6 col 4).
 * SMW overworld: two CyclingColorBehavior cells at $6D (row 6 col 13) and
 * $7D (row 7 col 13). Frames come from
 * PaletteAnimationLoader.loadPaletteAnimData — no hardcoded colors.
 */
export class CyclingColorBehavior implements ColorBehavior {
  constructor(readonly frames: readonly RgbaColor[]) {}

  rgba(): RgbaColor {
    return this.frames[editorStore.palAnimFrame % this.frames.length]
  }
}
