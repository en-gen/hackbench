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
import * as vm from 'vm'
import {
  EmulatorDriver,
  EmscriptenModule,
} from '../../../theia/extension/src/browser/emulator-driver'
import { FakeAudioContext } from '../support/fakeAudio'

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

/**
 * Stubs URL/Blob and the page's document enough for boot() to run. The
 * core's iframe gets its OWN window (`coreWindow`) and document, and the
 * page's `window` is left empty, so a driver that loads the script into, or
 * looks EJS_Runtime or AudioContext up on, the page instead of the iframe
 * fails here rather than passing by coincidence.
 */
function stubBrowserGlobals(coreWindow: object) {
  const createdUrls: string[] = []
  const revokedUrls: string[] = []
  const scriptEls: Array<{
    onload: (() => void) | null
    onerror: (() => void) | null
    remove: () => void
  }> = []
  const frames: Array<{ removed: boolean }> = []

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
  vi.stubGlobal('window', {})

  const frameDoc = {
    createElement: vi.fn(() => {
      const el = { onload: null, onerror: null, remove: vi.fn(), src: '' }
      scriptEls.push(el)
      return el
    }),
    body: {},
    head: {
      // A blob-URL <script> resolves near-instantly in a real browser; a
      // microtask is close enough to exercise the same ordering here.
      appendChild: vi.fn((el: { onload: (() => void) | null }) => {
        queueMicrotask(() => el.onload?.())
      }),
    },
  }
  const byId = new Map<string, unknown>()
  const canvases: Array<{ removed: boolean }> = []
  const element = () => ({
    id: '',
    style: {},
    removed: false,
    remove() {
      this.removed = true
    },
    setAttribute: vi.fn(),
    appendChild: vi.fn(),
  })
  vi.stubGlobal('document', {
    getElementById: (id: string) => byId.get(id) ?? null,
    body: {
      appendChild: vi.fn((el: { id: string }) => {
        if (el.id) byId.set(el.id, el)
      }),
    },
    createElement: vi.fn((tag: string) => {
      if (tag === 'canvas') {
        const c = element()
        canvases.push(c)
        return c
      }
      if (tag !== 'iframe') return element()
      const frame = {
        ...element(),
        removed: false,
        remove() {
          this.removed = true
        },
        contentDocument: frameDoc,
        contentWindow: coreWindow,
      }
      frames.push(frame)
      return frame
    }),
  })

  return { createdUrls, revokedUrls, scriptEls, frames, canvases }
}

const screen = { appendChild: vi.fn() } as unknown as HTMLElement

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
      let resolveRuntime!: (m: EmscriptenModule) => void
      stubBrowserGlobals({
        EJS_Runtime: vi.fn(
          () =>
            new Promise<EmscriptenModule>(r => {
              resolveRuntime = r
            }),
        ),
      })

      const driver = new EmulatorDriver()
      const firstBoot = driver.boot(screen, {
        js: 'x',
        wasm: new Uint8Array(),
        rom: new Uint8Array(),
      })

      await expect(
        driver.boot(screen, { js: 'x', wasm: new Uint8Array(), rom: new Uint8Array() }),
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
      let resolveRuntime!: (m: EmscriptenModule) => void
      const { revokedUrls, frames, canvases } = stubBrowserGlobals({
        EJS_Runtime: vi.fn(
          () =>
            new Promise<EmscriptenModule>(r => {
              resolveRuntime = r
            }),
        ),
      })

      const driver = new EmulatorDriver()
      const bootPromise = driver.boot(screen, {
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
      expect(frames[0].removed, "the abandoned boot's iframe must go with it").toBe(true)
      expect(canvases[0].removed, 'and its canvas').toBe(true)
    })
  })

  /**
   * The core opens its AudioContext inside callMain (Emscripten OpenAL's
   * alcCreateContext); these fake Modules do the same, so the driver's capture
   * is exercised on the path the real core takes.
   */
  describe('audio output', () => {
    let frames: Array<{ removed: boolean }>
    let canvases: Array<{ removed: boolean }>
    /** The iframe's window: the core constructs its AudioContext from here, not the page's. */
    let win: { AudioContext: typeof FakeAudioContext }
    const coreWindow = (): { AudioContext: typeof FakeAudioContext } => win

    async function bootWith(callMain: () => void, driver = new EmulatorDriver()) {
      const core = {
        AudioContext: FakeAudioContext,
        EJS_Runtime: vi.fn(async () => fakeModule({ callMain })),
      }
      win = core
      ;({ frames, canvases } = stubBrowserGlobals(core))
      await driver.boot(screen, {
        js: 'x',
        wasm: new Uint8Array(),
        rom: new Uint8Array(),
      })
      return driver
    }
    const coreOpensAudio = (): void => {
      new (coreWindow().AudioContext)()
    }

    it('a volume set before boot applies to the output the core opens, and later changes follow', async () => {
      const driver = new EmulatorDriver()
      driver.setOutputGain(0.25)
      await bootWith(coreOpensAudio, driver)

      const out = driver.audioOutput()
      expect(out, 'the core opened a context; the driver must have captured it').not.toBeNull()
      expect(out!.master.gain.value).toBe(0.25)
      driver.setOutputGain(0)
      expect(out!.master.gain.value).toBe(0)
    })

    it('pause suspends the output, resume resumes it, dispose closes it', async () => {
      const driver = await bootWith(coreOpensAudio)
      const ctx = driver.audioOutput()!.context as unknown as FakeAudioContext

      driver.stop()
      expect(ctx.suspend).toHaveBeenCalledTimes(1)
      driver.start()
      // Twice: boot()'s own start() already resumed once.
      expect(ctx.resume).toHaveBeenCalledTimes(2)
      // Each reload boots a new core; an unclosed context per reload hits
      // the browser's cap on live AudioContexts.
      driver.dispose()
      expect(ctx.close).toHaveBeenCalledTimes(1)
      expect(driver.audioOutput()).toBeNull()
    })

    it('a core that opens no audio reports none, rather than a control that does nothing', async () => {
      const driver = await bootWith(() => {})
      expect(driver.audioOutput()).toBeNull()
      expect(() => driver.setOutputGain(0.5)).not.toThrow()
    })

    it("dispose() removes the core's iframe, which is what ends its timers and listeners", async () => {
      const driver = await bootWith(coreOpensAudio)
      expect(frames[0].removed).toBe(false)
      driver.dispose()
      expect(frames[0].removed).toBe(true)
    })

    it('each boot draws on a canvas of its own, and dispose() removes it', async () => {
      // The core hooks listeners onto its canvas and binds its GL context
      // there; a canvas reused by the next boot keeps the old core alive.
      const driver = await bootWith(coreOpensAudio)
      expect(canvases).toHaveLength(1)
      driver.dispose()
      expect(canvases[0].removed).toBe(true)
    })

    describe('save game', () => {
      /** `ignoresSave`: the core boots with blank SRAM whatever file it was given. */
      async function bootSave(savePathFromCore: string, save?: Uint8Array, ignoresSave = false) {
        const written: Array<[string, unknown]> = []
        const order: string[] = []
        const saveBytes = save && !ignoresSave ? save : new Uint8Array([1, 2, 3])
        const module = fakeModule({
          callMain: vi.fn(() => {
            order.push('callMain')
          }),
          cwrap: vi.fn(() => () => savePathFromCore),
          _cmd_savefiles: vi.fn(() => {
            order.push('flush')
          }),
        })
        module.FS.writeFile = vi.fn((path: string, data: unknown) => {
          written.push([path, data])
          order.push(`write ${path}`)
        })
        module.FS.readFile = vi.fn(() => {
          order.push('read')
          return saveBytes
        })
        stubBrowserGlobals({ EJS_Runtime: vi.fn(async () => module) })
        const driver = new EmulatorDriver()
        await driver.boot(screen, { js: 'x', wasm: new Uint8Array(), rom: new Uint8Array(), save })
        return { driver, written, order, saveBytes }
      }

      it("writes the project's save where the cfg points RetroArch, before callMain reads it", async () => {
        const save = new Uint8Array([7, 7])
        const { order, driver } = await bootSave('/hb-saves/rom.srm', save)
        expect(order.indexOf('write /hb-saves/rom.srm')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('write /hb-saves/rom.srm')).toBeLessThan(order.indexOf('callMain'))
        expect(driver.saveProblem).toBeUndefined()
      })

      it("readSave hands back this realm's Uint8Array, not the core iframe's", async () => {
        const { driver } = await bootSave('/hb-saves/rom.srm')
        const foreign = vm.runInNewContext('new Uint8Array([4, 5, 6])') as Uint8Array
        expect(foreign instanceof Uint8Array, 'the fixture must really be cross-realm').toBe(false)
        ;(driver as unknown as { module: EmscriptenModule }).module.FS.readFile = () => foreign
        const out = driver.readSave()
        // Theia's RPC encoder tells typed arrays apart with instanceof; a
        // foreign one crossed the wire as a 0-byte save.
        expect(out instanceof Uint8Array).toBe(true)
        expect(Array.from(out!)).toEqual([4, 5, 6])
      })

      it('readSave flushes the core before reading, so it never returns a stale file', async () => {
        const { driver, order, saveBytes } = await bootSave('/hb-saves/rom.srm')
        order.length = 0
        expect(driver.readSave()).toEqual(saveBytes)
        expect(order).toEqual(['flush', 'read'])
      })

      it('a save the core silently did not load is reported, so blank SRAM never overwrites it', async () => {
        const { driver } = await bootSave('/hb-saves/rom.srm', new Uint8Array([9, 9]), true)
        expect(driver.saveProblem).toMatch(/did not load/)
        expect(driver.readSave(), 'nothing to write back over the real save').toBeUndefined()
      })

      it('a core keeping its save elsewhere is reported, and saving is off rather than wrong', async () => {
        const { driver } = await bootSave('/somewhere/else.srm', new Uint8Array([1]))
        expect(driver.saveProblem).toMatch(/\/somewhere\/else\.srm/)
        expect(driver.readSave()).toBeUndefined()
      })
    })

    it('a core that aborts after opening audio restores the global and closes its context', async () => {
      let opened: FakeAudioContext | undefined
      await expect(
        bootWith(() => {
          opened = new (coreWindow().AudioContext)() as unknown as FakeAudioContext
          throw new Error('core aborted')
        }),
      ).rejects.toThrow('core aborted')
      expect(coreWindow().AudioContext).toBe(FakeAudioContext)
      expect(opened!.close).toHaveBeenCalledTimes(1)
      expect(frames[0].removed, 'a failed boot must not leave its iframe behind').toBe(true)
      expect(canvases[0].removed, 'nor its canvas').toBe(true)
    })
  })
})
