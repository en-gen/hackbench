/**
 * Reaches the emulator from a command (View menu, activity bar), and docks it
 * in the RIGHT activity bar: the left one holds the explorers over the ROM's
 * contents, and the emulator is consulted beside whatever is being edited.
 * Outline, which held that slot, is left out of the default layout
 * (hidden-outline-view-contribution.ts).
 *
 * A widget bound but never menu-contributed is registered and unreachable
 * (#379), which is why the command is contributed rather than only bound.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command, CommandRegistry } from '@theia/core/lib/common'
import { EmulatorWidget, EMULATOR_VIEW_ID } from './emulator-widget'

export const ShowEmulatorCommand: Command = {
  id: 'hackbench.emulator.focus',
  label: 'Emulator',
  category: 'HackBench',
}

/**
 * Replace the registered libretro core.
 *
 * Command-only, deliberately: the core is chosen once and rarely changed,
 * so it does not earn toolbar space. Before this there was NO way to change
 * it after the first choice - the picker only appeared in the empty state,
 * so a registration pointing at a file that had since moved left the view
 * stuck with no way out.
 */
export const ChangeCoreCommand: Command = {
  id: 'hackbench.emulator.changeCore',
  label: 'Change Emulator Core...',
  category: 'HackBench',
}

@injectable()
export class EmulatorContribution extends AbstractViewContribution<EmulatorWidget> {
  constructor() {
    super({
      widgetId: EMULATOR_VIEW_ID,
      widgetName: 'Emulator',
      defaultWidgetOptions: { area: 'right', rank: 100 },
      toggleCommandId: ShowEmulatorCommand.id,
    })
  }

  /**
   * An icon in the right activity bar on first launch, collapsed: revealing
   * would open the right panel and take width from the editor before anyone
   * asked for the emulator.
   */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false, reveal: false })
  }

  override registerCommands(registry: CommandRegistry): void {
    super.registerCommands(registry)
    registry.registerCommand(ChangeCoreCommand, {
      // Reveal rather than activate: picking a core is a settings change, and
      // stealing focus to a widget the user was not looking at is rude. The
      // widget refreshes itself once the new core registers.
      execute: async () => {
        const widget = await this.openView({ activate: false, reveal: true })
        await widget.pickCore()
      },
    })
  }
}
