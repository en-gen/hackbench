/**
 * The emulator view: boots the project's cartridge in the user's own libretro
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
import { ReactWidget, Message } from '@theia/core/lib/browser'
import { FileDialogService, OpenFileDialogProps } from '@theia/filesystem/lib/browser'
import { MessageService } from '@theia/core/lib/common'
import { EmulatorService } from '../common/emulator-protocol'
import { ProjectService } from '../common/project-protocol'
import { ProjectContext } from './project-context'
import { EmulatorDriver } from './emulator-driver'
import { CoreFrameMeter } from './emulator-frame-meter'

export const EMULATOR_VIEW_ID = 'hackbench.emulator-view'

const CORE_FILTER = { 'Core script (Emscripten loader)': ['js'] }
const ROM_FILTER = { 'SNES ROM': ['sfc', 'smc', 'rom'] }

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

  protected readonly driver = new EmulatorDriver()
  protected readonly meter = new CoreFrameMeter()
  protected readonly canvasRef = React.createRef<HTMLCanvasElement>()

  protected state: ViewState = { kind: 'no-project' }
  protected romBytes: Uint8Array | undefined
  protected busy = false
  protected error: string | undefined
  protected frameCount = 0
  protected fps = 0
  protected lastManifestPath: string | undefined
  protected refreshGeneration = 0
  private frameTicks = 0

  @postConstruct()
  protected init(): void {
    this.id = EMULATOR_VIEW_ID
    this.title.label = 'Emulator'
    this.title.caption = 'Emulator'
    this.title.iconClass = 'codicon codicon-game'
    this.title.closable = true
    this.addClass('hb-emulator-view')
    this.node.tabIndex = 0

    this.driver.onFrame = fc => {
      this.frameCount = fc
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
    void this.refresh()
  }

  protected override onCloseRequest(msg: Message): void {
    this.driver.dispose()
    this.meter.stop()
    super.onCloseRequest(msg)
  }

  /**
   * Re-derive what to show: no project, no core, cart not on this machine, or
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
      this.driver.dispose()
      this.lastManifestPath = project?.manifestPath
    }

    if (!project) {
      this.state = { kind: 'no-project' }
      this.driver.dispose()
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
        this.driver.dispose()
        this.update()
        return
      }

      const rom = await this.emulator.romForEmulator(project.manifestPath)
      if (mine !== this.refreshGeneration) return
      if (rom.status === 'rom-not-located') {
        this.romBytes = undefined
        this.state = { kind: 'rom-not-located', title: rom.baseRom.title || 'the base cartridge' }
        // The canvas this render shows next has no core behind it: a booted
        // driver left running here would paint into a detached node.
        this.driver.dispose()
        this.update()
        return
      }

      this.romBytes = rom.romBytes
      this.state = { kind: 'ready' }
      this.update()
    } catch (err) {
      if (mine !== this.refreshGeneration) return
      this.state = { kind: 'error', message: (err as Error).message }
      this.driver.dispose()
      this.update()
    }
  }

  protected async pickCore(): Promise<void> {
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
      title: "Locate this project's cartridge",
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
   * `busy` is set and rendered BEFORE the first await: the Start button must
   * disable on the same tick as the click, or a second click lands while the
   * first is still mid-RPC and both race driver.boot() (which also guards
   * itself, since a caller need not go through this button at all).
   */
  protected async start(): Promise<void> {
    if (this.busy) return
    this.error = undefined
    const canvas = this.canvasRef.current
    if (!canvas || !this.romBytes) return

    if (this.driver.isBooted()) {
      this.driver.start()
      this.meter.start(() => this.driver.frameCount())
      this.update()
      return
    }

    this.busy = true
    this.update()
    try {
      const files = await this.emulator.coreFiles()
      if (files.status === 'no-core') {
        this.error = 'The registered core is no longer available; locate it again.'
        await this.refresh()
        return
      }
      await this.driver.boot(canvas, {
        js: files.files.js,
        wasm: files.files.wasm,
        rom: this.romBytes,
      })
      this.meter.start(() => this.driver.frameCount())
    } catch (err) {
      this.error = (err as Error).message
    } finally {
      this.busy = false
      this.update()
    }
  }

  protected stop(): void {
    this.driver.stop()
    this.meter.stop()
    this.update()
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

  protected renderReady(): React.ReactNode {
    const running = this.driver.isRunning()
    return (
      <div className="hb-emulator-body">
        <div className="hb-emulator-stage">
          <canvas ref={this.canvasRef} className="hb-emulator-canvas" width={256} height={224} />
        </div>
        <div className="hb-emulator-controls">
          <button
            className="theia-button"
            disabled={this.busy || running}
            onClick={() => this.start()}
          >
            Start
          </button>
          <button
            className="theia-button secondary"
            disabled={this.busy || !running}
            onClick={() => this.stop()}
          >
            Stop
          </button>
          <span className="hb-emulator-status">
            {this.error
              ? this.error
              : !this.driver.isBooted()
                ? 'not started'
                : running
                  ? `${this.fps} fps (frame ${this.frameCount})`
                  : `stopped (frame ${this.frameCount})`}
          </span>
        </div>
      </div>
    )
  }
}
