/**
 * The Properties preview's frame source (#984): asks the node side for the selected sprite's poses and
 * steps through them. No shell imports, so it is unit tested with a fake loader and a fake clock.
 */
import type { MapSpriteDto, SpriteFramesResult } from '../common/project-protocol'

/** 8 game frames (60 Hz) per pose: slow enough to read a walk cycle, fast enough to look alive. */
export const FRAME_STEP_MS = 133

export interface FrameSource {
  manifestPath: string
  index: number
  spriteIndex: number
}

export type FramesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'still'; reason?: string }
  | { kind: 'playing'; frames: MapSpriteDto[]; current: number }

export interface Clock {
  every(fn: () => void, ms: number): unknown
  stop(handle: unknown): void
}

const realClock: Clock = {
  every: (fn, ms) => setInterval(fn, ms),
  stop: h => clearInterval(h as ReturnType<typeof setInterval>),
}

export class FramePlayer {
  state: FramesState = { kind: 'idle' }
  /** Bumped by every select, clear and dispose: a reply for an older number is dropped. */
  private generation = 0
  private timer: unknown
  private visible = true
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly load: (src: FrameSource) => Promise<SpriteFramesResult>,
    private readonly clock: Clock = realClock,
  ) {}

  onChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn)
    return { dispose: () => this.listeners.delete(fn) }
  }

  select(src: FrameSource | undefined): void {
    const gen = ++this.generation
    this.halt()
    if (!src) return this.set({ kind: 'idle' })
    this.set({ kind: 'loading' })
    this.load(src).then(
      r => {
        if (gen !== this.generation) return
        const frames = r.status === 'ok' ? r.frames : []
        if (frames.length < 2) {
          return this.set({
            kind: 'still',
            reason: r.status === 'rom-not-located' ? undefined : r.reason,
          })
        }
        this.set({ kind: 'playing', frames, current: 0 })
        this.resume()
      },
      err => gen === this.generation && this.set({ kind: 'still', reason: String(err?.message ?? err) }), // prettier-ignore
    )
  }

  /** A hidden panel paints nothing, so its timer stops; showing it again restarts the loop. */
  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) this.resume()
    else this.halt()
  }

  dispose(): void {
    this.generation++
    this.halt()
    this.listeners.clear()
  }

  private resume(): void {
    if (this.timer !== undefined || !this.visible || this.state.kind !== 'playing') return
    this.timer = this.clock.every(() => {
      const s = this.state
      if (s.kind === 'playing') this.set({ ...s, current: (s.current + 1) % s.frames.length })
    }, FRAME_STEP_MS)
  }

  private halt(): void {
    if (this.timer !== undefined) this.clock.stop(this.timer)
    this.timer = undefined
  }

  private set(state: FramesState): void {
    this.state = state
    for (const l of [...this.listeners]) l()
  }
}
