/**
 * The globe in the activity bar, and `hackbench.overworld.focus`.
 *
 * Theia's activity bar only holds side-panel views, so the globe is a
 * placeholder view with no content. Activating it (clicking the globe) opens
 * or focuses the ONE main-area Overworld widget and collapses the sidebar,
 * so the slot never shows. Collapsing clears the side bar's current tab
 * (SidePanelHandler.collapse), which is what makes the next click activate
 * the globe again rather than toggle the panel.
 *
 * The command is menu-contributed, not only bound (#379, see
 * map-explorer-contribution.ts).
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution, BaseWidget, Message } from '@theia/core/lib/browser'
import { Command, CommandRegistry, Emitter } from '@theia/core/lib/common'
import { OverworldViewWidget, OVERWORLD_VIEW_ID } from './overworld-view-widget'

export const OVERWORLD_LAUNCHER_ID = 'hackbench.overworld-launcher'

export const ShowOverworldCommand: Command = {
  id: 'hackbench.overworld.focus',
  label: 'Overworld',
  category: 'HackBench',
}

/** The globe's side-panel entry. It never shows content; see the file header. */
@injectable()
export class OverworldLauncherWidget extends BaseWidget {
  readonly onActivated = new Emitter<void>()

  constructor() {
    super()
    this.id = OVERWORLD_LAUNCHER_ID
    this.title.label = 'Overworld'
    this.title.caption = 'Overworld'
    this.title.iconClass = 'codicon codicon-globe'
    this.title.closable = false
    this.node.tabIndex = 0
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg)
    this.node.focus()
    this.onActivated.fire()
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
    this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
      if (factoryId === OVERWORLD_LAUNCHER_ID) this.wire(widget as OverworldLauncherWidget)
    })
    for (const existing of this.widgetManager.getWidgets(OVERWORLD_LAUNCHER_ID)) {
      this.wire(existing as OverworldLauncherWidget)
    }
    await this.openView({ activate: false, reveal: false })
  }

  protected wire(launcher: OverworldLauncherWidget): void {
    launcher.onActivated.event(() => void this.openOverworld(true))
  }

  /** Opens the Overworld widget, or focuses the one already open. */
  async openOverworld(collapseSidebar = false): Promise<OverworldViewWidget> {
    // The factory hands back the live instance, or a fresh one once closed.
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(OVERWORLD_VIEW_ID)
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    await this.shell.activateWidget(view.id)
    if (collapseSidebar) await this.shell.collapsePanel('left')
    return view
  }

  override registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, { execute: () => this.openOverworld() })
  }
}
