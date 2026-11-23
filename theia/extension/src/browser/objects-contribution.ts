/**
 * Puts Objects in the left activity bar, after Audio (rank 400). Revealed on
 * first launch but not activated, as the other explorers are, so Maps keeps
 * the initial focus. The view command is bound through the contribution, so
 * it is reachable from the View menu.
 */
import { injectable } from '@theia/core/shared/inversify'
import { AbstractViewContribution } from '@theia/core/lib/browser'
import { Command } from '@theia/core/lib/common'
import { ObjectsWidget, OBJECTS_VIEW_ID } from './objects-widget'

export const ShowObjectsCommand: Command = {
  id: 'hackbench.objects.focus',
  label: 'Objects',
  category: 'HackBench',
}

@injectable()
export class ObjectsContribution extends AbstractViewContribution<ObjectsWidget> {
  constructor() {
    super({
      widgetId: OBJECTS_VIEW_ID,
      widgetName: 'Objects',
      defaultWidgetOptions: { area: 'left', rank: 500 },
      toggleCommandId: ShowObjectsCommand.id,
    })
  }

  async initializeLayout(): Promise<void> {
    await this.openView({ reveal: true })
  }
}
