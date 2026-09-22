/**
 * Reaches the emulator from a command (View menu, activity bar), and opens it
 * in the MAIN editor area rather than the sidebar: a running game needs the
 * width, and there is one widget with no separate navigator beside it.
 *
 * A widget bound but never menu-contributed is registered and unreachable
 * (#379), which is why the command is contributed rather than only bound.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { EmulatorWidget, EMULATOR_VIEW_ID } from './emulator-widget'

export const ShowEmulatorCommand: Command = {
  id: 'hackbench.emulator.focus',
  label: 'Emulator',
  category: 'HackBench',
}

@injectable()
export class EmulatorContribution extends AbstractViewContribution<EmulatorWidget> {
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
}
