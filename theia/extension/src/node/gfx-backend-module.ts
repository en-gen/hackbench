import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { GFX_SERVICE_PATH, GfxService, GfxServiceClient } from '../common/gfx-protocol'
import { GfxServiceImpl } from './gfx-server'

export default new ContainerModule(bind => {
  bind(GfxServiceImpl).toSelf().inSingletonScope()
  bind(GfxService).toService(GfxServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        // Registering the client is what lets a palette edit (or any other
        // change to this project's WorkingRom) push "re-render" to whatever
        // GFX view is open, without the view polling or the user reloading.
        new RpcConnectionHandler<GfxServiceClient>(GFX_SERVICE_PATH, client => {
          const server = ctx.container.get<GfxService>(GfxService)
          server.setClient(client)
          return server
        }),
    )
    .inSingletonScope()
})
