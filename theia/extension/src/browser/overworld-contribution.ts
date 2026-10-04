/**
 * `hackbench.overworld.focus` shows the hub and `hackbench.overworld.openArea` an area, both
 * through PreviewTabs like map rows (#364): not activating previews it in the one shared
 * Overworld preview tab, activating pins it as its own tab and retires the matching preview.
 * The explorer's rows run them (#432), and the hub is on the View menu so it is reachable
 * without the explorer.
 *
 * The command is menu-contributed, not only bound (#379, see
 * map-explorer-contribution.ts).
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { CommonMenus } from '@theia/core/lib/browser'
import {
  Command,
  CommandContribution,
  CommandRegistry,
  MenuContribution,
  MenuModelRegistry,
} from '@theia/core/lib/common'
import {
  OverworldViewWidget,
  OVERWORLD_FOCUS_COMMAND_ID,
  OVERWORLD_OPEN_AREA_COMMAND_ID,
  OVERWORLD_VIEW_ID,
} from './overworld-view-widget'
import { PreviewTabs } from './preview-tabs'

export const ShowOverworldCommand: Command = {
  id: OVERWORLD_FOCUS_COMMAND_ID,
  label: 'Overworld',
  category: 'HackBench',
}

@injectable()
export class OverworldContribution implements CommandContribution, MenuContribution {
  @inject(PreviewTabs) protected readonly previews!: PreviewTabs

  /** Area `area` (0 is the hub), previewed or, when `pinned`, as its own tab. */
  async show(area: number, pinned: boolean): Promise<OverworldViewWidget> {
    const apply = (w: OverworldViewWidget): Promise<void> => w.open(area)
    if (!pinned) return this.previews.preview<OverworldViewWidget>(OVERWORLD_VIEW_ID, apply)
    return this.previews.pin<OverworldViewWidget>(
      OVERWORLD_VIEW_ID,
      { area },
      apply,
      p => p.shows(area),
      {},
    )
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(ShowOverworldCommand, {
      execute: (opts?: { activate?: boolean }) => this.show(0, opts?.activate ?? true),
    })
    commands.registerCommand(
      { id: OVERWORLD_OPEN_AREA_COMMAND_ID },
      {
        execute: (opts: { area: number; activate?: boolean }) =>
          this.show(opts.area, opts.activate ?? true),
      },
    )
  }

  registerMenus(menus: MenuModelRegistry): void {
    menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: ShowOverworldCommand.id })
  }
}
