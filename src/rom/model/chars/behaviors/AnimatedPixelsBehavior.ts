import type { CharBehavior } from '../CharBehavior'

/**
 * A VRAM char whose pixel data cycles through a list of frames. The
 * editor's map-animation timer drives advancement via `tickAnimation()`;
 * frame state is owned internally so cadence is decoupled from any global
 * counter. Matches the SMW NMI animation path that DMAs new tile bytes
 * into specific VRAM slots on a fixed cadence (~7.5 frames per second).
 * Frames come from `AnimationLoader.loadAnimationData` — no hardcoded
 * pixel data.
 */
export class AnimatedPixelsBehavior implements CharBehavior {
  private frame = 0

  constructor(readonly frames: readonly Uint8Array[]) {}

  tickAnimation(): void {
    this.frame = (this.frame + 1) % this.frames.length
  }

  getPixels(): Uint8Array {
    return this.frames[this.frame]
  }
}
