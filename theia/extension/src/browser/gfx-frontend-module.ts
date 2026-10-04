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
import { GfxFrontendClient } from './gfx-push-client'
import { OverworldContribution } from './overworld-contribution'
import {
  OverworldAreaOptions,
  OverworldViewWidget,
  OVERWORLD_AREA_VIEW_ID,
  OVERWORLD_VIEW_ID,
} from './overworld-view-widget'

export default new ContainerModule(bind => {
  bind(GfxFrontendClient).toSelf().inSingletonScope()

  // The frontend cannot touch the filesystem, so decoding is a proxy onto
  // the backend service over JSON-RPC, same shape as ProjectService. The
  // client lets a palette edit made elsewhere push a re-render into an
  // already-open sheet, rather than the user needing to reopen it.
  bind(GfxService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      const client = ctx.container.get(GfxFrontendClient)
      return provider.createProxy<GfxService>(GFX_SERVICE_PATH, client)
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

  // The Overworld view reads through GfxService too. WidgetManager caches by
  // factory id, so there is one Overworld widget.
  bind(OverworldViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: OVERWORLD_VIEW_ID,
      createWidget: () => ctx.container.get(OverworldViewWidget),
    }))
    .inSingletonScope()
  // One tab per area: WidgetManager keys it by `{ area }`, and the widget learns its area
  // from a child container, so no hub load runs for it.
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: OVERWORLD_AREA_VIEW_ID,
      createWidget: (options: OverworldAreaOptions) => {
        const child = ctx.container.createChild()
        child.bind(OverworldAreaOptions).toConstantValue({ area: options.area })
        child.bind(OverworldViewWidget).toSelf()
        return child.get(OverworldViewWidget)
      },
    }))
    .inSingletonScope()
  bind(OverworldContribution).toSelf().inSingletonScope()
  bind(CommandContribution).toService(OverworldContribution)
  bind(MenuContribution).toService(OverworldContribution)
})
