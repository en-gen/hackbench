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
import { PaletteViewWidget, PALETTE_VIEW_ID } from './palette-view-widget'
import { PaletteViewContribution } from './palette-view-contribution'
import { PaletteFrontendClient } from './palette-push-client'

export default new ContainerModule(bind => {
  bind(PaletteFrontendClient).toSelf().inSingletonScope()

  // The frontend cannot touch the filesystem, so palette data is a proxy
  // onto the backend service over JSON-RPC, same as ProjectService. The
  // client (this connection's push target) is bound independent of the
  // widget's own lifecycle: a push can arrive before the view is ever opened.
  bind(PaletteService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      const client = ctx.container.get(PaletteFrontendClient)
      return provider.createProxy<PaletteService>(PALETTE_SERVICE_PATH, client)
    })
    .inSingletonScope()

  bind(PaletteViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: PALETTE_VIEW_ID,
      createWidget: () => ctx.container.get(PaletteViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, PaletteViewContribution)
  bind(FrontendApplicationContribution).toService(PaletteViewContribution)
})
