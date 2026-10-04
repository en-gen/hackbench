/**
 * `hackbench.overworld.focus`: opens the ONE main-area Overworld view, or
 * focuses it when open. The map explorer's Overworld row runs it (#432), and
 * it is on the View menu so it is reachable without the explorer.
 * `hackbench.overworld.openArea` opens an area's own tab, or focuses it (#364).
 *
 * The command is menu-contributed, not only bound (#379, see
 * map-explorer-contribution.ts).
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { ApplicationShell, CommonMenus, WidgetManager } from '@theia/core/lib/browser'
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
} from '@theia/core/lib/common'
import {
  OverworldViewWidget,
  OVERWORLD_AREA_VIEW_ID,
  OVERWORLD_FOCUS_COMMAND_ID,
  OVERWORLD_OPEN_AREA_COMMAND_ID,
  OVERWORLD_VIEW_ID,
} from './overworld-view-widget'

export const ShowOverworldCommand: Command = {
  id: OVERWORLD_FOCUS_COMMAND_ID,
  label: 'Overworld',
  category: 'HackBench',
}

@injectable()
export class OverworldContribution implements CommandContribution, MenuContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(WidgetManager) protected readonly widgetManager!: WidgetManager

  protected attaching: Promise<OverworldViewWidget> | undefined

  /** Opens the Overworld widget, or focuses the one already open. */
  async openOverworld(activate = true): Promise<OverworldViewWidget> {
    // Concurrent calls share one create-and-attach, so the view is added once.
    this.attaching ??= this.attachOverworld().finally(() => (this.attaching = undefined))
    const view = await this.attaching
    // A single click on the explorer row reveals without taking focus, so the
    // arrow keys keep walking the list (preview-tabs.ts); a double-click activates.
    if (activate) await this.shell.activateWidget(view.id)
    else await this.shell.revealWidget(view.id)
    return view
  }

  /** Opens area `area`'s tab, or focuses it; WidgetManager keys the tab by the area option. */
  async openArea(area: number, activate = true): Promise<OverworldViewWidget> {
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(
      OVERWORLD_AREA_VIEW_ID,
      { area },
    )
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    if (activate) await this.shell.activateWidget(view.id)
    else await this.shell.revealWidget(view.id)
    return view
  }

  protected async attachOverworld(): Promise<OverworldViewWidget> {
    // The factory hands back the live instance, or a fresh one once closed.
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(OVERWORLD_VIEW_ID)
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    return view
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, {
      execute: (opts?: { activate?: boolean }) => this.openOverworld(opts?.activate ?? true),
    })
    commands.registerCommand(
      { id: OVERWORLD_OPEN_AREA_COMMAND_ID },
      {
        execute: (opts: { area: number; activate?: boolean }) =>
          this.openArea(opts.area, opts.activate ?? true),
      },
    )
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: ShowOverworldCommand.id })
  }
}
