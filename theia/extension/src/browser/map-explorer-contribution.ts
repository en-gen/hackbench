/**
 * Puts the map explorer in the shell's left sidebar and on the View menu.
 *
 * A widget bound to the container but never contributed to a menu is
 * registered and unreachable, which this project has shipped before (#379),
 * so the view command is menu-contributed rather than only bound.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import {
  TabBarToolbarContribution,
  TabBarToolbarRegistry,
} from '@theia/core/lib/browser/shell/tab-bar-toolbar'
import { Command, CommandRegistry } from '@theia/core/lib/common'
import { MapExplorerWidget, MAP_EXPLORER_ID } from './map-explorer-widget'

export const ShowMapExplorerCommand: Command = {
  id: 'hackbench.maps.focus',
  label: 'Maps',
  category: 'HackBench',
}

/**
 * Wide enough for the longest vanilla map name beside its slot, measured
 * rather than guessed: at the shell default of 196px, 15 of 55 visible rows
 * wrapped.
 */
const DEFAULT_SIDEBAR_WIDTH = 280

export const ExpandAllMapsCommand: Command = {
  id: 'hackbench.maps.expandAll',
  label: 'Expand All',
  category: 'HackBench',
  iconClass: 'codicon codicon-expand-all',
}

export const CollapseAllMapsCommand: Command = {
  id: 'hackbench.maps.collapseAll',
  label: 'Collapse All',
  category: 'HackBench',
  iconClass: 'codicon codicon-collapse-all',
}

@injectable()
export class MapExplorerContribution
  extends AbstractViewContribution<MapExplorerWidget>
  implements TabBarToolbarContribution
{
  constructor() {
    super({
      widgetId: MAP_EXPLORER_ID,
      widgetName: 'Maps',
      defaultWidgetOptions: { area: 'left', rank: 100 },
      toggleCommandId: ShowMapExplorerCommand.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands)

    for (const [command, run] of [
      [ExpandAllMapsCommand, (w: MapExplorerWidget) => w.expandAll()],
      [CollapseAllMapsCommand, (w: MapExplorerWidget) => w.collapseAll()],
    ] as const) {
      commands.registerCommand(command, {
        execute: () => this.withWidget(w => run(w)),
        // isVisible scopes the toolbar button to this view. isEnabled also has
        // to answer for the command palette and keybindings, which pass no
        // widget at all, so it falls back to whether the view exists.
        isEnabled: w => (w ? w instanceof MapExplorerWidget : !!this.tryGetWidget()),
        isVisible: w => w instanceof MapExplorerWidget,
      })
    }
  }

  registerToolbarItems(registry: TabBarToolbarRegistry): void {
    registry.registerItem({
      id: ExpandAllMapsCommand.id,
      command: ExpandAllMapsCommand.id,
      tooltip: ExpandAllMapsCommand.label,
      priority: 0,
    })
    registry.registerItem({
      id: CollapseAllMapsCommand.id,
      command: CollapseAllMapsCommand.id,
      tooltip: CollapseAllMapsCommand.label,
      priority: 1,
    })
  }

  protected async withWidget(run: (widget: MapExplorerWidget) => Promise<void>): Promise<void> {
    const widget = this.tryGetWidget()
    if (widget) await run(widget)
  }

  /**
   * Shown and ACTIVATED on first launch. Revealing without activating leaves
   * the view as a background tab behind Explorer, where it has no size: the
   * tree virtualises its rows, so a hidden tree renders zero of them and the
   * maps are loaded but invisible.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: true, reveal: true })
    // Map names are long ("DONUT GHOST HOUSE"), and the shell's default
    // sidebar is too narrow for them beside a slot number. Only a FIRST-RUN
    // default: Theia persists the layout, so a width the user sets themselves
    // is never overwritten by this.
    this.shell.leftPanelHandler.resize(DEFAULT_SIDEBAR_WIDTH)
  }
}
