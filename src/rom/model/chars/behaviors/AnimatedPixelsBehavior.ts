// Consumes: editorStore.animFrame

import { editorStore } from '../../stores/editorStore'
import type { CharBehavior } from '../CharBehavior'

/**
 * A VRAM char whose pixel data cycles through a list of frames driven
 * by `editorStore.animFrame`. Matches the SMW NMI animation path that
 * DMAs new tile bytes into specific VRAM slots on a fixed cadence (~7.5
 * frames per second). Frames come from
 * `AnimationLoader.loadAnimationData` — no hardcoded pixel data.
 *
 * Frame index wraps modulo `frames.length`; most slots use 4 frames
 * but the behavior doesn't assume a fixed count.
 */
export class AnimatedPixelsBehavior implements CharBehavior {
  constructor(readonly frames: readonly Uint8Array[]) {}

  getPixels(): Uint8Array {
    return this.frames[editorStore.animFrame % this.frames.length]
  }
}
