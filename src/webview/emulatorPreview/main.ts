/**
 * Emulator Preview -- webview entry point.
 *
 * Boots the snes9x-wasm libretro core against the ROM bytes the extension
 * host sends. All ROM patches (level-load override, demo freeze, and any
 * per-scenario extras) are computed by EmulatorPreviewProvider.ts -- this
 * file just applies them to the plain `romBytes` array BEFORE FS.writeFile
 * and callMain ever run. That ordering is the point of the libretro-view-
 * engine spike's task A: t9's original version patched Module.HEAPU8 after
 * callMain (found via a heap scan, see git history), which happened to work
 * for these bank-$00 bytes but leaves open whether a bank-$05/$06 patch
 * would too. Patching the source array before the core's first read removes
 * that question -- there is no "already parsed" state to be stale against.
 *
 * Also exposes window.__hackbenchTest, a T12-only hook the Playwright e2e
 * suite calls directly via frame.evaluate() (it's already executing inside
 * this webview's frame, so no postMessage round trip is needed): pause /
 * resume / toggleMainLoop for task B, and a PNG screenshot pulled through
 * the core's own cmd_take_screenshot command. Screenshotting this way,
 * rather than canvas.getContext('2d').getImageData() on the live canvas, is
 * ported from spike/t6/harness.js's T0.screenshot: the core binds the
 * canvas as webgl2, so a 2d context request on it fails.
 *
 * Messages FROM extension host:
 *   { type:'load', romBytes, wasmUri, levelId, patches }
 * Messages TO extension host:
 *   { type:'ready' } | { type:'error', message }
 */

export {} // forces module scope so `declare global` below is legal

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
const vscode = acquireVsCodeApi()

interface EmscriptenFS {
  mkdir: (path: string) => void
  writeFile: (path: string, data: Uint8Array | string) => void
  readFile: (path: string) => Uint8Array
  unlink: (path: string) => void
  stat: (path: string) => unknown
}

interface EmscriptenModule {
  FS: EmscriptenFS
  HEAPU8: Uint8Array
  callMain: (args: string[]) => void
  pauseMainLoop: () => void
  resumeMainLoop: () => void
  // Bound directly off wasmExports under their underscore-prefixed C names
  // (confirmed present in vendor/cores/snes9x-wasm/snes9x_libretro.js) --
  // no cwrap needed for zero/single-int-arg void calls.
  _toggleMainLoop: (n: number) => void
  _cmd_take_screenshot: () => void
  _get_current_frame_count?: () => number
  // (port, RETRO_DEVICE_ID_JOYPAD id, pressed). Confirmed working during the
  // forced-level-load path: (0, 7, 1) held RIGHT and Mario ran.
  _simulate_input?: (port: number, button: number, value: number) => void
  // set_cheat's third arg is a JS string; only cwrap marshals that to a UTF8
  // pointer for us, so this one stays cwrap'd rather than called direct.
  cwrap: (name: string, ret: string | null, args: string[]) => (...a: unknown[]) => unknown
}

declare global {
  interface Window {
    EJS_Runtime?: (config: Record<string, unknown>) => Promise<EmscriptenModule>
  }
}

interface Patch { offset: number; value: number }

// Arbitrary but distinctive -- vanishingly unlikely to occur by chance
// elsewhere in a ~24MB wasm heap. Used by __hackbenchTest's WRAM finder.
const WRAM_SIGNATURE = [0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
const curtainEl = document.getElementById('curtain') as HTMLDivElement

function setStatus(text: string): void {
  statusEl.textContent = text
}

/**
 * The first open of a ROM has to run SMW's boot, because the level loader
 * consumes state only that boot produces (CODE_00B888 decompresses the
 * player's graphics, bank_00.asm:2300, and it is never called again). That is
 * roughly 460 emulated frames of logo and title screen which are not the
 * thing anyone asked to look at, so cover the canvas until the level is up.
 *
 * Covering, not hiding: the core derives its backing store from the canvas's
 * CSS box, so collapsing that box would break the GL surface.
 */
function setCurtain(text: string | null): void {
  if (text === null) { curtainEl.style.display = 'none'; return }
  curtainEl.style.display = 'flex'
  curtainEl.textContent = text
}

function applyPatches(romBytes: Uint8Array, patches: Patch[]): void {
  for (const { offset, value } of patches) romBytes[offset] = value
}

async function boot(romBytes: Uint8Array, wasmUri: string, patches: Patch[]): Promise<EmscriptenModule> {
  // The whole point: mutate the byte array the core is about to read, before
  // it has read anything. No heap scan, no "was this already cached" doubt.
  applyPatches(romBytes, patches)

  if (!window.EJS_Runtime) throw new Error('EJS_Runtime factory missing -- core script did not load')
  const t0 = performance.now()
  const Module = await window.EJS_Runtime({
    noInitialRun: true,
    arguments: [],
    canvas,
    // Emscripten's findEventTarget() resolves the "!parent" special target
    // via Module.parent, falling back to document.querySelector("!parent")
    // -- an invalid selector -- when it's unset. Must be a real element.
    parent: document.body,
    print: (m: string) => console.log('[core]', m),
    printErr: (m: string) => console.warn('[core]', m),
    // Emscripten resolves the .wasm path relative to the script by default;
    // override so it fetches the webview-URI copy instead.
    locateFile: (fn: string) => (fn.endsWith('.wasm') ? wasmUri : fn),
  })
  const loadMs = Math.round(performance.now() - t0)
  console.log(`[emulatorPreview] core loaded in ${loadMs}ms`)
  setStatus(`core loaded in ${loadMs}ms, booting...`)

  const FS = Module.FS
  for (const dir of ['/home', '/home/web_user', '/home/web_user/.config', '/home/web_user/.config/retroarch']) {
    try { FS.mkdir(dir) } catch { /* already exists */ }
  }
  // audio_enable=false is mandatory (see t9 findings). screenshot_directory
  // fixes cmd_take_screenshot's output path for __hackbenchTest.screenshotPng
  // below -- ported from spike/t6/harness.js's RA_CFG.
  // video_smooth defaults to TRUE in RetroArch, which bilinear-filters the
  // core's 256x224 framebuffer on its way to the canvas. The canvas itself is
  // already a clean 2x nearest-neighbour upscale, so that filtering is the
  // only thing softening the picture. Off means one pixel stays one pixel.
  FS.writeFile(
    '/home/web_user/.config/retroarch/retroarch.cfg',
    'screenshot_directory = "/"\n' +
    'video_gpu_screenshot = false\n' +
    'audio_enable = false\n' +
    'video_smooth = false\n',
  )
  FS.writeFile('/rom.sfc', romBytes)
  Module.callMain(['/rom.sfc'])
  // Arms the loop's next requestAnimationFrame; that callback only fires on
  // the browser's next paint, never synchronously, so no frame has actually
  // executed by the time this function returns.
  Module.resumeMainLoop()
  return Module
}

let activeModule: EmscriptenModule | null = null

const sleep = (ms: number): Promise<void> => new Promise(r => window.setTimeout(r, ms))

/** Last GameMode observed, so a failure can say where it actually got stuck. */
let lastGameMode = -1

/** WRAM base once located, exposed to the test hook for camera probes. */
let activeWramBase: number | null = null

/**
 * Title-screen machine state supplied by the host, if a previous open made one,
 * paired with the heap offset WRAM sat at when it was taken.
 *
 * A savestate is the closest thing libretro offers to "start at a different
 * instruction": it carries the program counter, the CPU registers, WRAM, VRAM
 * and CGRAM together, so restoring one puts the console exactly where it was
 * without re-running a boot frame. The core cannot set the program counter on
 * its own -- vendor/cores/snes9x-wasm/snes9x_libretro.js exports 33 functions
 * and none of them reach a CPU register -- and setting it alone would not help,
 * because SMW's boot modes do work the level-load modes then consume:
 * GM01Presents decompresses the player's graphics through CODE_00B888
 * (bank_00.asm:2297-2300), and a run that skips it draws Mario as stripes.
 */
let machineState: Uint8Array | undefined
let cachedWramBase: number | undefined

/**
 * WRAM identified by what stays TRUE there, not by what its bytes happen to be.
 *
 * The cached base is a heap offset from a previous core instance, so it has to
 * be checked rather than trusted. An exact byte fingerprint cannot do that job:
 * whatever is running underneath changes WRAM every frame, so a snapshot only
 * matches on the single frame it was taken. GameMode does hold -- the state is
 * captured at FadeToLevel, and that mode lingers ~36 frames (measured in a
 * Mesen trace of a real overworld entry: 0x10 at frame 43525660, 0x11 at
 * 43525696). Requiring it to READ 0x10 and KEEP reading it is what separates
 * real WRAM from a stray heap byte that happens to hold 0x10 once.
 *
 * Measured: the base was identical across two core instances in the same
 * session (0x21b8c4 both times, one machine, snes9x-wasm, e2e smoke run).
 * That is why this is worth caching at all, and why it is still verified.
 */
const WRAM_SIZE = 0x20000

/**
 * Check a cached WRAM base against a just-restored console.
 *
 * A restored state RESUMES: it was captured mid-way through loading a level,
 * so the console carries on into that level and plays it. Accept any mode from
 * the load sequence through game over, because by the time we look it may have
 * got as far as dying unattended (GameMode 0x17, bank_00.asm:2207 -- observed).
 * Where it actually got does not matter, because the caller re-stages it.
 *
 * Requiring two consecutive reads in range is what separates real WRAM from a
 * stray heap byte; a wrong base falls back to the signature search.
 */
async function verifyCachedBase(Module: EmscriptenModule, base: number): Promise<number | null> {
  if (base < 0 || base + WRAM_SIZE > Module.HEAPU8.length) return null
  const mode = (): number => Module.HEAPU8[base + GAME_MODE]
  const inRange = (m: number): boolean => m >= GM_FADE_DONE && m <= 0x17
  const seen = new Set<number>()
  for (let i = 0; i < 250; i++) {
    await sleep(8)
    const m = mode()
    seen.add(m)
    if (!inRange(m)) continue
    await sleep(8)
    const again = mode()
    seen.add(again)
    if (inRange(again)) return base
  }
  console.warn(
    `[emulatorPreview] cached base 0x${base.toString(16)} never showed a load-sequence mode; saw `
    + [...seen].map(v => '0x' + v.toString(16)).join(','),
  )
  return null
}

/** Hand the core a savestate. Returns false if the host sent us nothing. */
function restoreMachineState(Module: EmscriptenModule): boolean {
  if (!machineState) return false
  Module.FS.writeFile('/title.state', machineState)
  ;(Module.cwrap('load_state', 'number', ['string', 'number']) as (p: string, r: number) => number)('title.state', 0)
  return true
}

/**
 * Snapshot the emulator at the title screen and hand it to the extension host,
 * so the next panel skips the boot sequence.
 *
 * save_state_info() returns a STRING of the form "size|pointer|flag", not a
 * number -- the state bytes are read straight out of the heap at that pointer,
 * with no filesystem involved. Reading it as a number is why an earlier attempt
 * concluded savestates were broken. See spike/t11-emulatorjs-api.md.
 */
function captureState(Module: EmscriptenModule, base: number): void {
  try {
    const info = (Module.cwrap('save_state_info', 'string', []) as () => string)()
    const [size, ptr] = info.split('|').map(Number)
    if (!Number.isFinite(size) || !Number.isFinite(ptr) || size <= 0) return
    // The WRAM base travels with the state. Without it the next open has to
    // find WRAM again, and finding it costs ~90 emulated frames of a running
    // console, which is exactly the boot sequence this state exists to skip.
    // levelId is deliberately NOT part of this: the state is taken at
    // GM10FadeToLevel, before GM11LoadLevel reads OverworldOverride
    // (bank_00.asm:2597-2632), so nothing level-specific has happened yet and
    // one state serves every level.
    vscode.postMessage({
      type: 'machineState',
      state: Module.HEAPU8.slice(ptr, ptr + size),
      wramBase: base,
    })
  } catch (err) {
    console.warn('[emulatorPreview] title state capture failed', err)
  }
}

/** SNES WRAM offsets, all cited to SMWDisX. */
const GAME_MODE = 0x0100        // rammap.asm:977-980
const OW_OVERRIDE = 0x0109      // rammap.asm:1033-1036
const OW_SUBMAP = 0x1f11        // SMW_U.sym:10966
const GM_TITLE_SCREEN = 0x07    // rammap.asm:989
const GM_FADE_TO_LEVEL = 0x0f   // rammap.asm:997, the mode the overworld sets
const GM_FADE_DONE = 0x10       // bank_00.asm:2597, "Fade to Level (black)"
const GM_FADE_IN = 0x13         // bank_00.asm:2203, GMTransitionMosaic again
const BRIGHTNESS = 0x0dae       // SMW_U.sym:3602
const MOSAIC_DIRECTION = 0x0daf // SMW_U.sym:9858
const MOSAIC_SIZE = 0x0db0      // SMW_U.sym:9861
const GM_LEVEL = 0x14           // rammap.asm:1002
const KEEP_MODE_ACTIVE = 0x0db1 // SMW_U.sym:9510

/**
 * Locate WRAM by planting a signature through the cheat API and finding it by
 * exact identity. Works first try headlessly under Node; has been observed
 * failing in this webview, hence the generous retry and the honest null.
 * Cheats only land once the emulated CPU actually steps, so this must wait on
 * real frames rather than polling tightly.
 */
async function findWram(Module: EmscriptenModule): Promise<number | null> {
  const setCheat = Module.cwrap('set_cheat', null, ['number', 'number', 'string']) as
    (i: number, enabled: number, code: string) => void
  WRAM_SIGNATURE.forEach((v, i) => {
    const addr = (0x7e1000 + i).toString(16).padStart(6, '0').toUpperCase()
    setCheat(i, 1, addr + v.toString(16).padStart(2, '0').toUpperCase())
  })

  // Let real frames run BEFORE scanning. The cheat only lands once the emulated
  // CPU steps, and a full pass over a 134MB heap blocks the main thread long
  // enough to starve requestAnimationFrame. Scanning eagerly therefore prevents
  // the very frames it is waiting for, and never finds anything. Count frames
  // rather than milliseconds so a throttled rAF just takes longer instead of
  // silently skipping the wait.
  const frameCount = (): number => Module._get_current_frame_count?.() ?? 0
  const startFrames = frameCount()
  for (let i = 0; i < 200 && frameCount() - startFrames < 90; i++) await sleep(50)

  // Scan in chunks, yielding between them, for the same reason.
  const CHUNK = 4 << 20
  for (let attempt = 0; attempt < 6; attempt++) {
    const heap = Module.HEAPU8
    for (let start = 0; start < heap.length; start += CHUNK) {
      const end = Math.min(start + CHUNK + WRAM_SIGNATURE.length, heap.length)
      outer: for (let i = start; i + WRAM_SIGNATURE.length <= end; i++) {
        for (let j = 0; j < WRAM_SIGNATURE.length; j++) {
          if (heap[i + j] !== WRAM_SIGNATURE[j]) continue outer
        }
        // Disable, or they re-apply every frame and pin those bytes forever.
        WRAM_SIGNATURE.forEach((_, k) => setCheat(k, 0, '7E100000'))
        return i - 0x1000
      }
      await sleep(0) // hand the frame loop a slot
    }
    await sleep(250)
  }
  return null
}

/**
 * Drive SMW's own game-mode state machine straight into the level, skipping the
 * attract-mode demo entirely. The demo is why the title-screen-slot approach
 * resets after ~28s (its 34 duration bytes sum to 1426 frames, then
 * bank_00.asm:3359-3362 falls into FadeOutBackToTitle) and why input does
 * nothing (WriteControllerInput overwrites the controller registers every
 * frame with the canned sequence). GameMode_Level is ordinary gameplay: no
 * expiry, and the player's input is read normally.
 */
async function driveToLevel(
  Module: EmscriptenModule,
  base: number,
  levelId: number,
  atFadeDone: boolean,
): Promise<boolean> {
  const gm = (): number => Module.HEAPU8[base + GAME_MODE]

  // Budget in EMULATED FRAMES, not wall clock. Under remote desktop or a
  // backgrounded window, requestAnimationFrame is throttled hard, so the title
  // screen at frame ~230 can take a minute of real time to arrive. Waiting on
  // milliseconds times out before the game has done anything wrong.
  const frames = (): number => Module._get_current_frame_count?.() ?? 0
  const waitFor = async (pred: () => boolean, budget: number): Promise<boolean> => {
    const start = frames()
    while (!pred()) {
      if (frames() - start > budget) return false
      await sleep(16)
    }
    return true
  }

  lastGameMode = gm()

  // atFadeDone means a restored console is already sitting at FadeToLevel with
  // the screen black, so there is nothing to do but redirect it. Otherwise we
  // have to reach that point ourselves.
  if (!atFadeDone) {
    // A cold console has to reach the title screen first, because the boot
    // modes are what load the player's graphics. A booted one is already past
    // that and may be mid-level, which is just as good a thing to fade out of.
    if (gm() < GM_TITLE_SCREEN
        && !await waitFor(() => gm() === GM_TITLE_SCREEN, 3000)) { lastGameMode = gm(); return false }

    // Do exactly what the overworld does on its last two instructions before
    // handing over. CODE_049120 ends (bank_04.asm:1812-1816) with
    //     LDA #$02 / STA KeepModeActive / ... / INC GameMode
    // and that first write is not decoration: GMTransitionMosaic opens with
    // DEC KeepModeActive / BPL Return (bank_00.asm:4076-4077), so the value
    // sitting there decides how many frames the transition idles before it
    // does anything. Forcing the mode without it left whatever the title
    // screen happened to leave behind in charge of our fade.
    //
    // Observed directly: a Mesen trace of a level entered from the overworld
    // shows $0491DD writing $0DB1, then $0491E5 incrementing GameMode 0x0E ->
    // 0x0F, after which the ROM runs 0x10, 0x11, 0x12, 0x13, 0x14 by itself.
    Module.HEAPU8[base + KEEP_MODE_ACTIVE] = 0x02
    Module.HEAPU8[base + GAME_MODE] = GM_FADE_TO_LEVEL

    // Snapshot at the BLACK SCREEN, not at the title screen.
    //
    // A state taken at the title screen restores to the title screen, and mode
    // 0x0F then dissolves it on the way out -- so every open replayed a mosaic
    // fade of the Nintendo title, which is exactly what it looked like. Mode
    // 0x10 is after that fade has finished and before GM11LoadLevel reads
    // OverworldOverride (bank_00.asm:2597-2632), so the screen is already
    // black and nothing level-specific has happened. One state, any level.
    if (!await waitFor(() => gm() === GM_FADE_DONE, 600)) { lastGameMode = gm(); return false }
    captureState(Module, base)
  }

  // encodeOverride, per the TRACED MECHANISM block in headless_capture.lua.
  // This has to land before GM11LoadLevel reads it, which the trace puts ~36
  // frames after mode 0x10 begins.
  const lo = levelId & 0xff
  Module.HEAPU8[base + OW_OVERRIDE] = lo < 0x25 ? lo : lo + 0x24
  Module.HEAPU8[base + OW_SUBMAP] = levelId >= 0x100 ? 1 : 0

  // From here the ROM runs 0x11 -> 0x12 -> 0x13 on its own. Mode 0x13 is the
  // fade IN, and we do not want to watch it, so land it on its final step.
  //
  // GMTransitionMosaic (bank_00.asm:4075-4100) does, per pass:
  //     MosaicSize  += MosaicRate[Y]        ; db -1<<4, 1<<4
  //     Brightness  += BrightnessRate[Y]    ; db 1,-1
  //     if Brightness == BrightnessLimits[Y]  ; db 15,0
  //         INC GameMode
  //     HW_MOSAIC = %00000011 | MosaicSize
  //
  // With Y=0 that is -16, +1 and a limit of 15. So from MosaicSize $10 and
  // Brightness $0E, ONE pass lands MosaicSize on 0 and Brightness on the
  // limit: the mode advances and the same pass writes HW_MOSAIC clear.
  //
  // Writing MosaicSize after mode 0x14 cannot work and was tried: the
  // transition modes are the ONLY code that writes HW_MOSAIC, so a mosaic
  // left applied by a fade that advanced early stays on screen forever. That
  // is the stuck-mosaic symptom. Pinning MosaicDirection makes the arithmetic
  // above deterministic instead of depending on what the restored state left.
  if (await waitFor(() => gm() === GM_FADE_IN, 600)) {
    Module.HEAPU8[base + MOSAIC_DIRECTION] = 0
    Module.HEAPU8[base + MOSAIC_SIZE] = 0x10
    Module.HEAPU8[base + BRIGHTNESS] = 0x0e
  }

  if (!await waitFor(() => gm() === GM_LEVEL, 900)) { lastGameMode = gm(); return false }
  return true
}

/** libretro RETRO_DEVICE_ID_JOYPAD ids; 7 = RIGHT is confirmed working. */
const KEY_TO_BUTTON: Record<string, number> = {
  ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7,
  KeyZ: 0, KeyX: 8, KeyA: 1, KeyS: 9,
  Enter: 3, ShiftRight: 2,
}

function wireInput(Module: EmscriptenModule): void {
  const send = Module._simulate_input
  if (!send) return
  const held = new Set<number>()
  const set = (code: string, down: boolean, ev: KeyboardEvent): void => {
    const btn = KEY_TO_BUTTON[code]
    if (btn === undefined) return
    ev.preventDefault()
    if (down === held.has(btn)) return
    if (down) held.add(btn); else held.delete(btn)
    send(0, btn, down ? 1 : 0)
  }
  window.addEventListener('keydown', ev => set(ev.code, true, ev))
  window.addEventListener('keyup', ev => set(ev.code, false, ev))
  // A held button survives a reload and can wedge the core on a black screen,
  // so drop everything when focus leaves.
  window.addEventListener('blur', () => {
    for (const btn of held) send(0, btn, 0)
    held.clear()
  })
  canvas.tabIndex = 0
  canvas.focus()
}

/**
 * Report the actual pixel geometry. Blur survives both `image-rendering:
 * pixelated` and `video_smooth = false` when the canvas BACKING STORE is not an
 * integer multiple of the core's 256x224 output, which is what happens if
 * Emscripten sizes it by devicePixelRatio on a scaled Windows display. Measure
 * rather than guess.
 */
/**
 * Force the canvas backing store onto an exact integer multiple of the core's
 * 256x224 output.
 *
 * The core sizes the backing store itself, as CSS size times
 * devicePixelRatio ("Setting real canvas size" in its log). On a display with
 * fractional scaling -- 1.25 and 1.5 are the usual Windows values -- that lands
 * on a non-integer factor, so nearest-neighbour sampling makes some source
 * pixels two device pixels wide and others three. It reads as blur, and neither
 * image-rendering:pixelated nor video_smooth=false can help, because the damage
 * happens in the upscale itself.
 *
 * Choosing the CSS size as (256 * N / dpr) makes the backing store exactly
 * 256 * N whatever dpr is.
 */
function pinIntegerScale(): void {
  const dpr = window.devicePixelRatio || 1
  // Target roughly the original 2x CSS size, rounded so the BACKING store
  // (css * dpr) lands on a whole multiple of 256x224. At dpr 2 this gives
  // scale 4 and css 512x448, which is what the core already chose and is a
  // 1:1 device-pixel mapping. At dpr 1.25 it gives scale 3 and css 614x538,
  // avoiding the 2.5x upscale that produces unevenly sized pixels.
  const scale = Math.max(2, Math.round(2 * dpr))
  canvas.style.width = `${(256 * scale) / dpr}px`
  canvas.style.height = `${(224 * scale) / dpr}px`
}

function geometry(): string {
  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null
  const drawing = gl ? `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}` : 'n/a'
  const scaleX = canvas.width / 256
  return [
    `backing ${canvas.width}x${canvas.height}`,
    `css ${canvas.clientWidth}x${canvas.clientHeight}`,
    `gl ${drawing}`,
    `dpr ${window.devicePixelRatio}`,
    `scale ${scaleX}x${Number.isInteger(scaleX) ? '' : ' NON-INTEGER'}`,
  ].join(' | ')
}

/**
 * Report the emulator's ACTUAL frame rate, sampled from the core's own frame
 * counter once a second.
 *
 * "Feels slow" cannot distinguish a genuinely starved emulator from a fast one
 * whose pixels are arriving over a compressed remote-desktop link. A number
 * can: 60 means the core is running at full speed and anything you dislike is
 * in the display path, while 12 means the core itself is being starved.
 */
function startFpsTicker(Module: EmscriptenModule, hex: string, arrivedAt: number): void {
  let prev = Module._get_current_frame_count?.() ?? 0
  const geo = geometry()
  window.setInterval(() => {
    const now = Module._get_current_frame_count?.() ?? 0
    const fps = now - prev
    prev = now
    // arrivedAt is emulated frames from power-on to gameplay, and it is the
    // number that says whether the boot ran. The logo alone is ~230 frames, so
    // a restored open lands in the tens and a cold one in the hundreds.
    setStatus(`${hex} -- playable in ${arrivedAt}f | ${fps} fps | ${geo}`)
  }, 1000)
}

async function onLoad(romBytes: Uint8Array, wasmUri: string, levelId: number, patches: Patch[]): Promise<void> {
  const Module = await boot(romBytes, wasmUri, patches)
  activeModule = Module
  const hex = `$${levelId.toString(16)}`

  // Restore before anything else runs. The boot sequence is only visible
  // because locating WRAM needs ~90 frames of a live console, and those frames
  // are the Nintendo Presents logo; a cached state plus a cached WRAM base
  // removes the reason to run them, so the level is the first thing drawn.
  let base: number | null = null
  let restored = false
  if (machineState && cachedWramBase !== undefined) {
    setStatus(`${hex}: restoring cached state...`)
    setCurtain('loading...')
    restoreMachineState(Module)
    base = await verifyCachedBase(Module, cachedWramBase)
    restored = base !== null
  }

  if (base === null) {
    setStatus(`${hex}: first run for this ROM, initializing...`)
    setCurtain('initializing, first run for this ROM...')
    base = await findWram(Module)
  }

  activeWramBase = base
  if (base !== null && await driveToLevel(Module, base, levelId, restored)) {
    setCurtain(null)
    wireInput(Module)
    pinIntegerScale()
    // The core re-derives the backing store when the panel resizes, so re-pin.
    window.addEventListener('resize', pinIntegerScale)
    startFpsTicker(Module, hex, Module._get_current_frame_count?.() ?? -1)
    return
  }

  // Fall back to the pre-boot title-screen-slot patches the host supplied.
  // Raise the curtain either way: a covered canvas with a failure in the
  // status line is worse than showing whatever the core actually produced.
  setCurtain(null)
  // They render the right terrain but leave the game in attract mode, so it
  // is not interactive and resets after about 28 seconds.
  wireInput(Module)
  const fps = activeModule?._get_current_frame_count?.() ?? -1
  setStatus(
    base === null
      ? `${hex} -- WRAM not found; attract-mode fallback, resets after ~28s`
      : `${hex} -- stuck at GameMode 0x${lastGameMode.toString(16)} after ${fps} frames; attract-mode fallback`,
  )
}

// T12-only (libretro-view-engine spike, task B/C). Real rAF runs in this
// webview -- unlike the browser-pane harness this was ported from, which
// monkeypatched requestAnimationFrame and pumped frames synchronously -- so
// pause/resume can be driven and observed at genuine wall-clock pace.
;(window as unknown as { __hackbenchTest: Record<string, (...a: never[]) => unknown> }).__hackbenchTest = {
  pauseMainLoop: () => activeModule?.pauseMainLoop(),
  resumeMainLoop: () => activeModule?.resumeMainLoop(),
  toggleMainLoop: (n: number) => activeModule?._toggleMainLoop(n),
  frameCount: () => activeModule?._get_current_frame_count?.() ?? null,
  // cmd_take_screenshot() only writes /screenshot.png on a later core
  // iteration (GL readback isn't safe outside the run loop -- spike/t6
  // harness.js), so this polls real wall-clock time instead of t6's
  // pumpFrames(), which relied on the monkeypatched rAF this build doesn't use.
  screenshotPng: async (): Promise<number[]> => {
    const Module = activeModule
    if (!Module) throw new Error('no active core')
    const FS = Module.FS
    try { FS.unlink('/screenshot.png') } catch { /* not present yet */ }
    Module._cmd_take_screenshot()
    for (let i = 0; i < 300; i++) {
      try {
        FS.stat('/screenshot.png')
        return Array.from(FS.readFile('/screenshot.png'))
      } catch { /* not yet */ }
      await new Promise(r => window.setTimeout(r, 50))
    }
    throw new Error('screenshot.png never appeared after 15s')
  },
  // WRAM base discovery: plant a distinctive 8-byte signature at $7E1000
  // via the core's cheat API, then find it in Module.HEAPU8 by exact
  // identity (same technique findRom() used for the ROM copy). Ported from
  // spike/t6/harness.js's T0.plantWramSignature -- this environment has no
  // other way to reach WRAM, since the JS heap is a flat wasm arena with no
  // labelled regions. Caller must let real frames run between planting and
  // finding (the cheat only takes effect within the emulated CPU's own
  // memory writes, which need the main loop to actually step).
  plantWramSignature: (): void => {
    const Module = activeModule
    if (!Module) throw new Error('no active core')
    console.log('[wram] cwrap available', typeof Module.cwrap)
    const setCheat = Module.cwrap('set_cheat', null, ['number', 'number', 'string']) as
      (i: number, enabled: number, code: string) => void
    const resetCheat = Module.cwrap('reset_cheat', null, []) as () => void
    console.log('[wram] setCheat/resetCheat types', typeof setCheat, typeof resetCheat)
    WRAM_SIGNATURE.forEach((v, i) => {
      const addr = (0x7e1000 + i).toString(16).padStart(6, '0').toUpperCase()
      const code = addr + v.toString(16).padStart(2, '0').toUpperCase()
      console.log('[wram] setCheat', i, code)
      const r = setCheat(i, 1, code)
      console.log('[wram] setCheat returned', r)
    })
    // NOT calling resetCheat() here as an experiment: the documented
    // spike/t6 sequence calls it after the set_cheat loop, but that
    // produced zero effect empirically in this webview (all calls
    // succeeded with no thrown error, yet the planted pattern never
    // appeared in HEAPU8). Testing whether reset_cheat actually means
    // "clear all cheats" rather than "commit/apply pending cheats".
  },
  findWramBase: (): number => {
    const heap = activeModule?.HEAPU8
    if (!heap) return -1
    outer: for (let i = 0; i + WRAM_SIGNATURE.length <= heap.length; i++) {
      for (let j = 0; j < WRAM_SIGNATURE.length; j++) if (heap[i + j] !== WRAM_SIGNATURE[j]) continue outer
      return i - 0x1000
    }
    return -1
  },
  // snesOffset is the low 16 bits of a $7Exxxx address, e.g. 0x100 for
  // GameMode (rammap.asm:980), 0x13 for TrueFrame (rammap.asm, same table).
  readWram: (wramBase: number, snesOffset: number): number => activeModule?.HEAPU8[wramBase + snesOffset] ?? -1,

  /**
   * The WRAM base this panel resolved, so a caller can address game RAM.
   * Null until the level is up.
   */
  wramBase: (): number | null => activeWramBase,

  writeWram: (wramBase: number, snesOffset: number, value: number): void => {
    if (activeModule) activeModule.HEAPU8[wramBase + snesOffset] = value
  },

  /**
   * Scroll the camera and capture, which is the whole-level render probe.
   *
   * Layer1XPos ($001A, SMW_U.sym:9577) is the camera's X in pixels. SMW
   * uploads tilemap COLUMNS as the camera moves, so it is stepped rather than
   * teleported: a jump leaves the tilemap holding whatever was last uploaded.
   * `step` is in pixels; 16 is one Map16 column, the rate the game itself
   * scrolls at when running.
   */
  scrollCapture: async (base: number, step: number, shots: number, settleFrames: number): Promise<number[][]> => {
    const Module = activeModule
    if (!Module) throw new Error('no active core')
    const hook = (window as unknown as { __hackbenchTest: { screenshotPng: () => Promise<number[]> } }).__hackbenchTest
    const frames = (): number => Module._get_current_frame_count?.() ?? 0
    const out: number[][] = []
    let x = (Module.HEAPU8[base + 0x1b] << 8) | Module.HEAPU8[base + 0x1a]
    for (let i = 0; i < shots; i++) {
      const target = frames() + settleFrames
      while (frames() < target) {
        await sleep(4)
        // Nudge every poll so the scroll is smooth rather than a teleport.
        x += step
        Module.HEAPU8[base + 0x1a] = x & 0xff
        Module.HEAPU8[base + 0x1b] = (x >> 8) & 0xff
      }
      out.push(await hook.screenshotPng())
    }
    return out
  },
}

window.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as {
    type: string
    romBytes?: Uint8Array
    wasmUri?: string
    levelId?: number
    patches?: Patch[]
    machineState?: Uint8Array
    wramBase?: number
  }
  if (msg.type !== 'load' || !msg.romBytes || !msg.wasmUri || msg.levelId === undefined) return
  machineState = msg.machineState
  cachedWramBase = msg.wramBase
  onLoad(msg.romBytes, msg.wasmUri, msg.levelId, msg.patches ?? []).catch((err: Error) => {
    setCurtain(null)
    setStatus(`error: ${err.message}`)
    vscode.postMessage({ type: 'error', message: err.message })
  })
})

vscode.postMessage({ type: 'ready' })
