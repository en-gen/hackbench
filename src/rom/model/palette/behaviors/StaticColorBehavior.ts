// Consumes: (none)

import type { RgbaColor } from '../../../GraphicsDecoder'
import type { ColorBehavior } from '../ColorBehavior'

export class StaticColorBehavior implements ColorBehavior {
  constructor(readonly value: RgbaColor) {}

  rgba(): RgbaColor {
    return this.value
  }
}
