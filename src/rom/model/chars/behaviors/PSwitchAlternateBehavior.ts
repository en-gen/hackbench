// Consumes: editorStore.pSwitchActive

import { editorStore } from '../../stores/editorStore'
import type { CharBehavior } from '../CharBehavior'

/**
 * A char whose pixel data swaps to an alternate when the blue P-switch
 * is active. Wraps two other `CharBehavior`s so it composes cleanly
 * with frame animation — an animated coin that responds to blue
 * P-switch is just
 * `new PSwitchAlternateBehavior(new AnimatedPixelsBehavior(coinFrames), new StaticPixelsBehavior(usedBlockPixels))`.
 *
 * Matches SMW's actual mechanism at bank_05.asm:4418-4421 (DMA via the
 * `+0x26` offset at DATA_05B97D). Any Map16 subtile referencing an
 * affected char picks up the swap automatically — no tile-level
 * wrapping needed.
 */
export class PSwitchAlternateBehavior implements CharBehavior {
  constructor(
    readonly normal: CharBehavior,
    readonly alt: CharBehavior,
  ) {}

  getPixels(): Uint8Array {
    return editorStore.pSwitchActive ? this.alt.getPixels() : this.normal.getPixels()
  }
}
