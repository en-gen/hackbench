/**
 * Edit > Undo / Redo, acting on the project's op patch layers.
 *
 * Takes over Theia's existing `core.undo` / `core.redo` rather than adding a
 * second pair of commands: Ctrl+Z is what a user presses, and a ROM editor
 * where it does nothing reads as broken. Theia asks each registered handler in
 * turn and takes the first that reports itself enabled, and `registerHandler`
 * puts the newest first, so declining is not a dead end - the command falls
 * straight back to Monaco's handler and then the built-in. edit-stack-gate.ts
 * holds that decision, and is the part with a test.
 *
 * `isEnabled` is SYNCHRONOUS and the stack lives in the backend, so the state
 * is cached here and refreshed on two events: the open project changing, and
 * the working copy changing (which is how an edit made in the palette view
 * lights up Undo without this contribution knowing palettes exist).
 */
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify'
import { CommandContribution, CommandRegistry, MessageService } from '@theia/core/lib/common'
import { ApplicationShell, CommonCommands } from '@theia/core/lib/browser'
import { EditStackDto, EditStackResult, ProjectService } from '../common/project-protocol'
import { ProjectContext } from './project-context'
import { ProjectFrontendClient } from './project-push-client'
import { handlesEditStack } from './edit-stack-gate'
import { perfEnd, perfStart } from '../common/perf-marks'

/** No project, or a project we could not read: nothing to undo or redo. */
const NOTHING: EditStackDto = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
}

@injectable()
export class EditStackContribution implements CommandContribution {
  @inject(ProjectService) protected readonly projects!: ProjectService
  @inject(ProjectContext) protected readonly context!: ProjectContext
  @inject(ProjectFrontendClient) protected readonly pushClient!: ProjectFrontendClient
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(MessageService) protected readonly messages!: MessageService

  /** Last known backend state. Read synchronously by `isEnabled`. */
  protected state: EditStackDto = NOTHING

  @postConstruct()
  protected init(): void {
    this.context.onChanged(() => void this.refresh())
    // Any view's edit, not just this one's: the backend pushes on every
    // working-copy change, so a palette commit enables Undo here.
    this.pushClient.onChanged(manifestPath => {
      if (manifestPath === this.context.current?.manifestPath) void this.refresh()
    })
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerHandler(CommonCommands.UNDO.id, {
      execute: () => this.move('undo'),
      isEnabled: () => this.handles() && this.state.canUndo,
    })
    registry.registerHandler(CommonCommands.REDO.id, {
      execute: () => this.move('redo'),
      isEnabled: () => this.handles() && this.state.canRedo,
    })
  }

  /** Whether these commands are ours to answer right now. */
  protected handles(): boolean {
    return handlesEditStack(this.shell.activeWidget?.id, !!this.context.current)
  }

  protected async move(direction: 'undo' | 'redo'): Promise<void> {
    const manifestPath = this.context.current?.manifestPath
    if (!manifestPath) return

    // Captured BEFORE the call: on a refusal this is the edit that refused,
    // and naming it is the difference between an actionable message and a
    // bare error string.
    const label = direction === 'undo' ? this.state.undoLabel : this.state.redoLabel
    perfStart(direction)

    let result: EditStackResult
    try {
      result =
        direction === 'undo'
          ? await this.projects.undo(manifestPath)
          : await this.projects.redo(manifestPath)
    } catch (err) {
      this.messages.error(`Could not ${direction}: ${(err as Error).message}`)
      return
    }

    if (result.status === 'ok') {
      this.state = result
      perfEnd(direction)
      return
    }

    this.messages.error(this.explain(direction, label, result))
    // The move failed, but the stack may have moved for another reason since
    // the cached state was taken. Re-read rather than leaving it guessed.
    await this.refresh()
  }

  protected explain(
    direction: 'undo' | 'redo',
    label: string | null,
    result: Exclude<EditStackResult, { status: 'ok' }>,
  ): string {
    const what = label ? `${direction} "${label}"` : direction
    if (result.status === 'rom-not-located') {
      return `Cannot ${what}: this machine has not been told where ${result.baseRom.title.trim() || 'the base ROM'} is.`
    }
    return `Cannot ${what}: ${result.reason}`
  }

  protected async refresh(): Promise<void> {
    const manifestPath = this.context.current?.manifestPath
    if (!manifestPath) {
      this.state = NOTHING
      return
    }
    try {
      const result = await this.projects.editStack(manifestPath)
      this.state = result.status === 'ok' ? result : NOTHING
    } catch {
      // The backend may not be reachable yet on first paint. Disabled is the
      // honest state; the next push or project change refreshes it.
      this.state = NOTHING
    }
  }
}
