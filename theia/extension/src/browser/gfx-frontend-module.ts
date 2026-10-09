// Self-referencing package path rather than a relative one, matching
// hackbench-frontend-module.ts: this package compiles with rootDir at the
// repo root (see tsconfig.json, #391), so a relative path from lib/ would not
// land back in src/.
import 'hackbench-theia-extension/src/browser/style/gfx.css'
import 'hackbench-theia-extension/src/browser/style/pixel-canvas.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import {
  bindViewContribution,
  FrontendApplicationContribution,
  WidgetFactory,
} from '@theia/core/lib/browser'
import { CommandContribution, MenuContribution } from '@theia/core/lib/common'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { GFX_SERVICE_PATH, GfxService } from '../common/gfx-protocol'
import { GfxExplorerContribution } from './gfx-explorer-contribution'
import { createGfxExplorerWidget, GFX_EXPLORER_ID } from './gfx-explorer-widget'
import { GfxViewWidget, GFX_VIEW_ID } from './gfx-view-widget'
import { OverworldContribution } from './overworld-contribution'
import { OverworldViewWidget, OVERWORLD_VIEW_ID } from './overworld-view-widget'

export default new ContainerModule(bind => {
  // The frontend cannot touch the filesystem, so decoding is a proxy onto
  // the backend service over JSON-RPC, same shape as ProjectService. A
  // palette edit made elsewhere reaches an open sheet as ProjectContext.onEdit.
  bind(GfxService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<GfxService>(GFX_SERVICE_PATH)
    })
    .inSingletonScope()

  // The tree gets its own child container, same reason as the map explorer:
  // Theia builds a model, expansion service and selection service per tree.
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: GFX_EXPLORER_ID,
      createWidget: () => createGfxExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  // One widget per GFX file, keyed by index, so reopening a file focuses the
  // one already on screen instead of stacking duplicates.
  bind(GfxViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: GFX_VIEW_ID,
      createWidget: () => ctx.container.get(GfxViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, GfxExplorerContribution)
  bind(FrontendApplicationContribution).toService(GfxExplorerContribution)

  // The Overworld views read through GfxService too. One widget class: the preview tab and
  // every pinned area (keyed `{ area }`) are separate instances, each retargeted by open().
  bind(OverworldViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: OVERWORLD_VIEW_ID,
      createWidget: () => ctx.container.get(OverworldViewWidget),
    }))
    .inSingletonScope()
  bind(OverworldContribution).toSelf().inSingletonScope()
  bind(CommandContribution).toService(OverworldContribution)
  bind(MenuContribution).toService(OverworldContribution)
})
