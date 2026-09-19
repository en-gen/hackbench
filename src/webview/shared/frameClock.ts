/**
 * One shared clock per webview bundle, counting GAME FRAMES.
 *
 * Replaces the per-consumer millisecond timers this folder used to export.
 * Those re-based to the rAF boundary (`lastTickMs = now`), so every realised
 * period rounded up to the display's refresh interval. The worst-hit
 * consumer was the 67 ms palette cycle, realised as 83.3 ms at 60 Hz, a
 * quarter slow; the 125 ms sprite interval realised as 133.3 ms (8.0
 * frames) at 60 Hz where 7.5 was intended. The editor
 * animated at a rate set by the user's monitor.
 *
 * Here the clock accumulates elapsed frames once and every consumer derives
 * its tick from that single counter. Two consequences, both wanted:
 * consumers on the same cadence are phase-locked no matter when they
 * started, and the realised cadence in game frames is independent of the
 * refresh rate.
 *
 * Phase lock is a fidelity fix for tile animation and palette cycling, which
 * both derive from `EffFrame` in game (`SMWDisX bank_05.asm:4396-4398` and
 * `bank_00.asm:4668-4673`). It is not one for sprite walk cycles, whose
 * counter is seeded by `GetRand` at spawn (`SMWDisX bank_01.asm:844-846`) and
 * so is randomly phased in game; for those only the rate matters.
 *
 * Driven by requestAnimationFrame so hidden webviews stop ticking: Chromium
 * throttles rAF to 0 Hz in hidden iframes but leaves setInterval at >= 1 Hz.
 */

import { SNES_NTSC_FPS } from '../../rom/timing'

/**
 * Most frames one rAF may advance the clock. A resumed background tab
 * reports a gap of seconds; without this it would burst every consumer
 * through hundreds of ticks. The clock is a cadence source, not a
 * wall-clock, so dropping that time is deliberate: consumers resume in
 * phase rather than racing to catch up.
 *
 * Sixteen, not four. Four absorbed only a 66 ms gap, and this repo's own
 * scroll-playback comment records busy levels rendering at about 100 ms
 * per frame (`mapEditor/main.ts`), which owes 6. The clamp must sit above
 * any plausible single-frame render hitch, or it silently becomes the
 * thing that slows animation on exactly the levels that are already slow.
 * Sixteen is 266 ms, well past that and still far short of a tab resume.
 *
 * Note this differs from scroll playback in the same bundle, which uses
 * unclamped wall clock and bursts to catch up after a resume. That is the
 * right policy there: scroll playback is a transport with a position the
 * user scrubs, so it owes them elapsed time. This clock is a free-running
 * cadence with no position to be wrong about.
 */
export const MAX_CATCHUP_FRAMES = 16

/** Same surface the millisecond timers had, so call sites change one line. */
export interface FrameSubscription {
  start(): void
  stop(): void
  suspend(): void
  resume(): void
  readonly running: boolean
}

export interface FrameClock {
  /** Frames elapsed since the clock started counting. */
  readonly frame: number
  /**
   * Tick `onTick` once per `getFrames()` game frames. Re-read on every pump
   * so a consumer can change cadence without resubscribing.
   */
  every(getFrames: () => number, onTick: () => void): FrameSubscription
}

/** Injected for tests; production uses the browser's rAF and clock. */
export interface ClockHost {
  now(): number
  requestFrame(cb: (nowMs: number) => void): number
  cancelFrame(id: number): void
}

const browserHost: ClockHost = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(cb),
  cancelFrame: (id) => cancelAnimationFrame(id),
}

interface Sub extends FrameSubscription {
  check(frame: number): void
}

export function createFrameClock(host: ClockHost = browserHost): FrameClock {
  let frame = 0
  let fracFrames = 0
  let lastMs: number | null = null
  let rafId: number | null = null
  let suspended = false
  const subs = new Set<Sub>()

  function anyRunning(): boolean {
    for (const s of subs) if (s.running) return true
    return false
  }

  /**
   * `lastMs` is seeded ONLY on a cold start, never on the steady-state
   * reschedule out of `pump`. Re-reading the clock there would measure
   * from the end of the previous callback, silently discarding both the
   * frame-start-to-callback latency and every synchronous tick, which is
   * the re-basing defect this clock exists to remove. On the hot path
   * elapsed time comes from rAF timestamps, which are also monotonic.
   */
  function schedule(): void {
    if (rafId !== null || suspended || !anyRunning()) return
    if (lastMs === null) lastMs = host.now()
    rafId = host.requestFrame(pump)
  }

  function unschedule(): void {
    if (rafId === null) return
    host.cancelFrame(rafId)
    rafId = null
  }

  function pump(nowMs: number): void {
    rafId = null
    const owed = ((nowMs - (lastMs ?? nowMs)) * SNES_NTSC_FPS) / 1000 + fracFrames
    lastMs = nowMs
    // A rAF timestamp can precede a now() seeded at cold start, so `owed`
    // can be negative. Floor at zero: the frame counter must never run
    // backwards, or a consumer re-crosses a boundary it already fired on.
    const whole = Math.max(0, Math.floor(owed))
    fracFrames = Math.max(0, owed - whole)
    frame += Math.min(whole, MAX_CATCHUP_FRAMES)
    for (const s of subs) s.check(frame)
    schedule()
  }

  function every(getFrames: () => number, onTick: () => void): FrameSubscription {
    let running = false
    let lastBoundary = 0
    const boundaryAt = (f: number): number => Math.floor(f / Math.max(1, getFrames()))
    const sub: Sub = {
      check(f) {
        if (!running) return
        const b = boundaryAt(f)
        if (b === lastBoundary) return
        lastBoundary = b
        onTick()
      },
      start() { running = true; lastBoundary = boundaryAt(frame); schedule() },
      stop() { running = false; if (!anyRunning()) unschedule() },
      suspend() { suspended = true; unschedule() },
      resume() { suspended = false; schedule() },
      get running() { return running },
    }
    subs.add(sub)
    return sub
  }

  return {
    get frame() { return frame },
    every,
  }
}

/** The bundle's clock. One per webview document; they are separate pages. */
export const frameClock = createFrameClock()
