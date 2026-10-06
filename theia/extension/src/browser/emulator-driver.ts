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
 * The core's CODE runs in an iframe the driver owns; it DRAWS into a canvas
 * the driver puts in the widget. Its startup hooks timers and listeners into
 * whatever page it runs in, and only its own shutdown removes them
 * (measured: Emscripten OpenAL's 25ms scheduler, resize/visibility/
 * fullscreen listeners; in the loader source, a self-rearming memory probe
 * and battery listeners). EmulatorJS has no teardown either. Removing the
 * iframe discards its document without knowing what it held. The core also
 * hooks the canvas itself (mouse, touch, context-loss listeners, a
 * ResizeObserver) and binds its WebGL context there, so each boot gets a
 * fresh canvas and dispose() removes it too: a reused canvas would keep the
 * previous core reachable and hand the next one its GL context.
 *
 * The iframe lives in a fixed page-level host, never in the widget: Theia
 * re-parents a widget's node on maximize and tab drags, and moving an iframe
 * reloads it, killing the core. A canvas survives being moved.
 *
 * The JS-side polling loop below (pump/tick) only READS the core's frame
 * counter for the UI status line and tests; it does not drive stepping. A
 * stop() that only clears a flag lets an in-flight requestAnimationFrame
 * callback keep running past the next start(), so tick() checks a generation
 * token and start() itself is a no-op while already running.
 */

import { AudioOutput, captureAudioContext } from './audio-output'

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
  _simulate_input?: (port: number, button: number, value: number) => void
  _cmd_savefiles?: () => void
  cwrap?: (name: string, ret: string, args: string[]) => (...a: unknown[]) => unknown
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
  /** The project's save game, loaded as the core's SRAM at boot. */
  save?: Uint8Array
}

/**
 * Where RetroArch keeps SRAM, pinned by retroarch.cfg rather than left to
 * its default (measured: .../userdata/saves/Snes9x/rom.srm), which folds in
 * the core's name and so moves with the core.
 */
const SAVE_DIR = '/hb-saves'
const SAVE_FILE = `${SAVE_DIR}/rom.srm`

/**
 * A 1px, invisible iframe in a page-level host nothing ever moves. 1px and
 * on screen rather than display:none, which would let the browser throttle
 * the core's requestAnimationFrame loop.
 */
function openFrame(): HTMLIFrameElement {
  let host = document.getElementById('hb-emulator-cores')
  if (!host) {
    host = document.createElement('div')
    host.id = 'hb-emulator-cores'
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    document.body.appendChild(host)
  }
  const frame = document.createElement('iframe')
  frame.className = 'hb-emulator-frame'
  frame.tabIndex = -1
  frame.style.cssText = 'width:1px;height:1px;border:0'
  host.appendChild(frame)
  return frame
}

/**
 * Copy bytes out of the core's iframe into this page's own Uint8Array. The
 * core's arrays belong to the iframe's realm, so `instanceof Uint8Array`
 * fails for them here, and Theia's RPC encoder sent one as a 0-byte save.
 */
function inPageRealm(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function loadCoreScript(doc: Document, jsSource: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([jsSource], { type: 'text/javascript' }))
    const s = doc.createElement('script')
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
    doc.head.appendChild(s)
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
  private audio: AudioOutput | null = null
  private frame: HTMLIFrameElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private savePath: string | null = null
  /** Why a save given to boot() may not be in use; undefined when it is. */
  saveProblem: string | undefined
  /** Held here so a volume chosen before boot applies to the output the core opens. */
  private outputGain = 1

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
  /** Null until booted, and null for a core that opened no audio at all. */
  audioOutput(): AudioOutput | null {
    return this.audio
  }
  /**
   * The core's SRAM as it is now, flushed to its file first. Synchronous:
   * cmd_savefiles writes before returning (measured: 2048 bytes present on
   * the very next line). Undefined with no core, or no usable save path.
   */
  readSave(): Uint8Array | undefined {
    if (!this.module || this.saveProblem) return undefined
    return this.flushAndRead(this.module)
  }

  private flushAndRead(Module: EmscriptenModule): Uint8Array | undefined {
    if (!this.savePath) return undefined
    try {
      Module._cmd_savefiles?.()
      return inPageRealm(Module.FS.readFile(this.savePath))
    } catch {
      return undefined
    }
  }

  /** A player's controller (port 0 is player 1); button is a libretro RETRO_DEVICE_ID_JOYPAD id. */
  setButton(button: number, pressed: boolean, port = 0): void {
    this.module?._simulate_input?.(port, button, pressed ? 1 : 0)
  }
  setOutputGain(gain: number): void {
    this.outputGain = gain
    if (this.audio) this.audio.master.gain.value = gain
  }

  /**
   * Boot a core against `rom`, then start it running. Once per core: Stop
   * and Reload dispose() it and boot a new one.
   *
   * Captures its own boot generation and checks it after each await: a
   * project switch mid-boot calls dispose(), and without this check the boot
   * would land afterward and resurrect a Module for a canvas the current
   * render no longer shows. `booting` guards the synchronous window before
   * the first await, where a double-click can call boot() twice before
   * `module` is ever set.
   */
  async boot(screen: HTMLElement, files: CoreBoot): Promise<void> {
    if (this.module || this.booting) {
      throw new Error(
        'core already booted or booting; call stop()/start() instead of booting again',
      )
    }
    this.booting = true
    const mine = ++this.bootGeneration
    let wasmUrl: string | null = null
    let committed = false
    let frame: HTMLIFrameElement | null = null
    const canvas = document.createElement('canvas')
    canvas.className = 'hb-emulator-canvas'
    canvas.width = 256
    canvas.height = 224
    screen.appendChild(canvas)

    try {
      frame = openFrame()
      const win = frame.contentWindow!
      await loadCoreScript(frame.contentDocument!, files.js)
      if (mine !== this.bootGeneration) return
      if (!win.EJS_Runtime) throw new Error('core script loaded but did not define EJS_Runtime')

      wasmUrl = URL.createObjectURL(new Blob([files.wasm], { type: 'application/wasm' }))
      const Module = await win.EJS_Runtime({
        noInitialRun: true,
        arguments: [],
        canvas,
        parent: frame.contentDocument!.body,
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
      // audio_enable must be true: spikes/libretro-view-engine/FINDINGS.md's "mandatory false" held
      // only for its hidden, hand-pumped pane, where WebAudio never drained.
      // In this visible widget the core held 45-75fps with its context
      // running (emulator-view.spec.cjs, one machine, snes9x wasm build).
      // video_smooth=false keeps one core pixel as one device pixel at
      // integer canvas scale.
      Module.FS.writeFile(
        '/home/web_user/.config/retroarch/retroarch.cfg',
        'screenshot_directory = "/"\nvideo_gpu_screenshot = false\naudio_enable = true\nvideo_smooth = false\n' +
          `savefile_directory = "${SAVE_DIR}"\nsort_savefiles_enable = "false"\n` +
          'sort_savefiles_by_content_enable = "false"\nsavefiles_in_content_dir = "false"\n',
      )
      Module.FS.writeFile('/rom.sfc', files.rom)
      try {
        Module.FS.mkdir(SAVE_DIR)
      } catch {
        /* already exists */
      }
      // Before callMain: RetroArch reads SRAM when it loads the content.
      if (files.save) Module.FS.writeFile(SAVE_FILE, files.save)
      // The core opens its AudioContext synchronously inside callMain
      // (Emscripten OpenAL's _alcCreateContext, its only construction site).
      // Hack-fragility point: a core that re-creates its context after boot
      // bypasses this capture, and volume would stop reaching it.
      let audio: AudioOutput | null = null
      const release = captureAudioContext(win, out => {
        audio ??= out
      })
      try {
        Module.callMain(['/rom.sfc'])
      } catch (err) {
        void (audio as AudioOutput | null)?.context.close()
        throw err
      } finally {
        release()
      }
      this.audio = audio
      this.setOutputGain(this.outputGain)
      // Read back where the core really keeps SRAM. A cfg it ignored would
      // leave the save we wrote unread; say so rather than let the player
      // start over without knowing.
      this.savePath = (Module.cwrap?.('save_file_path', 'string', [])() as string) || null
      this.saveProblem =
        this.savePath === SAVE_FILE
          ? undefined
          : `the core keeps its save at ${this.savePath ?? 'no path'}, not ${SAVE_FILE}`
      // The path being right does not mean the core read the file. A save it
      // silently ignored would leave blank SRAM, which the first write-back
      // would put over the project's real save.
      if (!this.saveProblem && files.save) {
        const loaded = this.flushAndRead(Module)
        if (!loaded || !sameBytes(loaded, files.save)) {
          this.saveProblem = "the core did not load the project's save"
        }
      }

      this.wasmUrl = wasmUrl
      wasmUrl = null // ownership passed to the instance; the catch/finally below must not revoke it
      this.frame = frame
      this.canvas = canvas
      this.module = Module
      committed = true
      this.start()
    } finally {
      if (wasmUrl) URL.revokeObjectURL(wasmUrl)
      // An abandoned or failed boot takes its whole document with it.
      if (!committed) {
        frame?.remove()
        canvas.remove()
      }
      this.booting = false
    }
  }

  /** Resume a booted-but-stopped core. No-op if already running (the driver-side guard). */
  start(): void {
    if (this.running || !this.module) return
    this.running = true
    this.module.resumeMainLoop()
    void this.audio?.context.resume()
    this.pump()
  }

  /** Pause the core and kill this driver's own polling loop. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation++
    this.module?.pauseMainLoop()
    void this.audio?.context.suspend()
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
    // Each reload boots a new core, and browsers cap live AudioContexts.
    void this.audio?.context.close()
    this.audio = null
    // Paused is not stopped: the core's timers and listeners outlive
    // pauseMainLoop. Discarding its document is what ends them.
    this.frame?.remove()
    this.frame = null
    this.canvas?.remove()
    this.canvas = null
    this.savePath = null
    this.saveProblem = undefined
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
        return inPageRealm(FS.readFile('/screenshot.png'))
      } catch {
        /* not yet */
      }
      await new Promise(r => window.setTimeout(r, 50))
    }
    throw new Error('screenshot.png never appeared after 15s')
  }
}
