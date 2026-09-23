/**
 * The emulator view: boots the project's ROM in the user's own libretro
 * core and runs it live.
 *
 * HackBench ships no core (docs/testing.md's copyright rule extends to core
 * binaries, not just ROMs); the user locates one, exactly as they locate their
 * own cartridge for a shared project. Both the ROM and the core cross the
 * JSON-RPC boundary to EmulatorService as bytes, because this frontend cannot
 * read the filesystem itself.
 */
import * as React from '@theia/core/shared/react'
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { ConfirmDialog, ReactWidget, Message, StorageService } from '@theia/core/lib/browser'
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser'
import { FileService } from '@theia/filesystem/lib/browser/file-service'
import URI from '@theia/core/lib/common/uri'
import { Disposable, MessageService } from '@theia/core/lib/common'
import { EmulatorService, SaveSlotDto } from '../common/emulator-protocol'
import { ProjectService } from '../common/project-protocol'
import { ProjectContext } from './project-context'
import { EmulatorDriver } from './emulator-driver'
import { CoreFrameMeter } from './emulator-frame-meter'
import { VolumeState, effectiveGain, parseVolumeState } from './audio-volume'
import { VolumeSplitButton } from './volume-split-button'
import { HeldButtons } from './emulator-input'
import { SaveSlotPicker, SaveSlotView } from './save-slot-picker'
import { ProjectFrontendClient } from './project-push-client'

export const EMULATOR_VIEW_ID = 'hackbench.emulator-view'

const CORE_FILTER = { 'Core script (Emscripten loader)': ['js'] }
const ROM_FILTER = { 'SNES ROM': ['sfc', 'smc', 'rom'] }
const VOLUME_KEY = 'hackbench.emulator.volume'
const SAVE_POLL_MS = 5000
const slotKey = (manifestPath: string): string => `hackbench.emulator.saveSlot:${manifestPath}`

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

type ViewState =
  | { kind: 'no-project' }
  | { kind: 'no-core' }
  | { kind: 'rom-not-located'; title: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }

@injectable()
export class EmulatorWidget extends ReactWidget {
  @inject(EmulatorService) protected readonly emulator!: EmulatorService
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(FileDialogService) protected readonly fileDialog!: FileDialogService
  @inject(MessageService) protected readonly messages!: MessageService
  @inject(StorageService) protected readonly storage!: StorageService
  @inject(ProjectFrontendClient) protected readonly projectPush!: ProjectFrontendClient
  @inject(FileService) protected readonly files!: FileService

  protected readonly driver = new EmulatorDriver()
  protected readonly meter = new CoreFrameMeter()
  /** The driver puts a fresh canvas in here per boot; React renders nothing inside it. */
  protected readonly screenRef = React.createRef<HTMLDivElement>()
  protected readonly buttons = new HeldButtons((b, pressed) => this.driver.setButton(b, pressed))

  protected state: ViewState = { kind: 'no-project' }
  protected romBytes: Uint8Array | undefined
  protected romDigest: string | undefined
  /** Digest of the ROM the running core booted from; undefined when none is booted. */
  protected bootedDigest: string | undefined
  /** The working copy no longer matches what the running core booted from. */
  protected stale = false
  private staleCheck: ReturnType<typeof setTimeout> | undefined
  /** The project the running core's save game belongs to. */
  private saveManifest: string | undefined
  /** The save as last written to the project, so an unchanged one is not rewritten. */
  private lastSave: Uint8Array | undefined
  /** The slot the running core loaded and writes back to; fixed for its life. */
  private saveSlot: number | undefined
  /** The project's slots on disk. */
  protected saveSlots: SaveSlotDto[] = []
  /** Other .srm files in saves/ the user can import. */
  protected foreignSaves: string[] = []
  /** The slot the next Start loads, remembered per project. */
  protected selectedSlot = 1
  /** Settles once this project's slot choice is known; Start waits for it. */
  private saveChoice: Promise<void> = Promise.resolve()
  /** Watches the project folder so saves added or removed outside HackBench show up. */
  private savesWatch: Disposable | undefined
  private savesChanged: ReturnType<typeof setTimeout> | undefined
  private saveTimer: ReturnType<typeof setInterval> | undefined
  protected busy = false
  protected error: string | undefined
  protected fps = 0
  protected lastManifestPath: string | undefined
  protected refreshGeneration = 0
  protected volume: VolumeState = parseVolumeState(undefined)
  /** Set on the first user change, so a slow storage read cannot overwrite it. */
  private volumeTouched = false
  private frameTicks = 0
  /** Shows "stopped" rather than "not started" once Stop has discarded a core. */
  private stopped = false

  @postConstruct()
  protected init(): void {
    this.id = EMULATOR_VIEW_ID
    this.title.label = 'Emulator'
    this.title.caption = 'Emulator'
    this.title.iconClass = 'codicon codicon-game'
    this.title.closable = true
    this.addClass('hb-emulator-view')
    this.node.tabIndex = 0

    this.driver.onFrame = () => {
      if (++this.frameTicks % 30 === 0) {
        this.fps = this.meter.stats().overallFps
        this.update()
      }
    }

    // ProjectContext is a singleton; an un-collected subscription outlives a
    // closed-and-reopened widget instance and keeps issuing RPC calls
    // (including shipping the whole ROM) for widgets nothing shows anymore.
    this.toDispose.push(
      this.context.onChanged(() => {
        void this.refresh()
      }),
    )
    // Edits land in bursts (a colour drag is many layers), so ask once the
    // burst settles rather than once per layer.
    this.toDispose.push(
      this.projectPush.onChanged(manifestPath => {
        if (manifestPath !== this.lastManifestPath) return
        clearTimeout(this.staleCheck)
        this.staleCheck = setTimeout(() => void this.checkStale(), 150)
      }),
    )
    // On dispose, however it happens, not only a close request: the core's
    // iframe lives outside this widget, so nothing else removes it.
    this.toDispose.push(
      Disposable.create(() => {
        this.savesWatch?.dispose()
        clearTimeout(this.staleCheck)
        this.buttons.releaseAll()
        this.meter.stop()
        this.disposeCore()
      }),
    )

    // Clicking the screen gives the game the keyboard. Focus has to be taken
    // explicitly: the core's own canvas mousedown handler cancels the default,
    // which would otherwise have focused this node.
    this.node.addEventListener('pointerdown', e => {
      if (e.target instanceof HTMLCanvasElement && this.screenRef.current?.contains(e.target)) {
        this.node.focus()
      }
    })
    // Closing the window or reloading the page disposes no widget. Flush
    // anyway; the RPC may not outlive the page, which the poll covers.
    const onUnload = (): void => this.persistSave()
    window.addEventListener('pagehide', onUnload)
    this.toDispose.push(Disposable.create(() => window.removeEventListener('pagehide', onUnload)))
    this.node.addEventListener('keydown', e => this.onKey(e, true))
    this.node.addEventListener('keyup', e => this.onKey(e, false))
    // A key still down when focus leaves never sees its keyup here.
    this.node.addEventListener('focusout', e => {
      if (!this.node.contains(e.relatedTarget as Node | null)) this.buttons.releaseAll()
    })

    void this.refresh()
    void this.storage.getData<unknown>(VOLUME_KEY).then(raw => {
      if (!this.volumeTouched) this.applyVolume(parseVolumeState(raw))
    })
  }

  /**
   * Controller keys, only while the panel itself has focus (click the
   * screen): arrows on the volume slider and Enter on a focused button keep
   * their usual meaning, and modified keys stay Theia's shortcuts.
   */
  protected onKey(e: KeyboardEvent, down: boolean): void {
    // A release always goes through: a key pressed here and let go after
    // Ctrl went down, or after focus moved to a button in this panel, would
    // otherwise stay held. key() ignores releases of keys it never pressed.
    if (!down) {
      this.buttons.key(e.code, false)
      return
    }
    if (e.target !== this.node || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return
    if (!this.driver.isRunning()) return
    if (this.buttons.key(e.code, true)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  /**
   * The only way the core is discarded: the save game is flushed to the
   * project first, so Stop, Reload, closing the tab and switching project
   * write progress made since the last periodic save. The write is an RPC
   * that is not awaited; the poll bounds what a lost one can cost.
   */
  protected disposeCore(): void {
    this.persistSave()
    clearInterval(this.saveTimer)
    this.saveTimer = undefined
    this.saveManifest = undefined
    this.saveSlot = undefined
    this.lastSave = undefined
    this.driver.dispose()
  }

  /** Write the core's SRAM to the project's saves/ folder if it changed. */
  protected persistSave(): void {
    const manifest = this.saveManifest
    const slot = this.saveSlot
    if (!manifest || slot === undefined || !this.driver.isBooted()) return
    const bytes = this.driver.readSave()
    if (!bytes || (this.lastSave && sameBytes(bytes, this.lastSave))) return
    // Recorded only once the write lands: a failed one stays different
    // from lastSave, so the next poll retries it instead of skipping it.
    this.emulator.storeSave(manifest, slot, bytes).then(
      () => {
        if (this.saveManifest === manifest) this.lastSave = bytes
        // A new slot exists on disk from its first write on.
        if (!this.saveSlots.some(s => s.slot === slot)) void this.refreshSaves(manifest)
      },
      err => {
        this.messages.error(`HackBench: could not save the game: ${(err as Error).message}`)
      },
    )
  }

  /** Slots from disk, and the one this project last chose. */
  protected async loadSaveChoice(manifest: string): Promise<void> {
    const [slots, foreign, stored] = await Promise.all([
      this.emulator.listSaves(manifest).catch(() => [] as SaveSlotDto[]),
      this.emulator.listForeignSaves(manifest).catch(() => [] as string[]),
      this.storage.getData<unknown>(slotKey(manifest)),
    ])
    if (manifest !== this.lastManifestPath) return
    this.saveSlots = slots
    this.foreignSaves = foreign
    // A game already running keeps its slot; only the next Start's choice moves.
    this.selectedSlot =
      typeof stored === 'number' && Number.isInteger(stored) && stored >= 1
        ? stored
        : (slots[0]?.slot ?? 1)
    this.update()
  }

  /**
   * Refresh the slot list when files in saves/ are added, removed or renamed
   * outside HackBench, e.g. a save copied in from another emulator. The
   * project folder is watched rather than saves/ itself, which may not exist
   * until the first save; changes elsewhere in it are ignored.
   */
  protected watchSaves(manifest: string | undefined): void {
    this.savesWatch?.dispose()
    this.savesWatch = undefined
    if (!manifest) return
    const project = URI.fromFilePath(manifest).parent
    const saves = project.resolve('saves')
    const watch = this.files.watch(project, { recursive: true, excludes: [] })
    const listen = this.files.onDidFilesChange(e => {
      if (!e.changes.some(c => saves.isEqualOrParent(c.resource))) return
      // Copies and moves arrive as bursts of events; list once they settle.
      clearTimeout(this.savesChanged)
      this.savesChanged = setTimeout(() => void this.refreshSaves(manifest).catch(() => {}), 300)
    })
    this.savesWatch = Disposable.create(() => {
      clearTimeout(this.savesChanged)
      listen.dispose()
      watch.dispose()
    })
  }

  protected async refreshSaves(manifest = this.lastManifestPath): Promise<void> {
    if (!manifest) return
    const [slots, foreign] = await Promise.all([
      this.emulator.listSaves(manifest),
      this.emulator.listForeignSaves(manifest),
    ])
    if (manifest !== this.lastManifestPath) return
    this.saveSlots = slots
    this.foreignSaves = foreign
    this.update()
  }

  /**
   * A running game has its own slot for life, so switching resets it: the
   * current save is written, then a fresh core boots the chosen slot and
   * plays. A paused or stopped game just loads it on the next Start.
   */
  protected selectSlot(slot: number): void {
    const manifest = this.lastManifestPath
    if (!manifest || slot === this.selectedSlot) return
    const wasRunning = this.driver.isRunning()
    if (this.driver.isBooted()) this.stop()
    this.selectedSlot = slot
    void this.storage.setData(slotKey(manifest), slot)
    this.update()
    if (wasRunning) void this.start()
  }

  protected async newSave(): Promise<void> {
    const manifest = this.lastManifestPath
    if (!manifest) return
    await this.saveOp(async () =>
      this.selectSlot(await this.emulator.nextFreeSlot(manifest, this.reservedSlots())),
    )
  }

  protected async duplicateSlot(slot: number): Promise<void> {
    const manifest = this.lastManifestPath
    if (!manifest) return
    await this.saveOp(async () => {
      // Written first, so the copy includes play since the last poll.
      if (slot === this.saveSlot) this.persistSave()
      await this.emulator.duplicateSave(manifest, slot, this.reservedSlots())
    })
  }

  /** Move another emulator's save into the next free slot. */
  protected async importSave(file: string): Promise<void> {
    const manifest = this.lastManifestPath
    if (!manifest) return
    await this.saveOp(() => this.emulator.importSave(manifest, file, this.reservedSlots()))
  }

  protected async renameSlot(slot: number, label: string): Promise<void> {
    const manifest = this.lastManifestPath
    if (!manifest) return
    await this.saveOp(() => this.emulator.labelSave(manifest, slot, label))
  }

  protected async deleteSlot(slot: number): Promise<void> {
    const manifest = this.lastManifestPath
    if (!manifest || slot === this.saveSlot) return
    const name = this.saveSlots.find(s => s.slot === slot)
    const confirmed = await new ConfirmDialog({
      title: 'Delete save',
      msg: `Delete ${name?.label ? `save ${slot} (${name.label})` : `save ${slot}`}? This cannot be undone.`,
      ok: 'Delete',
      cancel: 'Cancel',
    }).open()
    // The game may have started on this slot while the dialog was open.
    if (!confirmed || slot === this.saveSlot) return
    await this.saveOp(async () => {
      await this.emulator.deleteSave(manifest, slot)
      if (slot === this.selectedSlot) {
        const rest = this.saveSlots.filter(s => s.slot !== slot)
        this.selectedSlot = rest[0]?.slot ?? 1
        void this.storage.setData(slotKey(manifest), this.selectedSlot)
      }
    })
  }

  /**
   * Slot numbers with no file yet that must not be handed out: the chosen
   * one (a New save) and the running one, both written to later.
   */
  protected reservedSlots(): number[] {
    return [this.selectedSlot, ...(this.saveSlot !== undefined ? [this.saveSlot] : [])]
  }

  /** Run one slot operation, then show the disk as it now is. */
  private async saveOp(op: () => Promise<unknown>): Promise<void> {
    try {
      await op()
    } catch (err) {
      this.messages.error(`HackBench: ${(err as Error).message}`)
    }
    await this.refreshSaves().catch(() => undefined)
  }

  /** Compare the working copy with what the running core booted from. */
  protected async checkStale(): Promise<void> {
    const booted = this.bootedDigest
    const manifest = this.lastManifestPath
    if (!booted || !manifest) return
    const now = await this.emulator.romDigest(manifest)
    // A Stop, Reload or project switch while that was in flight owns the answer.
    if (booted !== this.bootedDigest || manifest !== this.lastManifestPath) return
    const stale = now !== undefined && now !== booted
    if (stale !== this.stale) {
      this.stale = stale
      this.update()
    }
  }

  protected applyVolume(next: VolumeState): void {
    this.volume = next
    this.driver.setOutputGain(effectiveGain(next))
    this.update()
  }

  /**
   * Re-derive what to show: no project, no core, ROM not on this machine, or
   * ready.
   *
   * Stamped with a generation token: onChanged fires this on every project
   * switch, and a caller (or a test) can also await one directly, so two can
   * overlap. A stale one must not win the race and overwrite `state`/
   * `romBytes` with what it read for a project that is no longer current.
   */
  protected async refresh(): Promise<void> {
    const mine = ++this.refreshGeneration
    const project = this.context.current

    // A running core is bound to the PREVIOUS project's canvas and ROM; a
    // project switch must not leave it driving a canvas this render is about
    // to replace.
    if (project?.manifestPath !== this.lastManifestPath) {
      this.disposeCore()
      this.lastManifestPath = project?.manifestPath
      this.saveSlots = []
      this.saveChoice = project ? this.loadSaveChoice(project.manifestPath) : Promise.resolve()
      this.watchSaves(project?.manifestPath)
      this.stopped = false
      this.bootedDigest = undefined
      this.stale = false
    }

    if (!project) {
      this.state = { kind: 'no-project' }
      this.disposeCore()
      this.update()
      return
    }

    // openProject (behind romForEmulator) throws on a missing manifest or a
    // directory holding two .hbproj files; uncaught, that is an unhandled
    // rejection (refresh is fired via `void` from onChanged) and the view is
    // left on stale state with nothing said about why.
    try {
      const core = await this.emulator.registeredCore()
      if (mine !== this.refreshGeneration) return
      if (!core) {
        this.state = { kind: 'no-core' }
        this.disposeCore()
        this.update()
        return
      }

      const rom = await this.emulator.romForEmulator(project.manifestPath)
      if (mine !== this.refreshGeneration) return
      if (rom.status === 'rom-not-located') {
        this.romBytes = undefined
        this.state = { kind: 'rom-not-located', title: rom.baseRom.title || 'the base ROM' }
        // The canvas this render shows next has no core behind it: a booted
        // driver left running here would paint into a detached node.
        this.disposeCore()
        this.update()
        return
      }

      this.romBytes = rom.romBytes
      this.romDigest = rom.digest
      this.state = { kind: 'ready' }
      this.update()
    } catch (err) {
      if (mine !== this.refreshGeneration) return
      this.state = { kind: 'error', message: (err as Error).message }
      this.disposeCore()
      this.update()
    }
  }

  /**
   * Public so the Change Emulator Core command can reach it. The empty
   * state's button and the command palette must run the SAME picker, or
   * they drift: the button validates through `locateCore` and this would
   * be the second path that could forget to.
   */
  async pickCore(): Promise<void> {
    const props: OpenFileDialogProps = {
      title: "Select the core's Emscripten loader (.js)",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: CORE_FILTER,
    }
    const uri = await this.fileDialog.showOpenDialog(props)
    if (!uri) return

    this.busy = true
    this.update()
    try {
      const result = await this.emulator.locateCore(uri.path.fsPath())
      if (result.status === 'invalid') {
        this.messages.error(`HackBench: ${result.message}`)
      } else {
        this.messages.info(`HackBench: using ${result.core.label} as the emulator core`)
        await this.refresh()
      }
    } finally {
      this.busy = false
      this.update()
    }
  }

  protected async pickRom(): Promise<void> {
    const uri = await this.fileDialog.showOpenDialog({
      title: "Locate this project's ROM",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: ROM_FILTER,
    })
    if (!uri) return

    this.busy = true
    this.update()
    try {
      await this.projects.registerRom(uri.path.fsPath())
      await this.refresh()
    } catch (err) {
      this.messages.error(`HackBench: ${(err as Error).message}`)
    } finally {
      this.busy = false
      this.update()
    }
  }

  /**
   * Start (or resume) the core.
   *
   * Resuming keeps the booted core. Booting reads the working copy first, so
   * a Start after Stop runs every edit made since, the same as Reload.
   *
   * `busy` is set and rendered BEFORE the first await: the button must
   * disable on the same tick as the click, or a second click lands while the
   * first is still mid-RPC and both race driver.boot() (which also guards
   * itself, since a caller need not go through this button at all).
   */
  protected async start(): Promise<void> {
    if (this.busy) return
    this.error = undefined
    if (!this.screenRef.current || !this.romBytes) return
    // Play hands the keyboard to the game: the panel takes focus, which is
    // what onKey listens on, with no click on the screen needed.
    this.node.focus()

    if (this.driver.isBooted()) {
      this.driver.start()
      this.meter.start(() => this.driver.frameCount())
      this.update()
      return
    }

    this.busy = true
    this.update()
    try {
      await this.refresh()
      // A Start right after a project switch must boot THIS project's
      // choice, not the previous project's slot number.
      await this.saveChoice
      const manifest = this.lastManifestPath
      const slot = this.selectedSlot
      const [files, save] = await Promise.all([
        this.emulator.coreFiles(),
        manifest ? this.emulator.loadSave(manifest, slot) : Promise.resolve(undefined),
      ])
      if (files.status === 'no-core') {
        this.error = 'The registered core is no longer available; locate it again.'
        await this.refresh()
        return
      }
      // The project can change during those awaits: boot only into the
      // screen and ROM this view shows now, or the core lands in a detached
      // node, audible and invisible, or runs the previous project's ROM
      // (both projects render 'ready', so state alone cannot tell).
      const screen = this.screenRef.current
      const digest = this.romDigest
      if (
        this.state.kind !== 'ready' ||
        this.lastManifestPath !== manifest ||
        !screen?.isConnected ||
        !this.romBytes
      ) {
        return
      }
      await this.driver.boot(screen, {
        js: files.files.js,
        wasm: files.files.wasm,
        rom: this.romBytes,
        save,
      })
      // boot() returns without a core when a dispose cancelled it.
      if (this.driver.isBooted()) {
        this.stopped = false
        this.bootedDigest = digest
        this.saveManifest = manifest
        this.saveSlot = slot
        this.lastSave = save
        // A game saves when the player saves in it, which nothing here can
        // see; poll, so a crash or a killed app loses at most a few seconds.
        this.saveTimer = setInterval(() => this.persistSave(), SAVE_POLL_MS)
        if (this.driver.saveProblem) {
          this.error = `Save games are off: ${this.driver.saveProblem}`
        }
        this.stale = false
        this.meter.start(() => this.driver.frameCount())
        // An edit that landed while booting was ignored (nothing was booted).
        void this.checkStale()
      }
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.busy = false
      this.update()
    }
  }

  /** Pause the core, keeping it booted with its frame counter intact. */
  protected pause(): void {
    this.buttons.releaseAll()
    this.driver.stop()
    this.meter.stop()
    this.update()
  }

  /** Discard the core entirely: its document, audio, canvas and memory. */
  protected stop(): void {
    this.buttons.releaseAll()
    this.meter.stop()
    this.disposeCore()
    this.bootedDigest = undefined
    this.stale = false
    this.stopped = true
    this.fps = 0
    this.update()
  }

  /**
   * Discard a core whose ROM the working copy has moved past. It stays
   * stopped: the next Start boots the working copy as it is then. Enabled
   * only while the running core is stale, so it never throws away a core
   * that already runs the latest edits.
   */
  protected reload(): void {
    if (this.busy || !this.stale) return
    this.stop()
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
  }

  protected render(): React.ReactNode {
    switch (this.state.kind) {
      case 'no-project':
        return <div className="hb-emulator-message">Open a project to use the emulator.</div>
      case 'error':
        return <div className="hb-emulator-message hb-emulator-error">{this.state.message}</div>
      case 'no-core':
        return (
          <div className="hb-emulator-message">
            <p>No emulator core is set up on this machine.</p>
            <button className="theia-button" disabled={this.busy} onClick={() => this.pickCore()}>
              Locate Core...
            </button>
          </div>
        )
      case 'rom-not-located':
        return (
          <div className="hb-emulator-message">
            <p>Locate {this.state.title} to run it in the emulator.</p>
            <button className="theia-button" disabled={this.busy} onClick={() => this.pickRom()}>
              Locate ROM...
            </button>
          </div>
        )
      case 'ready':
        return this.renderReady()
      default: {
        // A ViewState kind added above without a case here fails to compile
        // instead of silently falling through to 'ready'.
        const exhaustive: never = this.state
        return exhaustive
      }
    }
  }

  /** Slots on disk, plus the chosen one if the game has not written it yet. */
  protected slotViews(): SaveSlotView[] {
    const views: SaveSlotView[] = this.saveSlots.map(s => ({ ...s }))
    if (!views.some(s => s.slot === this.selectedSlot)) {
      views.push({ slot: this.selectedSlot, isNew: true })
      views.sort((a, b) => a.slot - b.slot)
    }
    return views
  }

  protected renderReady(): React.ReactNode {
    const running = this.driver.isRunning()
    const toggleLabel = running ? 'Pause' : this.driver.isBooted() ? 'Resume' : 'Start'
    return (
      <div className="hb-emulator-body">
        {/* Controls above the stage: a transport bar belongs at the top of
            its panel, and the canvas is a fixed 256x224 that would otherwise
            push them out of view at small heights. Codicons per
            docs/ui-conventions.md. */}
        <div className="hb-emulator-controls">
          {/* One toggle. Start boots; once booted, Pause and Resume keep the
              same core and frame counter. Stop and Reload are the controls
              that discard it. */}
          <button
            className="hb-emulator-btn"
            disabled={this.busy}
            title={toggleLabel}
            aria-label={toggleLabel}
            onClick={() => (running ? this.pause() : void this.start())}
          >
            <span className={`codicon ${running ? 'codicon-debug-pause' : 'codicon-play'}`} />
          </button>
          <button
            className="hb-emulator-btn"
            disabled={this.busy || !this.driver.isBooted()}
            title="Stop"
            aria-label="Stop"
            onClick={() => this.stop()}
          >
            <span className="codicon codicon-debug-stop" />
          </button>
          <button
            className="hb-emulator-btn"
            disabled={this.busy || !this.stale || !this.driver.isBooted()}
            title="Reload from working copy"
            aria-label="Reload"
            onClick={() => this.reload()}
          >
            <span className="codicon codicon-refresh" />
          </button>
          <SaveSlotPicker
            slots={this.slotViews()}
            selected={this.selectedSlot}
            inUse={this.saveSlot}
            disabled={this.busy}
            onSelect={slot => this.selectSlot(slot)}
            onNew={() => void this.newSave()}
            onRename={(slot, label) => void this.renameSlot(slot, label)}
            onDuplicate={slot => void this.duplicateSlot(slot)}
            onDelete={slot => void this.deleteSlot(slot)}
            foreign={this.foreignSaves}
            onOpen={() => void this.refreshSaves().catch(() => {})}
            onImport={file => void this.importSave(file)}
          />
          <VolumeSplitButton
            state={this.volume}
            unavailable={
              this.driver.isBooted() && !this.driver.audioOutput()
                ? 'This core opened no audio output'
                : undefined
            }
            onChange={next => {
              this.volumeTouched = true
              this.applyVolume(next)
              void this.storage.setData(VOLUME_KEY, next)
            }}
          />
          <span className="hb-emulator-status">
            {this.error
              ? this.error
              : !this.driver.isBooted()
                ? this.stopped
                  ? 'stopped'
                  : 'not started'
                : running
                  ? `${this.fps} fps`
                  : 'paused'}
          </span>
        </div>
        <div className="hb-emulator-stage">
          <div ref={this.screenRef} className="hb-emulator-screen" />
        </div>
      </div>
    )
  }
}
