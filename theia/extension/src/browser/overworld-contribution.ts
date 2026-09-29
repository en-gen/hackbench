/**
 * `hackbench.overworld.focus`: opens the ONE main-area Overworld view, or
 * focuses it when open. The map explorer's Overworld row runs it (#432), and
 * it is on the View menu so it is reachable without the explorer.
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
import { OverworldViewWidget, OVERWORLD_VIEW_ID } from './overworld-view-widget'

export const ShowOverworldCommand: Command = {
  id: 'hackbench.overworld.focus',
  label: 'Overworld',
  category: 'HackBench',
}

@injectable()
export class OverworldContribution implements CommandContribution, MenuContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(WidgetManager) protected readonly widgetManager!: WidgetManager

  protected attaching: Promise<OverworldViewWidget> | undefined

  /** Opens the Overworld widget, or focuses the one already open. */
  async openOverworld(): Promise<OverworldViewWidget> {
    // Concurrent calls share one create-and-attach, so the view is added once.
    this.attaching ??= this.attachOverworld().finally(() => (this.attaching = undefined))
    const view = await this.attaching
    await this.shell.activateWidget(view.id)
    return view
  }

  protected async attachOverworld(): Promise<OverworldViewWidget> {
    // The factory hands back the live instance, or a fresh one once closed.
    const view = await this.widgetManager.getOrCreateWidget<OverworldViewWidget>(OVERWORLD_VIEW_ID)
    if (!view.isAttached) await this.shell.addWidget(view, { area: 'main' })
    return view
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, { execute: () => this.openOverworld() })
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: ShowOverworldCommand.id })
  }
}
