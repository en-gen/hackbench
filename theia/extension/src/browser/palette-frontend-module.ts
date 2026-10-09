// Self-referencing package path, matching hackbench-frontend-module.ts: this
// package compiles with rootDir at the repo root (see tsconfig.json, #391),
// so a relative path from lib/ would not land back in src/.
import 'hackbench-theia-extension/src/browser/style/palette.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import {
  bindViewContribution,
  FrontendApplicationContribution,
  WidgetFactory,
} from '@theia/core/lib/browser'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { PALETTE_SERVICE_PATH, PaletteService } from '../common/palette-protocol'
import { PaletteExplorerContribution } from './palette-explorer-contribution'
import { createPaletteExplorerWidget, PALETTE_EXPLORER_ID } from './palette-explorer-widget'
import { PaletteGroupViewWidget } from './palette-group-view-widget'
import { PALETTE_GROUP_VIEW_ID } from './palette-view-model'

export default new ContainerModule(bind => {
  // The frontend cannot touch the filesystem, so palette data is a proxy
  // onto the backend service over JSON-RPC, same as ProjectService.
  // Edits arrive as ProjectContext.onEdit, not through this proxy.
  bind(PaletteService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<PaletteService>(PALETTE_SERVICE_PATH)
    })
    .inSingletonScope()

  // The tree gets its own child container, same reason as the map and GFX
  // explorers: Theia builds a model, expansion service and selection service
  // per tree.
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: PALETTE_EXPLORER_ID,
      createWidget: () => createPaletteExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  // One widget per group or variant, keyed by PreviewTabs, so reopening focuses the existing tab.
  bind(PaletteGroupViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: PALETTE_GROUP_VIEW_ID,
      createWidget: () => ctx.container.get(PaletteGroupViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, PaletteExplorerContribution)
  bind(FrontendApplicationContribution).toService(PaletteExplorerContribution)
})
