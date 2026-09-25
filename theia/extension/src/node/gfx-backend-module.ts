import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module'
import { GFX_SERVICE_PATH, GfxService, GfxServiceClient } from '../common/gfx-protocol'
import { GfxServiceImpl } from './gfx-server'

// One GfxServiceImpl per CONNECTION - see palette-backend-module.ts.
const gfxConnectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
  bind(GfxServiceImpl).toSelf().inSingletonScope()
  bind(GfxService).toService(GfxServiceImpl)
  bindBackendService<GfxService, GfxServiceClient>(
    GFX_SERVICE_PATH,
    GfxService,
    (server, client) => {
      server.setClient(client)
      client.onDidCloseConnection(() => server.setClient(undefined))
      return server
    },
  )
})

export default new ContainerModule(bind => {
  bind(ConnectionContainerModule).toConstantValue(gfxConnectionModule)
})
