/**
 * Reaches the emulator from a command (View menu, activity bar), and opens it
 * in the MAIN editor area rather than the sidebar: a running game needs the
 * width, and there is one widget with no separate navigator beside it.
 *
 * A widget bound but never menu-contributed is registered and unreachable
 * (#379), which is why the command is contributed rather than only bound.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution, WidgetManager } from '@theia/core/lib/browser'
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
  @inject(WidgetManager) protected readonly widgets!: WidgetManager

  constructor() {
    super({
      widgetId: EMULATOR_VIEW_ID,
      widgetName: 'Emulator',
      defaultWidgetOptions: { area: 'main' },
      toggleCommandId: ShowEmulatorCommand.id,
    })
  }

  /** Present but not focused on first launch, matching the palette view. */
  async initializeLayout(): Promise<void> {
    await this.openView({ activate: false, reveal: true })
  }

  override registerCommands(registry: CommandRegistry): void {
    super.registerCommands(registry)
    registry.registerCommand(ChangeCoreCommand, {
      // Reveal rather than activate: picking a core is a settings change, and
      // stealing focus to a widget the user was not looking at is rude. The
      // widget refreshes itself once the new core registers.
      execute: async () => {
        const widget = await this.widgets.getOrCreateWidget<EmulatorWidget>(EMULATOR_VIEW_ID)
        await widget.pickCore()
      },
    })
  }
}
