import { describe, it, expect } from 'vitest'
import {
  createFrameClock,
  MAX_CATCHUP_FRAMES,
  type ClockHost,
} from '../../../src/webview/shared/frameClock'
import { SNES_NTSC_FPS, msToFrames, framesToMs } from '../../../src/rom/timing'

/**
 * Refresh rates to sweep. The first defect fixed here was that the realised
 * cadence depended on which of these the user's monitor ran at.
 */
const REFRESH_HZ = [60, 75, 120, 144]

interface FakeHost extends ClockHost {
  /** Fire `frames` rAF callbacks on the refresh grid. */
  run(frames: number): void
  /** Fire one callback with an arbitrary timestamp, leaving now() alone. */
  fireAt(timestampMs: number): void
  /** Spend wall-clock time without a callback, as synchronous work does. */
  burn(ms: number): void
  /** Timestamp handed to the most recent callback. */
  readonly lastTimestampMs: number
}

/**
 * A rAF host whose `now()` is INDEPENDENT of the timestamp it passes.
 *
 * That independence is the point. A host returning the timestamp from
 * `now()` cannot see a clock measuring from the end of its own callbacks
 * rather than from the frame start, which is what this clock first did.
 *
 * `latencyMs` is the frame-start to callback delay the browser adds. Work
 * done inside `onTick` is modelled by the consumer calling `burn`.
 * Overrunning the refresh interval drops frames, as it does in a browser.
 */
function fakeHost(hz: number, latencyMs = 0): FakeHost {
  const stepMs = 1000 / hz
  let wallMs = 0
  let vsyncIdx = 0
  let lastTimestampMs = 0
  let pending: ((n: number) => void) | null = null
  return {
    now: () => wallMs,
    requestFrame(cb) {
      pending = cb
      return 1
    },
    cancelFrame() {
      pending = null
    },
    get lastTimestampMs() {
      return lastTimestampMs
    },
    burn(ms) {
      wallMs += ms
    },
    run(frames) {
      for (let i = 0; i < frames; i++) {
        while (vsyncIdx * stepMs < wallMs) vsyncIdx++
        const vsync = vsyncIdx * stepMs
        vsyncIdx++
        wallMs = vsync + latencyMs
        lastTimestampMs = vsync
        const cb = pending
        pending = null
        cb?.(vsync)
      }
    },
    fireAt(timestampMs) {
      lastTimestampMs = timestampMs
      const cb = pending
      pending = null
      cb?.(timestampMs)
    },
  }
}

function gaps(xs: number[]): number[] {
  return xs.slice(1).map((x, i) => x - xs[i]!)
}

// ── Conversions ─────────────────────────────────────────────────────────────

describe('timing conversions', () => {
  it('does not fall into the divide-then-multiply float trap', () => {
    expect(125 / (1000 / 60)).toBe(7.499999999999999)
    expect(Math.floor(125 / (1000 / 60))).toBe(7)
    expect(msToFrames(125)).toBe(8)
  })

  it('round-trips the two cited game-frame cadences', () => {
    // 8 frames: the EffFrame & $18 select, SMWDisX bank_05.asm:4396-4398.
    expect(Math.round(framesToMs(8))).toBe(133)
    expect(msToFrames(133)).toBe(8)
    // 4 frames: (EffFrame & $1C) >> 1, SMWDisX bank_00.asm:4668-4673.
    expect(Math.round(framesToMs(4))).toBe(67)
    expect(msToFrames(67)).toBe(4)
  })

  it('never returns a zero cadence', () => {
    expect(msToFrames(0)).toBe(1)
    expect(msToFrames(1)).toBe(1)
  })
})

// ── Refresh-rate independence ───────────────────────────────────────────────

/**
 * The check the sweep makes, factored out so the oracle can run it too.
 *
 * The oracle runs it over the same clock measurements the sweep asserts
 * on, and over the re-basing algorithm's measurements, and requires it to
 * accept one and reject the other. Weakening this function therefore
 * fails the oracle, not only the sweep.
 */
function assertCadenceIndependentOfRefreshRate(
  realised: Map<number, number[]>,
  cadence: number,
): void {
  expect(realised.size, 'a sweep needs more than one refresh rate').toBeGreaterThan(2)
  for (const [hz, g] of realised) {
    expect(g.length, `${hz} Hz gave too few ticks to judge`).toBeGreaterThan(5)
    expect(g, `${hz} Hz`).toEqual(g.map(() => cadence))
  }
}

/** Gaps, in game frames, between consecutive ticks of one consumer. */
function measureClock(cadence: number, latencyMs = 0): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const hz of REFRESH_HZ) {
    const host = fakeHost(hz, latencyMs)
    const clock = createFrameClock(host)
    const at: number[] = []
    clock
      .every(
        () => cadence,
        () => at.push(clock.frame),
      )
      .start()
    host.run(Math.round(hz * 2)) // two seconds of wall clock
    out.set(hz, gaps(at))
  }
  return out
}

/** The same measurement for the re-basing timer this clock replaces. */
function measureRebasing(intervalMs: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const hz of REFRESH_HZ) {
    const stepMs = 1000 / hz
    let last = 0
    const at: number[] = []
    for (let i = 1; i <= Math.round(hz * 2); i++) {
      const now = i * stepMs
      if (now - last >= intervalMs) {
        at.push((now * SNES_NTSC_FPS) / 1000)
        last = now
      }
    }
    out.set(hz, gaps(at))
  }
  return out
}

describe('cadence is independent of refresh rate', () => {
  for (const cadence of [4, 8]) {
    it(`realises ${cadence} game frames per tick at every refresh rate`, () => {
      assertCadenceIndependentOfRefreshRate(measureClock(cadence), cadence)
    })

    it(`still realises ${cadence} with 2 ms of callback latency`, () => {
      assertCadenceIndependentOfRefreshRate(measureClock(cadence, 2), cadence)
    })
  }

  it('realises the same tick count at every refresh rate', () => {
    const counts = REFRESH_HZ.map(hz => {
      const host = fakeHost(hz)
      const clock = createFrameClock(host)
      let n = 0
      clock
        .every(
          () => 8,
          () => {
            n++
          },
        )
        .start()
      host.run(Math.round(hz * 2))
      return n
    })
    expect(new Set(counts).size, `counts were ${counts.join(', ')}`).toBe(1)
  })
})

/**
 * The planted defect, coupled to the sweep.
 *
 * It runs the sweep's own checker over the sweep's own clock data and over
 * the re-basing algorithm's data, requiring the checker to accept one and
 * reject the other. Weakening the checker fails this block.
 */
describe('oracle: the re-basing timer this replaces', () => {
  it('the sweep checker accepts the clock and rejects re-basing', () => {
    const clockData = measureClock(8)
    const rebasedData = measureRebasing(125)
    expect(() => assertCadenceIndependentOfRefreshRate(clockData, 8)).not.toThrow()
    expect(() => assertCadenceIndependentOfRefreshRate(rebasedData, 8)).toThrow()
  })

  it('re-basing quantises 125 ms to 8.01 frames at 60 Hz and 7.51 at 144 Hz', () => {
    const data = measureRebasing(125)
    for (const x of data.get(60)!) expect(x).toBeCloseTo(8.013, 2) // 133.3 ms
    for (const x of data.get(144)!) expect(x).toBeCloseTo(7.512, 2) // 125.0 ms
  })
})

// ── Wall-clock tracking ─────────────────────────────────────────────────────

/**
 * The second defect. The clock re-read `now()` after running every
 * subscriber callback, so each period measured from the END of the
 * previous pump's work: it discarded the frame-start to callback latency
 * and the whole synchronous tick, which in the map editor includes the
 * render, because the tick drives a plain effect() with no scheduler.
 *
 * A tick-gap assertion cannot see this. The frame counter stays
 * self-consistent while falling behind the wall clock, so only a
 * comparison against wall clock catches it.
 */
function frameTrackingRatio(hz: number, latencyMs: number, tickCostMs: number): number {
  const host = fakeHost(hz, latencyMs)
  const clock = createFrameClock(host)
  let ticks = 0
  clock
    .every(
      () => 8,
      () => {
        ticks++
        if (tickCostMs > 0) host.burn(tickCostMs)
      },
    )
    .start()
  while (host.lastTimestampMs < 2000) host.run(1)
  const expected = (host.lastTimestampMs * SNES_NTSC_FPS) / 1000
  expect(ticks).toBeGreaterThan(5)
  return clock.frame / expected
}

describe('the clock tracks wall clock, not the end of its own callbacks', () => {
  for (const hz of REFRESH_HZ) {
    it(`stays within 2 percent of wall clock at ${hz} Hz with callback latency`, () => {
      const ratio = frameTrackingRatio(hz, 2, 0)
      expect(ratio, `realised ${(ratio * 100).toFixed(1)} percent of wall clock`).toBeGreaterThan(
        0.98,
      )
      expect(ratio).toBeLessThan(1.02)
    })

    it(`stays within 2 percent of wall clock at ${hz} Hz with a 30 ms tick`, () => {
      const ratio = frameTrackingRatio(hz, 2, 30)
      expect(ratio, `realised ${(ratio * 100).toFixed(1)} percent of wall clock`).toBeGreaterThan(
        0.98,
      )
      expect(ratio).toBeLessThan(1.02)
    })
  }

  it('loses no more to a slow render than to an idle one', () => {
    // A busy level renders at about 100 ms per frame, per the note at
    // mapEditor/main.ts:4195-4206.
    const idle = frameTrackingRatio(60, 2, 0)
    const busy = frameTrackingRatio(60, 2, 100)
    expect(Math.abs(idle - busy), `idle ${idle}, busy ${busy}`).toBeLessThan(0.02)
  })
})

// ── Monotonicity ────────────────────────────────────────────────────────────

describe('the frame counter never runs backwards', () => {
  it('ignores a timestamp that precedes the previous one', () => {
    const host = fakeHost(60, 2)
    const clock = createFrameClock(host)
    const seen: number[] = []
    clock
      .every(
        () => 8,
        () => seen.push(clock.frame),
      )
      .start()
    host.run(10)
    const before = clock.frame
    // rAF timestamps can precede a now() taken at the end of the previous
    // pump: 1 such event in 181 idle pumps, measured in real Chromium.
    host.fireAt(host.lastTimestampMs - 5)
    expect(clock.frame).toBeGreaterThanOrEqual(before)
    host.run(20)
    expect(gaps(seen).every(g => g > 0)).toBe(true)
  })

  it('never decrements however far a timestamp goes back', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    clock
      .every(
        () => 8,
        () => {},
      )
      .start()
    host.run(30)
    const before = clock.frame
    host.fireAt(0)
    expect(clock.frame).toBe(before)
  })
})

// ── Phase lock ──────────────────────────────────────────────────────────────

describe('phase lock', () => {
  it('holds two consumers on the same cadence together whenever they start', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    const a: number[] = []
    const b: number[] = []
    const subA = clock.every(
      () => 8,
      () => a.push(clock.frame),
    )
    const subB = clock.every(
      () => 8,
      () => b.push(clock.frame),
    )
    subA.start()
    host.run(3) // B starts mid-period, as palette does on load
    subB.start()
    host.run(120)
    expect(b.length).toBeGreaterThan(10)
    expect(b.every(f => a.includes(f))).toBe(true)
    expect(a.every(f => f % 8 === 0)).toBe(true)
  })

  it('keeps 4-frame palette ticks aligned with 8-frame tile ticks', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    const tiles: number[] = []
    const pal: number[] = []
    clock
      .every(
        () => 8,
        () => tiles.push(clock.frame),
      )
      .start()
    clock
      .every(
        () => 4,
        () => pal.push(clock.frame),
      )
      .start()
    host.run(120)
    expect(tiles.length).toBeGreaterThan(5)
    for (const f of tiles) expect(pal).toContain(f)
  })
})

// ── Catch-up ────────────────────────────────────────────────────────────────

describe('catch-up', () => {
  it('absorbs a slow render rather than pacing itself by it', () => {
    // Real-time pacing, the policy tickScrollPlayback documents at
    // mapEditor/main.ts:4195-4206: jump frames when the render is slow.
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    clock
      .every(
        () => 8,
        () => {},
      )
      .start()
    host.burn(100) // one 100 ms render
    host.run(1)
    expect(clock.frame).toBe(Math.floor((host.lastTimestampMs * SNES_NTSC_FPS) / 1000))
    expect(clock.frame).toBeGreaterThan(5)
  })

  it('clamps above any plausible render hitch, not below it', () => {
    // A 100 ms frame owes 6. The clamp must not be what stops it.
    expect(MAX_CATCHUP_FRAMES).toBeGreaterThan(msToFrames(100))
  })

  it('does not burst when a backgrounded tab resumes after ten seconds', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let ticks = 0
    clock
      .every(
        () => 8,
        () => {
          ticks++
        },
      )
      .start()
    host.run(4)
    const before = clock.frame
    host.burn(10_000)
    host.run(1)
    expect(clock.frame - before).toBeLessThanOrEqual(MAX_CATCHUP_FRAMES)
    expect(ticks).toBeLessThanOrEqual(1)
  })
})

// ── Held frame ──────────────────────────────────────────────────────────────

// ── Lifecycle ───────────────────────────────────────────────────────────────

describe('subscription lifecycle', () => {
  it('reports running state and stops ticking on stop', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let ticks = 0
    const sub = clock.every(
      () => 4,
      () => {
        ticks++
      },
    )
    expect(sub.running).toBe(false)
    host.run(30)
    expect(ticks).toBe(0)
    sub.start()
    expect(sub.running).toBe(true)
    host.run(30)
    const whileRunning = ticks
    expect(whileRunning).toBeGreaterThan(0)
    sub.stop()
    expect(sub.running).toBe(false)
    host.run(30)
    expect(ticks).toBe(whileRunning)
  })

  it('stops ONE consumer while another keeps the clock running', () => {
    // togglePalAnim stops the palette subscription while the sprite one
    // runs on. A single-subscription stop test passes even if `check`
    // ignores `running`, because the clock unschedules when its last
    // subscription stops.
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let stopped = 0
    let kept = 0
    const a = clock.every(
      () => 4,
      () => {
        stopped++
      },
    )
    const b = clock.every(
      () => 4,
      () => {
        kept++
      },
    )
    a.start()
    b.start()
    host.run(20)
    expect(stopped).toBeGreaterThan(0)
    const frozen = stopped
    const keptSoFar = kept
    a.stop()
    host.run(40)
    expect(stopped).toBe(frozen)
    expect(kept).toBeGreaterThan(keptSoFar)
  })

  it('resumes after suspend without changing running state', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let ticks = 0
    const sub = clock.every(
      () => 4,
      () => {
        ticks++
      },
    )
    sub.start()
    host.run(20)
    const before = ticks
    sub.suspend()
    expect(sub.running).toBe(true)
    host.run(20)
    expect(ticks).toBe(before)
    sub.resume()
    host.run(20)
    expect(ticks).toBeGreaterThan(before)
  })

  it('does not schedule a rAF when start() is called while suspended', () => {
    // The zombie-webview contention path: a hidden webview must not get a
    // rAF loop because something called start() while it was hidden.
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let ticks = 0
    const keeper = clock.every(
      () => 4,
      () => {},
    )
    keeper.suspend() // clock-level suspend, tab hidden
    const late = clock.every(
      () => 4,
      () => {
        ticks++
      },
    )
    late.start()
    host.run(40)
    expect(ticks).toBe(0)
    late.resume()
    host.run(40)
    expect(ticks).toBeGreaterThan(0)
  })

  it('does not tick a suspended clock even for a running consumer', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let ticks = 0
    clock
      .every(
        () => 4,
        () => {
          ticks++
        },
      )
      .start()
    host.run(1)
    const other = clock.every(
      () => 4,
      () => {},
    )
    other.suspend()
    const before = ticks
    host.run(40)
    expect(ticks).toBe(before)
  })
})

describe('lifecycle, with more than one subscription', () => {
  it('a stopped subscription stops while another keeps the clock running', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let a = 0,
      b = 0
    const subA = clock.every(
      () => 8,
      () => {
        a++
      },
    )
    const subB = clock.every(
      () => 8,
      () => {
        b++
      },
    )
    subA.start()
    subB.start()
    host.run(40)
    const aAtStop = a
    // Only meaningful with a second subscription holding the clock up: with
    // one, the whole clock unschedules and a stopped sub cannot tick anyway.
    subA.stop()
    host.run(40)
    expect(a, 'stopped subscription kept ticking').toBe(aAtStop)
    expect(b, 'running subscription should have advanced').toBeGreaterThan(aAtStop)
  })

  it('start() while suspended does not schedule a frame', () => {
    const host = fakeHost(60)
    const clock = createFrameClock(host)
    let n = 0
    const sub = clock.every(
      () => 8,
      () => {
        n++
      },
    )
    // suspend/resume are per-subscription but the suspended flag is
    // clock-global, which is the semantic this pins.
    sub.suspend()
    sub.start()
    host.run(40)
    expect(n, 'a suspended clock scheduled a rAF in a hidden webview').toBe(0)
    sub.resume()
    host.run(40)
    expect(n).toBeGreaterThan(0)
  })
})
