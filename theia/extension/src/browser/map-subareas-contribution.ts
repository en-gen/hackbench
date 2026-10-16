/**
 * SPIKE (#946, not for merge): `hackbench.mapView.showWithSubAreas`, "Map: Show Neighbours",
 * opens the focused map with its neighbours as thumbnail cards.
 */
import { inject, injectable } from '@theia/core/shared/inversify'
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser'
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common'
import { MapViewWidget } from './map-view-widget'
import { SUBAREAS_VIEW_ID, SubAreasWidget } from './map-subareas-widget'

export const ShowWithSubAreasCommand: Command = {
  id: 'hackbench.mapView.showWithSubAreas',
  label: 'Show Neighbours',
  category: 'Map',
}

@injectable()
export class SubAreasContribution implements CommandContribution {
  @inject(ApplicationShell) protected readonly shell!: ApplicationShell
  @inject(WidgetManager) protected readonly widgets!: WidgetManager

  registerCommands(registry: CommandRegistry): void {
    const map = () => {
      const w = this.shell.currentWidget
      return w instanceof MapViewWidget ? w : undefined
    }
    registry.registerCommand(ShowWithSubAreasCommand, {
      isEnabled: () => !!map()?.viewOptions,
      execute: async () => {
        const options = map()?.viewOptions
        if (!options) return
        const w = await this.widgets.getOrCreateWidget<SubAreasWidget>(SUBAREAS_VIEW_ID, {
          index: options.index,
        })
        await w.open(options)
        if (!w.isAttached) await this.shell.addWidget(w, { area: 'main' })
        await this.shell.activateWidget(w.id)
      },
    })
  }
}
