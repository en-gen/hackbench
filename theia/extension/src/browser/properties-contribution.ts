import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command, CommandRegistry } from '@theia/core/lib/common'
import { PROPERTIES_VIEW_ID, PropertiesWidget } from './properties-widget'

export const TogglePropertiesCommand: Command = {
  id: 'hackbench.properties.toggle',
  label: 'Properties',
  category: 'HackBench',
}

/** Opens the panel without taking focus from the caller (a click on the map keeps the map's keyboard). */
export const RevealPropertiesCommand: Command = { id: 'hackbench.properties.reveal' }

/** View > Properties reopens a closed panel; selecting a sprite reveals it. Right side, like Theia's own inspectors. */
@injectable()
export class PropertiesContribution extends AbstractViewContribution<PropertiesWidget> {
  constructor() {
    super({
      widgetId: PROPERTIES_VIEW_ID,
      widgetName: 'Properties',
      defaultWidgetOptions: { area: 'right', rank: 100 },
      toggleCommandId: TogglePropertiesCommand.id,
    })
  }

  override registerCommands(commands: CommandRegistry): void {
    super.registerCommands(commands)
    commands.registerCommand(RevealPropertiesCommand, {
      execute: () => this.openView({ activate: false, reveal: true }),
    })
  }
}
