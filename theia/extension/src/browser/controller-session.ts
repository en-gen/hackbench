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
  private loaded = false
  /** Changes made before the stored settings arrived, replayed over them at load. */
  private pending: Array<(s: ControllerSettings) => ControllerSettings> = []
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

  /**
   * The stored settings. Changes made before this arrived are replayed over
   * them and saved once, so an early click neither loses nor overwrites what
   * was stored. Only the first call counts, and a failed read still calls it.
   */
  load(raw: unknown): void {
    if (this.loaded) return
    this.loaded = true
    // A key held while the stored assignment moves the keyboard would stick on its old port.
    this.releaseAll()
    this.settings = this.pending.reduce((s, edit) => edit(s), parseControllerSettings(raw))
    if (this.pending.length > 0) this.deps.save(this.settings)
    this.pending = []
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
    this.change(s => ({ ...s, players: assignKeyboard(s.players, player, on) }))
  }

  setPad(player: number, pad: number | undefined): void {
    this.change(s => ({ ...s, players: assignPad(s.players, player, pad) }))
  }

  selectPlayer(player: number): void {
    const selectedPlayer = player === 1 ? 1 : 0
    this.change(s => ({ ...s, selectedPlayer }))
  }

  /** The player is sending something now, for the tab's activity dot. */
  isActive(player: number): boolean {
    return this.hub.pressed(player).size > 0
  }

  setStyle(style: ControllerStyle): void {
    this.change(s => ({ ...s, style }))
  }

  /** Apply an edit now; before the stored settings load, also queue it and save nothing yet. */
  private change(edit: (s: ControllerSettings) => ControllerSettings): void {
    this.settings = edit(this.settings)
    if (this.loaded) this.deps.save(this.settings)
    else this.pending.push(edit)
    this.onChange?.()
  }
}
