import type { RenderContext } from '../../RenderTarget'
import type { CharBehavior } from '../CharBehavior'

/**
 * A VRAM char whose pixel data cycles through a list of frames driven
 * by `ctx.animFrame`. Matches the SMW NMI animation path that DMAs
 * new tile bytes into specific VRAM slots on a fixed cadence (~7.5
 * frames per second). Frames come from
 * `AnimationLoader.loadAnimationData` — no hardcoded pixel data.
 *
 * Frame index wraps modulo `frames.length`; most slots use 4 frames
 * but the behavior doesn't assume a fixed count.
 */
export class AnimatedPixels implements CharBehavior {
  constructor(readonly frames: readonly Uint8Array[]) {}

  getPixels(ctx: RenderContext): Uint8Array {
    return this.frames[ctx.animFrame.value % this.frames.length]
  }
}
