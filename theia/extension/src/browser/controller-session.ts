/**
 * Everything the emulator view keeps about controllers: who drives which
 * player, the hub that combines devices, the per-frame pad poll, the release
 * on blur, and persistence. No Theia imports; the browser primitives it needs
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
  languages: readonly string[]
  save(settings: ControllerSettings): void
  /** The game is running in a visible panel. */
  isLive(): boolean
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
  private blurred = false
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
      // Read only for a game someone can see, or while the fly-out shows the pads.
      const live = !this.blurred && (this.deps.isLive() || this.padsOpen)
      pollPads(this.hub, live ? this.deps.getPads() : [], this.settings.players)
    }
    this.frame = this.deps.requestFrame(tick)
    this.unlisten = [
      this.deps.listen('blur', () => {
        this.blurred = true
        this.releaseAll()
      }),
      this.deps.listen('focus', () => (this.blurred = false)),
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
    this.settings = parseControllerSettings(raw)
    this.onChange?.()
  }

  connectedPads(): Array<{ index: number; id: string }> {
    return this.deps
      .getPads()
      .flatMap((p, index) => (p?.connected ? [{ index, id: p.id ?? '' }] : []))
  }

  /** The Electron OS country code, when the bridge answers; '' or undefined falls back to languages. */
  setOsCountry(code: string | undefined): void {
    this.osCountry = code
    this.onChange?.()
  }

  scheme(): ControllerScheme {
    return resolveScheme(this.settings.style, resolveRegion(this.osCountry, this.deps.languages))
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
