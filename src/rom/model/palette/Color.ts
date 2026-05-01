import type { RgbaColor } from '../../GraphicsDecoder'
import type { ColorBehavior } from './ColorBehavior'

/**
 * An addressable palette cell. Holds a ColorBehavior that decides what
 * RGBA to return — static by default, cycling through frames when the
 * cell participates in palette animation. Swapping a cell's behavior is
 * how the editor can make any cell animated without touching its
 * palette or its neighbors.
 */
export class Color {
  constructor(readonly behavior: ColorBehavior) {}

  rgba(): RgbaColor {
    return this.behavior.rgba()
  }
}
