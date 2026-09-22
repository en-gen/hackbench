/**
 * Drives the libretro core's Emscripten module directly. No player wrapper:
 * every call below is a call onto Module itself -- FS, callMain,
 * resumeMainLoop/pauseMainLoop -- the same shape as
 * src/webview/emulatorPreview/main.ts's boot(), because this widget needs the
 * same direct access, not a black box that boots and hides it.
 *
 * The core's own build (vendor/cores/snes9x-wasm) exposes no per-frame C step
 * function, only Emscripten's internal main loop toggled by
 * resumeMainLoop/pauseMainLoop; that loop is what actually steps the core and
 * paints the canvas, and it is Emscripten's own code, not something this
 * driver reimplements.
 *
 * The JS-side polling loop below (pump/tick) only READS the core's frame
 * counter for the UI status line and tests; it does not drive stepping. A
 * stop() that only clears a flag lets an in-flight requestAnimationFrame
 * callback keep running past the next start(), so tick() checks a generation
 * token and start() itself is a no-op while already running.
 */

export interface EmscriptenFS {
  mkdir(path: string): void
  writeFile(path: string, data: Uint8Array | string): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
  stat(path: string): unknown
}

export interface EmscriptenModule {
  FS: EmscriptenFS
  callMain(args: string[]): void
  resumeMainLoop(): void
  pauseMainLoop(): void
  _get_current_frame_count?: () => number
  _cmd_take_screenshot?: () => void
}

declare global {
  interface Window {
    EJS_Runtime?: (config: Record<string, unknown>) => Promise<EmscriptenModule>
  }
}

export interface CoreBoot {
  js: string
  wasm: Uint8Array
  rom: Uint8Array
}

function loadCoreScript(jsSource: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([jsSource], { type: 'text/javascript' }))
    const s = document.createElement('script')
    s.src = url
    const cleanup = (): void => {
      URL.revokeObjectURL(url)
      s.remove()
    }
    s.onload = () => {
      cleanup()
      resolve()
    }
    s.onerror = () => {
      cleanup()
      reject(new Error('failed to load the emulator core script'))
    }
    document.head.appendChild(s)
  })
}

export class EmulatorDriver {
  private module: EmscriptenModule | null = null
  private wasmUrl: string | null = null
  private generation = 0
  /** Bumped by dispose(); an in-flight boot() checks this before committing a Module. */
  private bootGeneration = 0
  /** True for the duration of boot(), a synchronous guard against a second concurrent boot(). */
  private booting = false
  private running = false
  /** Bumped once per live tick; a leaked second loop shows as roughly double the expected rate. */
  pumpTicks = 0
  private lastFrameCount = 0

  onFrame: ((frameCount: number) => void) | undefined

  isBooted(): boolean {
    return this.module !== null
  }
  isRunning(): boolean {
    return this.running
  }
  frameCount(): number {
    return this.module?._get_current_frame_count?.() ?? this.lastFrameCount
  }

  /**
   * Boot the core against `rom`, then start it running. Call once per widget
   * lifetime.
   *
   * Captures its own boot generation and checks it after each await: a
   * project switch mid-boot calls dispose(), and without this check the boot
   * would land afterward and resurrect a Module for a canvas the current
   * render no longer shows. `booting` guards the synchronous window before
   * the first await, where a double-click can call boot() twice before
   * `module` is ever set.
   */
  async boot(canvas: HTMLCanvasElement, files: CoreBoot): Promise<void> {
    if (this.module || this.booting) {
      throw new Error(
        'core already booted or booting; call stop()/start() instead of booting again',
      )
    }
    this.booting = true
    const mine = ++this.bootGeneration
    let wasmUrl: string | null = null

    try {
      await loadCoreScript(files.js)
      if (!window.EJS_Runtime) throw new Error('core script loaded but did not define EJS_Runtime')

      wasmUrl = URL.createObjectURL(new Blob([files.wasm], { type: 'application/wasm' }))
      const Module = await window.EJS_Runtime({
        noInitialRun: true,
        arguments: [],
        canvas,
        parent: document.body,
        print: (m: string) => console.log('[core]', m),
        printErr: (m: string) => console.warn('[core]', m),
        locateFile: (fn: string) => (fn.endsWith('.wasm') ? wasmUrl : fn),
      })
      if (mine !== this.bootGeneration) return

      if (!Module._get_current_frame_count) {
        throw new Error('core does not export _get_current_frame_count; cannot measure it honestly')
      }

      for (const dir of [
        '/home',
        '/home/web_user',
        '/home/web_user/.config',
        '/home/web_user/.config/retroarch',
      ]) {
        try {
          Module.FS.mkdir(dir)
        } catch {
          /* already exists */
        }
      }
      // audio_enable=false: audio output is a separate, out-of-scope pipeline
      // (see report). video_smooth=false keeps one core pixel as one device
      // pixel at integer canvas scale.
      Module.FS.writeFile(
        '/home/web_user/.config/retroarch/retroarch.cfg',
        'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = false\nvideo_smooth = false\n',
      )
      Module.FS.writeFile('/rom.sfc', files.rom)
      Module.callMain(['/rom.sfc'])
      if (mine !== this.bootGeneration) return

      this.wasmUrl = wasmUrl
      wasmUrl = null // ownership passed to the instance; the catch/finally below must not revoke it
      this.module = Module
      this.start()
    } finally {
      if (wasmUrl) URL.revokeObjectURL(wasmUrl)
      this.booting = false
    }
  }

  /** Resume a booted-but-stopped core. No-op if already running (the driver-side guard). */
  start(): void {
    if (this.running || !this.module) return
    this.running = true
    this.module.resumeMainLoop()
    this.pump()
  }

  /** Pause the core and kill this driver's own polling loop. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation++
    this.module?.pauseMainLoop()
  }

  dispose(): void {
    this.stop()
    this.bootGeneration++
    if (this.wasmUrl) {
      URL.revokeObjectURL(this.wasmUrl)
      this.wasmUrl = null
    }
    this.module = null
    this.lastFrameCount = 0
  }

  private pump(): void {
    const mine = ++this.generation
    const tick = (): void => {
      if (mine !== this.generation) return // a stale loop from a previous start() dies here
      this.pumpTicks++
      this.lastFrameCount = this.module?._get_current_frame_count?.() ?? this.lastFrameCount
      this.onFrame?.(this.lastFrameCount)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  /**
   * PNG bytes straight from the core's own screenshot command. Ported from
   * src/webview/emulatorPreview/main.ts's __hackbenchTest.screenshotPng: the
   * core binds the canvas as webgl2, so canvas.getContext('2d').getImageData()
   * fails on it, and this is the only readback path that works.
   */
  async screenshotPng(): Promise<Uint8Array> {
    const Module = this.module
    if (!Module || !Module._cmd_take_screenshot) throw new Error('no active core')
    const FS = Module.FS
    try {
      FS.unlink('/screenshot.png')
    } catch {
      /* not present yet */
    }
    Module._cmd_take_screenshot()
    for (let i = 0; i < 300; i++) {
      try {
        FS.stat('/screenshot.png')
        return FS.readFile('/screenshot.png')
      } catch {
        /* not yet */
      }
      await new Promise(r => window.setTimeout(r, 50))
    }
    throw new Error('screenshot.png never appeared after 15s')
  }
}
