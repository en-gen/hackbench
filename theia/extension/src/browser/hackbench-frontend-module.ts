// Self-referencing package path rather than a relative one: this package
// compiles with rootDir at the repo root (see tsconfig.json, #391), so a
// relative path from lib/ would not land back in src/.
import 'hackbench-theia-extension/src/browser/style/index.css'
import 'hackbench-theia-extension/src/browser/style/zoom.css'
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
import { PreviewTabs } from './preview-tabs'
import { PROJECT_SERVICE_PATH, ProjectService } from '../common/project-protocol'
import { HackBenchContribution } from './hackbench-contribution'
import { NewProjectDialog } from './new-project-dialog'
import { ProjectPropertiesDialog } from './project-properties-dialog'
import { ProjectContext } from './project-context'
import { BrandContribution } from './brand-contribution'
import { MapExplorerContribution } from './map-explorer-contribution'
import { createMapExplorerWidget, MAP_EXPLORER_ID } from './map-explorer-widget'
import { MapViewWidget, MAP_VIEW_ID } from './map-view-widget'
import { ProjectFrontendClient } from './project-push-client'
import { EditStackContribution } from './edit-stack-contribution'
import { ReconnectContribution } from './reconnect-contribution'
import { OutlineViewContribution } from '@theia/outline-view/lib/browser/outline-view-contribution'
import { HiddenOutlineViewContribution } from './hidden-outline-view-contribution'
import { CtrlWheelGuardContribution } from './ctrl-wheel-guard-contribution'

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(OutlineViewContribution).to(HiddenOutlineViewContribution).inSingletonScope()

  bind(ProjectFrontendClient).toSelf().inSingletonScope()

  // The frontend cannot touch the filesystem, so project creation is a proxy
  // onto the backend service over JSON-RPC. The client is this connection's
  // push target: the backend uses it to report a working-copy change, which
  // is what keeps Edit > Undo/Redo enabled correctly.
  bind(ProjectService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      const client = ctx.container.get(ProjectFrontendClient)
      return provider.createProxy<ProjectService>(PROJECT_SERVICE_PATH, client)
    })
    .inSingletonScope()

  bind(NewProjectDialog).toSelf().inSingletonScope()
  bind(ProjectPropertiesDialog).toSelf().inSingletonScope()
  bind(ProjectContext).toSelf().inSingletonScope()
  bind(HackBenchContribution).toSelf().inSingletonScope()
  bind(CommandContribution).toService(HackBenchContribution)
  bind(MenuContribution).toService(HackBenchContribution)

  // No MenuContribution: this claims Theia's existing Edit > Undo/Redo
  // entries rather than adding a second pair beside them.
  bind(ReconnectContribution).toSelf().inSingletonScope()
  bind(FrontendApplicationContribution).toService(ReconnectContribution)
  bind(EditStackContribution).toSelf().inSingletonScope()
  bind(CommandContribution).toService(EditStackContribution)

  // The tree gets its own child container: Theia builds a model, expansion
  // service and selection service per tree, so the widget cannot be a plain
  // self-binding in this container. Everything else reaches it through
  // WidgetManager by id.
  bind(PreviewTabs).toSelf().inSingletonScope()

  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MAP_EXPLORER_ID,
      createWidget: () => createMapExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  bind(BrandContribution).toSelf().inSingletonScope()
  bind(FrontendApplicationContribution).toService(BrandContribution)

  bind(CtrlWheelGuardContribution).toSelf().inSingletonScope()
  bind(FrontendApplicationContribution).toService(CtrlWheelGuardContribution)

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
