/**
 * Everything the emulator view keeps about controllers: who drives which
 * player, the hub that combines devices, the per-frame pad poll, the release
 * on losing focus, and persistence. No Theia imports; the browser primitives it needs
 * arrive through SessionDeps so a test drives it with fakes.
 */
import { HeldButtons } from './emulator-input'
import { ControllerHub, PadLike, pollPads } from './gamepad-input'
import {
  ControllerScheme,
  ControllerSettings,
  ControllerStyle,
  assignKeyboard,
  assignPad,
  resolveRegion,
  parseControllerSettings,
  resolveScheme,
} from './controller-settings'

export interface SessionDeps {
  send(port: number, button: number, pressed: boolean): void
  getPads(): ReadonlyArray<(PadLike & { id?: string }) | null>
  /**
   * navigator.language only: the first entry of navigator.languages is the one
   * the user ranks highest, and later ones say nothing about where they are.
   * Best effort anyway: Chromium folds es-MX to es-419 and en-CA to en-GB.
   */
  language(): string
  save(settings: ControllerSettings): void
  /** The game is running in a visible panel. */
  isLive(): boolean
  /** document.hasFocus(), read each frame. No blur event is used: focus moving into the core's iframe fires one while the window keeps focus. */
  hasFocus(): boolean
  requestFrame(cb: () => void): number
  cancelFrame(handle: number): void
  listen(type: string, fn: () => void): () => void
}

export class ControllerSession {
  settings: ControllerSettings = parseControllerSettings(undefined)
  padsOpen = false
  /** Called when the fly-out has something new to show. */
  onChange: (() => void) | undefined

  readonly hub: ControllerHub
  private readonly keyboard: HeldButtons
  private osCountry: string | undefined
  private touched = false
  private loaded = false
  /** A tab picked before the stored settings arrived; it wins over the stored one. */
  private pendingTab: number | undefined
  private wasLive = false
  private frame: number | undefined
  private unlisten: Array<() => void> = []

  constructor(private readonly deps: SessionDeps) {
    this.hub = new ControllerHub(deps.send)
    this.hub.onChange = () => this.padsOpen && this.onChange?.()
    this.keyboard = new HeldButtons((b, pressed) => {
      const port = this.settings.players.findIndex(p => p.keyboard)
      if (port >= 0) this.hub.set(port, 'kb', b, pressed)
    })
  }

  start(): void {
    const tick = (): void => {
      this.frame = this.deps.requestFrame(tick)
      // Read only for a focused window showing a running game, or the fly-out.
      const live = this.deps.hasFocus() && (this.deps.isLive() || this.padsOpen)
      if (!live) {
        // Pause, Stop, hiding and losing focus all end here: let go once.
        if (this.wasLive) this.releaseAll()
        this.wasLive = false
        return
      }
      this.wasLive = true
      pollPads(this.hub, this.deps.getPads(), this.settings.players)
    }
    this.frame = this.deps.requestFrame(tick)
    this.unlisten = [
      this.deps.listen('gamepadconnected', () => this.padsOpen && this.onChange?.()),
      this.deps.listen('gamepaddisconnected', () => this.padsOpen && this.onChange?.()),
    ]
  }

  dispose(): void {
    if (this.frame !== undefined) this.deps.cancelFrame(this.frame)
    this.frame = undefined
    this.unlisten.forEach(u => u())
    this.unlisten = []
    this.releaseAll()
  }

  /** False for keys that are not controller keys, which the caller must leave alone. */
  key(code: string, down: boolean): boolean {
    return this.keyboard.key(code, down)
  }

  get keyboardAssigned(): boolean {
    return this.settings.players.some(p => p.keyboard)
  }

  releaseAll(): void {
    this.keyboard.releaseAll()
    this.hub.releaseAll()
  }

  /** Stored settings; ignored if the user already changed something this session. */
  load(raw: unknown): void {
    if (this.touched) return
    const first = !this.loaded
    this.loaded = true
    // A key held while the stored assignment moves the keyboard would stick on its old port.
    this.releaseAll()
    this.settings = parseControllerSettings(raw)
    if (first && this.pendingTab !== undefined) {
      this.settings = { ...this.settings, selectedPlayer: this.pendingTab }
      this.deps.save(this.settings)
    }
    this.onChange?.()
  }

  connectedPads(): Array<{ index: number; id: string; standard: boolean }> {
    return this.deps
      .getPads()
      .flatMap((p, index) =>
        p?.connected ? [{ index, id: p.id ?? '', standard: p.mapping === 'standard' }] : [],
      )
  }

  /** The Electron OS country code, when the bridge answers; '' or undefined falls back to languages. */
  setOsCountry(code: string | undefined): void {
    this.osCountry = code
    this.onChange?.()
  }

  scheme(): ControllerScheme {
    return resolveScheme(this.settings.style, resolveRegion(this.osCountry, [this.deps.language()]))
  }

  togglePads(open = !this.padsOpen): void {
    this.padsOpen = open
    this.onChange?.()
  }

  setKeyboard(player: number, on: boolean): void {
    // Released first, so a held key lets go on the port it was pressed on.
    this.keyboard.releaseAll()
    this.change({ players: assignKeyboard(this.settings.players, player, on) })
  }

  setPad(player: number, pad: number | undefined): void {
    this.change({ players: assignPad(this.settings.players, player, pad) })
  }

  selectPlayer(player: number): void {
    const selectedPlayer = player === 1 ? 1 : 0
    if (!this.loaded) {
      // Saving now would write the defaults over what is still being read.
      this.pendingTab = selectedPlayer
      this.settings = { ...this.settings, selectedPlayer }
      this.onChange?.()
      return
    }
    this.change({ selectedPlayer })
  }

  /** The player is sending something now, for the tab's activity dot. */
  isActive(player: number): boolean {
    return this.hub.pressed(player).size > 0
  }

  setStyle(style: ControllerStyle): void {
    this.change({ style })
  }

  private change(next: Partial<ControllerSettings>): void {
    this.touched = true
    this.settings = { ...this.settings, ...next }
    this.deps.save(this.settings)
    this.onChange?.()
  }
}
