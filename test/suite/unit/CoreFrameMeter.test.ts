/**
 * Fake-clock unit coverage for CoreFrameMeter: a fake frame counter and
 * vitest's fake interval timer replace the real core and wall clock, so every
 * span is exact rather than approximate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CoreFrameMeter } from '../../../theia/extension/src/browser/emulator-frame-meter'

describe('CoreFrameMeter', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reports overallFps from the frame-counter delta over the sampled window', () => {
    const meter = new CoreFrameMeter()
    let frames = 0
    meter.start(() => frames, 250)
    for (let i = 0; i < 8; i++) {
      frames += 15 // 15 frames per 250ms span = 60fps
      vi.advanceTimersByTime(250)
    }
    const stats = meter.stats()
    expect(stats.overallFps).toBeCloseTo(60, 0)
    expect(stats.frozenSpans).toBe(0)
    expect(stats.longestFrozenRun).toBe(0)
  })

  /**
   * The oracle this class exists for. An average alone would read as "a bit
   * slow" here and hide that half the window was completely dead; frozenSpans
   * and longestFrozenRun are what actually catch it.
   */
  it('separates frozenSpans/longestFrozenRun from overallFps: a freeze does not just lower the average', () => {
    const meter = new CoreFrameMeter()
    let frames = 0
    meter.start(() => frames, 250)
    for (let i = 0; i < 4; i++) {
      frames += 15
      vi.advanceTimersByTime(250)
    } // 1s healthy
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(250)
    } // 1s frozen: counter does not move

    const stats = meter.stats()
    expect(stats.frozenSpans).toBe(4)
    expect(stats.longestFrozenRun).toBe(4)
    // The average alone reads as "half speed," not "frozen half the time";
    // this is exactly why the two other fields exist.
    expect(stats.overallFps).toBeCloseTo(30, 0)
  })

  it('a single isolated frozen span is not mistaken for a sustained stall', () => {
    const meter = new CoreFrameMeter()
    let frames = 0
    meter.start(() => frames, 250)
    frames += 15
    vi.advanceTimersByTime(250)
    vi.advanceTimersByTime(250) // one frozen span: a GC/layout hiccup, not a stall
    frames += 15
    vi.advanceTimersByTime(250)
    frames += 15
    vi.advanceTimersByTime(250)

    const stats = meter.stats()
    expect(stats.frozenSpans).toBe(1)
    expect(stats.longestFrozenRun).toBe(1)
  })

  it('stop() halts sampling; frames advancing afterward are not observed', () => {
    const meter = new CoreFrameMeter()
    let frames = 0
    meter.start(() => frames, 250)
    frames += 15
    vi.advanceTimersByTime(250)
    meter.stop()
    frames += 999
    vi.advanceTimersByTime(1000)

    expect(meter.stats().samples).toBe(2) // the initial sample plus the one span before stop()
  })

  it('start() called again resets the series rather than appending to the old one', () => {
    const meter = new CoreFrameMeter()
    let frames = 0
    meter.start(() => frames, 250)
    frames += 999
    vi.advanceTimersByTime(1000)
    meter.stop()

    frames = 0
    meter.start(() => frames, 250)
    frames += 15
    vi.advanceTimersByTime(250)
    const stats = meter.stats()
    expect(stats.totalFrames).toBe(15)
  })

  it('reports zero rather than throwing with fewer than two samples', () => {
    const meter = new CoreFrameMeter()
    meter.start(() => 0, 250)
    const stats = meter.stats()
    expect(stats.samples).toBe(1)
    expect(stats.overallFps).toBe(0)
    expect(stats.frozenSpans).toBe(0)
  })
})
