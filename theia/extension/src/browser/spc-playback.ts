/**
 * Playing an SPC snapshot in the frontend.
 *
 * Wraps `@smwcentral/spc-player`, the same engine the VS Code extension
 * used, but without the webview scaffolding that went with it: no CSP
 * nonce, no `wasm-unsafe-eval`, no webview resource URIs, and no
 * postMessage bridge, because the snapshot arrives over JSON-RPC.
 *
 * Two things the package itself requires, which are NOT leftovers from the
 * webview and do not go away in our own shell:
 *
 *   - It is an Emscripten global script. It assigns to `window.SMWCentral`
 *     when a <script> runs it and fetches its .wasm at runtime through
 *     Emscripten's `locateFile`, so it is loaded by URL rather than
 *     imported, and the backend serves both files (node/spc-assets.ts).
 *   - It auto-initialises its own player UI on DOMContentLoaded, reading
 *     roughly twenty elements by id and class. Absent them it throws before
 *     `Backend` is ever assigned. So a hidden stub carrying those elements
 *     is planted first. We drive `Backend` directly and never show its UI.
 *
 * Everything is idempotent and lazy: nothing is fetched until the user
 * actually plays something, so a session that never touches music never
 * downloads a megabyte of WASM.
 */
import { SPC_ASSET_ROUTE } from '../common/music-protocol'

/**
 * The engine's own surface, as far as this file uses it.
 *
 * Hand-written because the package ships no types. Deliberately narrow: it
 * also exposes `loadFromLink`, `loadSong` and a track list, none of which
 * we want, because those drive its UI rather than the audio.
 */
interface SpcBackend {
  /** 0 = needs initialize(), 1 = ready. */
  status: number
  initialize(): void
  loadSPC(bytes: Uint8Array): void
  stopSPC(keepContext: boolean): void
  /** Seconds elapsed in the current song. */
  getTime(): number
  context?: AudioContext
  gainNode?: GainNode
  /** The engine's own "a gesture has not unlocked audio yet" flag. */
  locked: boolean
}

declare global {
  interface Window {
    SMWCentral?: { SPCPlayer?: { Backend?: SpcBackend } }
    Module?: unknown
  }
}

/** The elements spc.js's UI init reads. Hidden; we never show its UI. */
const STUB_DOM = `
  <div id="spc-player-interface" style="display:none">
    <div id="spc-player-header" class="header-button"></div>
    <div class="title"></div><div class="subtitle"></div><div class="details"></div>
    <button class="pause hidden"></button><button class="play"></button>
    <button class="restart"></button><button class="stop"></button><button class="close"></button>
    <input type="checkbox" id="spc-player-toggle"/>
    <input type="checkbox" id="spc-player-loop"/>
    <input type="range" id="volume-slider" class="volume-slider" min="0" max="1.5" step="0.01" value="1"/>
    <div class="volume-fill"></div><div class="volume-level"></div><div class="volume-thumb"></div>
    <div class="seek-container"><input type="range" class="seek-control" min="0" max="1"/><span class="seek-preview"></span></div>
    <span class="track-time-elapsed"></span><span class="track-duration"></span>
    <div id="track-list-container" class="hidden">
      <div class="track-list-scrollbox"></div><div class="track-list"></div>
      <div class="overflow-indicator top"></div><div class="overflow-indicator bottom"></div>
    </div>
    <div class="seek"></div>
  </div>`

const STUB_ID = 'hackbench-spc-stub'

export type PlaybackState = 'stopped' | 'playing' | 'paused'

/**
 * One engine per frontend.
 *
 * The engine owns a single AudioContext and a single ARAM image, so a
 * second instance would fight the first for the speakers. Module-level
 * rather than DI-bound because it wraps genuinely global browser state.
 */
export class SpcPlayback {
  private backend: SpcBackend | null = null
  private loading: Promise<SpcBackend | null> | null = null
  private playing = false
  private volume = 1

  /** What the panel renders its transport from. */
  get state(): PlaybackState {
    if (!this.playing) return 'stopped'
    return this.backend?.context?.state === 'suspended' ? 'paused' : 'playing'
  }

  /** Seconds into the current song, or 0 when nothing is playing. */
  elapsed(): number {
    if (!this.playing || !this.backend) return 0
    try {
      return this.backend.getTime()
    } catch {
      return 0
    }
  }

  /**
   * Load the engine, once.
   *
   * Resolves null when it cannot be loaded at all, so a caller reports a
   * dead transport rather than throwing into a click handler.
   */
  private ensureEngine(): Promise<SpcBackend | null> {
    if (this.backend) return Promise.resolve(this.backend)
    if (this.loading) return this.loading

    this.loading = new Promise<SpcBackend | null>(resolve => {
      // Both must exist BEFORE the script runs: Emscripten reads
      // Module.locateFile while starting, and the package assigns into
      // window.SMWCentral.SPCPlayer rather than creating it.
      window.Module = {
        locateFile: (p: string) => (p.endsWith('.wasm') ? `${SPC_ASSET_ROUTE}/spc.wasm` : p),
      }
      window.SMWCentral = { SPCPlayer: {} }

      if (!document.getElementById(STUB_ID)) {
        const stub = document.createElement('div')
        stub.id = STUB_ID
        stub.style.display = 'none'
        stub.innerHTML = STUB_DOM
        document.body.appendChild(stub)
      }

      const script = document.createElement('script')
      script.src = `${SPC_ASSET_ROUTE}/spc.js`
      script.onerror = () => resolve(null)
      script.onload = () => {
        // The WASM compiles asynchronously after the script itself runs, so
        // Backend appears a little later. Poll rather than guess a delay,
        // and give up rather than poll for ever.
        let attempts = 0
        const tick = window.setInterval(() => {
          const b = window.SMWCentral?.SPCPlayer?.Backend
          if (b && b.status !== undefined) {
            window.clearInterval(tick)
            if (b.status === 0) b.initialize()
            this.backend = b
            resolve(b)
          } else if (++attempts > 40) {
            window.clearInterval(tick)
            resolve(null)
          }
        }, 250)
      }
      document.body.appendChild(script)
    })
    return this.loading
  }

  /**
   * Play a snapshot. Must be called from a user gesture: browsers only let
   * an AudioContext start inside one, and the engine's own `locked` flag
   * tracks the same thing.
   *
   * Returns false when the engine could not be loaded, so the caller can
   * say so instead of leaving a button that appears to have worked.
   */
  async play(bytes: Uint8Array): Promise<boolean> {
    const backend = await this.ensureEngine()
    if (!backend || backend.status !== 1) return false

    backend.locked = false
    const ctx = backend.context
    if (ctx) await ctx.resume()

    backend.loadSPC(bytes)
    // The package's own UI init leaves the gain at whatever its (hidden)
    // slider says, which is not necessarily what this panel shows.
    if (backend.gainNode) backend.gainNode.gain.value = this.volume
    this.playing = true
    return true
  }

  stop(): void {
    if (this.backend && this.playing) this.backend.stopSPC(false)
    this.playing = false
  }

  /** Pause and resume go through the AudioContext; the engine has no transport. */
  async togglePause(): Promise<void> {
    const ctx = this.backend?.context
    if (!ctx || !this.playing) return
    if (ctx.state === 'running') await ctx.suspend()
    else await ctx.resume()
  }

  /** 0 to 1.5, matching the engine's own range. */
  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(1.5, value))
    if (this.backend?.gainNode) this.backend.gainNode.gain.value = this.volume
  }

  getVolume(): number {
    return this.volume
  }
}

/** The one instance. See the class comment for why this is not DI-bound. */
export const spcPlayback = new SpcPlayback()
