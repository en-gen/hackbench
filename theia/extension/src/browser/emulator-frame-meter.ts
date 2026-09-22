/**
 * True emulated framerate, sampled from the core's own frame counter rather
 * than requestAnimationFrame, which ticks at display rate whether or not the
 * core itself advances.
 *
 * The series is kept, not just an average, because "fast, then frozen" is the
 * failure this exists to catch and an average over the whole window hides it.
 */
export interface FrameSample {
  tMs: number
  frames: number
}

export interface FrameMeterStats {
  samples: number
  totalFrames: number
  overallFps: number
  /** Per-sampling-interval fps; a value near 0 means the counter did not move. */
  spanFps: number[]
  /** Count of spans where the counter did not move. Zero on a healthy run. */
  frozenSpans: number
  /**
   * The longest RUN of consecutive frozen spans. A single isolated frozen
   * span can be a GC or layout hiccup shared with the main thread; a real
   * stall shows as several in a row, which is what this distinguishes.
   */
  longestFrozenRun: number
}

export class CoreFrameMeter {
  private series: FrameSample[] = []
  private timer = 0

  start(read: () => number, intervalMs = 250): void {
    this.stop()
    const t0 = performance.now()
    this.series = [{ tMs: 0, frames: read() }]
    this.timer = window.setInterval(() => {
      this.series.push({ tMs: Math.round(performance.now() - t0), frames: read() })
    }, intervalMs)
  }

  stop(): void {
    if (this.timer) {
      window.clearInterval(this.timer)
      this.timer = 0
    }
  }

  stats(): FrameMeterStats {
    const s = this.series
    if (s.length < 2) {
      return {
        samples: s.length,
        totalFrames: 0,
        overallFps: 0,
        spanFps: [],
        frozenSpans: 0,
        longestFrozenRun: 0,
      }
    }

    const spanFps: number[] = []
    for (let i = 1; i < s.length; i++) {
      const dt = s[i].tMs - s[i - 1].tMs
      spanFps.push(dt > 0 ? ((s[i].frames - s[i - 1].frames) * 1000) / dt : 0)
    }
    const first = s[0]
    const last = s[s.length - 1]
    const overall =
      last.tMs > first.tMs ? ((last.frames - first.frames) * 1000) / (last.tMs - first.tMs) : 0

    // A span where the counter does not move at all is a freeze, not slowness.
    const frozen = spanFps.map(f => f < 1)
    let longestFrozenRun = 0
    let run = 0
    for (const f of frozen) {
      run = f ? run + 1 : 0
      longestFrozenRun = Math.max(longestFrozenRun, run)
    }

    return {
      samples: s.length,
      totalFrames: last.frames - first.frames,
      overallFps: +overall.toFixed(1),
      spanFps: spanFps.map(f => +f.toFixed(1)),
      frozenSpans: frozen.filter(Boolean).length,
      longestFrozenRun,
    }
  }
}
