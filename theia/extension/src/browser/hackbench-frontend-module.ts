// Self-referencing package path rather than a relative one: this package
// compiles with rootDir at the repo root (see tsconfig.json, #391), so a
// relative path from lib/ would not land back in src/.
import 'hackbench-theia-extension/src/browser/style/index.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import { CommandContribution, MenuContribution } from '@theia/core/lib/common'
import {
  bindViewContribution,
  FrontendApplicationContribution,
  WidgetFactory,
} from '@theia/core/lib/browser'
import { TabBarToolbarContribution } from '@theia/core/lib/browser/shell/tab-bar-toolbar'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { PROJECT_SERVICE_PATH, ProjectService } from '../common/project-protocol'
import { HackBenchContribution } from './hackbench-contribution'
import { NewProjectDialog } from './new-project-dialog'
import { ProjectPropertiesDialog } from './project-properties-dialog'
import { ProjectContext } from './project-context'
import { BrandContribution } from './brand-contribution'
import { MapExplorerContribution } from './map-explorer-contribution'
import { createMapExplorerWidget, MAP_EXPLORER_ID } from './map-explorer-widget'
import { MapViewWidget, MAP_VIEW_ID } from './map-view-widget'

export default new ContainerModule(bind => {
  // The frontend cannot touch the filesystem, so project creation is a proxy
  // onto the backend service over JSON-RPC.
  bind(ProjectService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<ProjectService>(PROJECT_SERVICE_PATH)
    })
    .inSingletonScope()

  bind(NewProjectDialog).toSelf().inSingletonScope()
  bind(ProjectPropertiesDialog).toSelf().inSingletonScope()
  bind(ProjectContext).toSelf().inSingletonScope()
  bind(HackBenchContribution).toSelf().inSingletonScope()
  bind(CommandContribution).toService(HackBenchContribution)
  bind(MenuContribution).toService(HackBenchContribution)

  // The tree gets its own child container: Theia builds a model, expansion
  // service and selection service per tree, so the widget cannot be a plain
  // self-binding in this container. Everything else reaches it through
  // WidgetManager by id.
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MAP_EXPLORER_ID,
      createWidget: () => createMapExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  bind(BrandContribution).toSelf().inSingletonScope()
  bind(FrontendApplicationContribution).toService(BrandContribution)

  // One widget per map, keyed by slot, so reopening a map focuses the one
  // already on screen instead of stacking duplicates.
  bind(MapViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MAP_VIEW_ID,
      createWidget: () => ctx.container.get(MapViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, MapExplorerContribution)
  bind(FrontendApplicationContribution).toService(MapExplorerContribution)
  bind(TabBarToolbarContribution).toService(MapExplorerContribution)
})
