// Self-referencing package path rather than a relative one, matching
// hackbench-frontend-module.ts: this package compiles with rootDir at the
// repo root (see tsconfig.json, #391), so a relative path from lib/ would not
// land back in src/.
import 'hackbench-theia-extension/src/browser/style/map16.css'
import 'hackbench-theia-extension/src/browser/style/pixel-canvas.css'
import 'hackbench-theia-extension/src/browser/style/pixel-button.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import { WidgetFactory } from '@theia/core/lib/browser'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { MAP16_SERVICE_PATH, Map16Service } from '../common/map16-protocol'
import { Map16ViewWidget, MAP16_VIEW_ID } from './map16-view-widget'

export default new ContainerModule(bind => {
  // The frontend cannot touch the filesystem, so decoding is a proxy onto
  // the backend service over JSON-RPC, same shape as GfxService. Edits made
  // elsewhere arrive as ProjectContext.onEdit, not through this proxy.
  bind(Map16Service)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<Map16Service>(MAP16_SERVICE_PATH)
    })
    .inSingletonScope()

  // `toSelf()` and NOT inSingletonScope: WidgetManager caches by factory id
  // PLUS options, so it calls createWidget once per distinct key and each
  // call must yield a fresh instance. That is what gives `{ layer: 'fg' }`
  // and `{ layer: 'bg' }` two independent widgets - the previous factory
  // took no options, which is why only one ever existed.
  bind(Map16ViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MAP16_VIEW_ID,
      createWidget: () => ctx.container.get(Map16ViewWidget),
    }))
    .inSingletonScope()
})
