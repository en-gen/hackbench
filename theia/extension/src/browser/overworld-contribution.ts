/**
 * The globe in the activity bar, and `hackbench.overworld.focus`.
 *
 * Theia's activity bar holds only side-panel views, so the globe is an empty
 * launcher view. EVERY path that shows it - a click, View > Toggle Left Panel,
 * a restored layout with the globe current - opens or focuses the ONE
 * main-area Overworld widget and collapses the panel, so the slot never shows.
 * Collapsing clears the side bar's current tab, so the next click activates
 * the globe again rather than collapsing an open panel.
 *
 * The command is menu-contributed, not only bound (#379, see
 * map-explorer-contribution.ts).
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import {
  AbstractViewContribution,
  ApplicationShell,
  BaseWidget,
  Message,
} from '@theia/core/lib/browser'
import { Command, CommandRegistry, CommandService } from '@theia/core/lib/common'
import { OverworldViewWidget, OVERWORLD_VIEW_ID } from './overworld-view-widget'

export const OVERWORLD_LAUNCHER_ID = 'hackbench.overworld-launcher'

export const ShowOverworldCommand: Command = {
  id: 'hackbench.overworld.focus',
  label: 'Overworld',
  category: 'HackBench',
}

@injectable()
export class OverworldLauncherWidget extends BaseWidget {
  @inject(CommandService) protected readonly commands!: CommandService
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  protected opening = false

  constructor() {
    super()
    this.id = OVERWORLD_LAUNCHER_ID
    this.title.label = 'Overworld'
    this.title.caption = 'Overworld'
    this.title.iconClass = 'codicon codicon-globe'
    this.title.closable = false
    this.node.tabIndex = 0
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg)
    void this.openOverworld()
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
    void this.openOverworld()
  }

  /** A click both shows and activates the globe; one open covers both. */
  protected async openOverworld(): Promise<void> {
    if (this.opening) return
    this.opening = true
    try {
      await this.commands.executeCommand(ShowOverworldCommand.id)
      await this.shell.collapsePanel('left')
    } finally {
      this.opening = false
    }
  }
}

@injectable()
export class OverworldContribution extends AbstractViewContribution<OverworldLauncherWidget> {
  constructor() {
    super({
      widgetId: OVERWORLD_LAUNCHER_ID,
      widgetName: 'Overworld',
      // After Maps (100), before Graphics (200).
      defaultWidgetOptions: { area: 'left', rank: 150 },
      toggleCommandId: ShowOverworldCommand.id,
    })
  }

  async onStart(): Promise<void> {
    await this.openView({ activate: false, reveal: false })
  }

  /** Opens the Overworld widget, or focuses the one already open. */
  async openOverworld(): Promise<OverworldViewWidget> {
    // The factory hands back the live instance, or a fresh one once closed.
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(OVERWORLD_VIEW_ID)
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    await this.shell.activateWidget(view.id)
    return view
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, { execute: () => this.openOverworld() })
  }
}
