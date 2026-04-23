/**
 * Shared rAF-based interval timer for animation loops in webview bundles.
 *
 * Uses requestAnimationFrame rather than setInterval so Chromium's tab
 * throttling automatically pauses the loop in hidden iframes. The
 * suspend()/resume() pair lets callers pause the rAF without clearing
 * the logical running state (used by visibility-change handlers that want
 * to resume the user's prior play/pause intent when a tab becomes visible).
 */

export interface RafTimer {
  /** Set running = true and start the rAF loop. */
  start(): void
  /** Set running = false and cancel the rAF loop. */
  stop(): void
  /** Cancel the rAF loop without changing the running state. */
  suspend(): void
  /** Restart the rAF loop if running is true. */
  resume(): void
  readonly running: boolean
}

/**
 * Create a timer that calls `onTick` at the interval returned by
 * `getIntervalMs` using requestAnimationFrame.
 *
 * `getIntervalMs` is evaluated on every potential tick so callers can
 * change the interval between start() calls without recreating the timer.
 */
export function createRafTimer(
  getIntervalMs: () => number,
  onTick: () => void,
): RafTimer {
  let rafId: number | null = null
  let lastTickMs = 0
  let _running = false

  function tick(now: number): void {
    if (!_running) return
    if (now - lastTickMs >= getIntervalMs()) {
      onTick()
      lastTickMs = now
    }
    rafId = requestAnimationFrame(tick)
  }

  return {
    start() {
      if (rafId !== null) cancelAnimationFrame(rafId)
      _running = true
      lastTickMs = performance.now()
      rafId = requestAnimationFrame(tick)
    },
    stop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      _running = false
    },
    suspend() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
    },
    resume() {
      if (!_running || rafId !== null) return
      lastTickMs = performance.now()
      rafId = requestAnimationFrame(tick)
    },
    get running() { return _running },
  }
}
