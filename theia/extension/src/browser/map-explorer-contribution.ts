/**
 * Puts the map explorer in the shell's left sidebar and on the View menu.
 *
 * A widget bound to the container but never contributed to a menu is
 * registered and unreachable, which this project has shipped before (#379),
 * so the view command is menu-contributed rather than only bound.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
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

@injectable()
export class MapExplorerContribution extends AbstractViewContribution<MapExplorerWidget> {
  constructor() {
    super({
      widgetId: MAP_EXPLORER_ID,
      widgetName: 'Maps',
      defaultWidgetOptions: { area: 'left', rank: 100 },
      toggleCommandId: ShowMapExplorerCommand.id,
    })
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
