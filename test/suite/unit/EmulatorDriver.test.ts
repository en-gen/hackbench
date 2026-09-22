/**
 * Fake-rAF, fake-Module unit coverage for EmulatorDriver's concurrency
 * guards: the tick generation token, stop()'s bump of it, start()'s
 * re-entrancy guard, boot()'s re-entrancy guard, and bootGeneration across a
 * dispose-mid-boot race.
 *
 * boot() touches document/URL/Blob/window.EJS_Runtime, none of which exist
 * under vitest's node environment, so this file stubs exactly those globals
 * rather than pulling in a DOM library for one test file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  EmulatorDriver,
  EmscriptenModule,
} from '../../../theia/extension/src/browser/emulator-driver'

/** Manually stepped, not time-based: gives each test exact control over which queued tick fires when. */
function fakeRaf() {
  let queue: Array<(t: number) => void> = []
  const raf = (cb: (t: number) => void): number => {
    queue.push(cb)
    return queue.length
  }
  const flush = (times = 1): void => {
    for (let i = 0; i < times; i++) {
      const current = queue
      queue = []
      for (const cb of current) cb(0)
    }
  }
  const pending = (): number => queue.length
  return { raf, flush, pending }
}

function fakeModule(overrides: Partial<EmscriptenModule> = {}): EmscriptenModule {
  let frame = 0
  return {
    FS: { mkdir: vi.fn(), writeFile: vi.fn(), readFile: vi.fn(), unlink: vi.fn(), stat: vi.fn() },
    callMain: vi.fn(),
    resumeMainLoop: vi.fn(),
    pauseMainLoop: vi.fn(),
    _get_current_frame_count: () => ++frame,
    _cmd_take_screenshot: vi.fn(),
    ...overrides,
  }
}

class FakeBlob {
  constructor(
    public parts: unknown[],
    public opts?: { type?: string },
  ) {}
}

/** Stubs document/URL/Blob/window enough for loadCoreScript()+boot() to run. */
function stubBrowserGlobals() {
  const createdUrls: string[] = []
  const revokedUrls: string[] = []
  const scriptEls: Array<{
    onload: (() => void) | null
    onerror: (() => void) | null
    remove: () => void
  }> = []

  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => {
      const u = `blob:fake-${createdUrls.length}`
      createdUrls.push(u)
      return u
    }),
    revokeObjectURL: vi.fn((u: string) => {
      revokedUrls.push(u)
    }),
  })
  vi.stubGlobal('Blob', FakeBlob)
  vi.stubGlobal('document', {
    createElement: vi.fn(() => {
      const el = { onload: null, onerror: null, remove: vi.fn(), src: '' }
      scriptEls.push(el)
      return el
    }),
    head: {
      // A blob-URL <script> resolves near-instantly in a real browser; a
      // microtask is close enough to exercise the same ordering here.
      appendChild: vi.fn((el: { onload: (() => void) | null }) => {
        queueMicrotask(() => el.onload?.())
      }),
    },
  })

  return { createdUrls, revokedUrls, scriptEls }
}

describe('EmulatorDriver', () => {
  let raf: ReturnType<typeof fakeRaf>

  beforeEach(() => {
    raf = fakeRaf()
    vi.stubGlobal('requestAnimationFrame', raf.raf)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Bypasses boot() entirely: sets the private `module` field the same way TS privacy allows at runtime. */
  function driverWithModule(module: EmscriptenModule): EmulatorDriver {
    const driver = new EmulatorDriver()
    ;(driver as unknown as { module: EmscriptenModule }).module = module
    return driver
  }

  it('tick() generation check: a stop() after a tick is queued kills it before the next increment', () => {
    const driver = driverWithModule(fakeModule())
    driver.start()
    raf.flush(1)
    expect(driver.pumpTicks).toBe(1)

    driver.stop() // bumps generation; the already-queued-by-tick-1 callback must see it
    raf.flush(1)
    expect(driver.pumpTicks, 'a tick queued before stop() must not count after it').toBe(1)
  })

  /**
   * stop() flips `running` but a missing generation bump would let the loop
   * keep ticking in the "stopped" window, which is the only place it shows.
   */
  it("stop()'s generation bump specifically: no ticks accrue after stop(), across several flushes", () => {
    const driver = driverWithModule(fakeModule())
    driver.start()
    raf.flush(3)
    const beforeStop = driver.pumpTicks
    expect(beforeStop).toBe(3)

    driver.stop()
    raf.flush(5)
    expect(driver.pumpTicks, 'ticks must not accrue once stopped').toBe(beforeStop)
  })

  it('start() re-entrancy: calling it twice in a row does not resume twice or queue a second loop', () => {
    const module = fakeModule()
    const driver = driverWithModule(module)
    driver.start()
    driver.start()
    expect(module.resumeMainLoop).toHaveBeenCalledTimes(1)
    expect(raf.pending()).toBe(1)
  })

  it('start()/stop()/start() ticks at the same rate both times: no leaked loop across a real restart', () => {
    const driver = driverWithModule(fakeModule())
    driver.start()
    raf.flush(5)
    const firstRun = driver.pumpTicks
    expect(firstRun).toBe(5)

    driver.stop()
    driver.start()
    raf.flush(5)
    // Exactly 5 more, not 10: a leaked loop from the first start would double this.
    expect(driver.pumpTicks - firstRun).toBe(5)
  })

  it('dispose() invalidates the loop and clears the module', () => {
    const module = fakeModule()
    const driver = driverWithModule(module)
    driver.start()
    raf.flush(1)
    driver.dispose()
    raf.flush(3)

    expect(driver.pumpTicks).toBe(1)
    expect(driver.isBooted()).toBe(false)
    expect(module.pauseMainLoop).toHaveBeenCalled()
  })

  describe('boot()', () => {
    it('rejects a second concurrent boot() while the first is still in flight', async () => {
      stubBrowserGlobals()
      let resolveRuntime!: (m: EmscriptenModule) => void
      vi.stubGlobal('window', {
        EJS_Runtime: vi.fn(
          () =>
            new Promise<EmscriptenModule>(r => {
              resolveRuntime = r
            }),
        ),
      })

      const driver = new EmulatorDriver()
      const canvas = {} as HTMLCanvasElement
      const firstBoot = driver.boot(canvas, {
        js: 'x',
        wasm: new Uint8Array(),
        rom: new Uint8Array(),
      })

      await expect(
        driver.boot(canvas, { js: 'x', wasm: new Uint8Array(), rom: new Uint8Array() }),
      ).rejects.toThrow(/already booted or booting/)

      resolveRuntime(fakeModule())
      await firstBoot
      expect(driver.isBooted()).toBe(true)
    })

    /**
     * bootGeneration: a project switch mid-boot calls dispose() before the
     * Emscripten factory resolves. Without the generation check, boot() would
     * land afterward and commit a Module for a canvas the current render no
     * longer shows -- the exact "confidently wrong and looks right" shape.
     */
    it('a dispose() while EJS_Runtime is still resolving prevents the boot from committing a module', async () => {
      const { revokedUrls } = stubBrowserGlobals()
      let resolveRuntime!: (m: EmscriptenModule) => void
      vi.stubGlobal('window', {
        EJS_Runtime: vi.fn(
          () =>
            new Promise<EmscriptenModule>(r => {
              resolveRuntime = r
            }),
        ),
      })

      const driver = new EmulatorDriver()
      const canvas = {} as HTMLCanvasElement
      const bootPromise = driver.boot(canvas, {
        js: 'x',
        wasm: new Uint8Array(),
        rom: new Uint8Array(),
      })

      // Let boot() actually reach its `await EJS_Runtime(...)` call (it is
      // gated behind loadCoreScript's own microtask-resolved <script> load)
      // before disposing mid-flight.
      await new Promise(r => setTimeout(r, 0))
      driver.dispose() // fires while EJS_Runtime's promise is still pending
      resolveRuntime(fakeModule())
      await bootPromise

      expect(driver.isBooted()).toBe(false)
      expect(
        revokedUrls.length,
        'the wasm blob URL created for the abandoned boot must be revoked',
      ).toBeGreaterThan(0)
    })
  })
})
