// Self-referencing package path rather than a relative one, matching
// hackbench-frontend-module.ts: this package compiles with rootDir at the
// repo root (see tsconfig.json, #391), so a relative path from lib/ would not
// land back in src/.
import 'hackbench-theia-extension/src/browser/style/map16.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import { WidgetFactory } from '@theia/core/lib/browser'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { MAP16_SERVICE_PATH, Map16Service } from '../common/map16-protocol'
import { Map16ViewWidget, MAP16_VIEW_ID } from './map16-view-widget'
import { Map16FrontendClient } from './map16-push-client'

export default new ContainerModule(bind => {
  bind(Map16FrontendClient).toSelf().inSingletonScope()

  // The frontend cannot touch the filesystem, so decoding is a proxy onto
  // the backend service over JSON-RPC, same shape as GfxService. The client
  // lets a palette (or Map16) edit made elsewhere push a re-render into an
  // already-open sheet.
  bind(Map16Service)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      const client = ctx.container.get(Map16FrontendClient)
      return provider.createProxy<Map16Service>(MAP16_SERVICE_PATH, client)
    })
    .inSingletonScope()

  // One widget for the whole view (there is exactly one Map16 block table
  // per project, unlike GFX's per-file tabs), reached through PreviewTabs
  // with an empty key - WidgetManager's own cache is what makes repeat
  // opens reuse it, the same mechanism GfxViewWidget relies on for its keyed
  // per-index tabs.
  bind(Map16ViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MAP16_VIEW_ID,
      createWidget: () => ctx.container.get(Map16ViewWidget),
    }))
    .inSingletonScope()
})
