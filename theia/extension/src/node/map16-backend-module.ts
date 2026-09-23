import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { MAP16_SERVICE_PATH, Map16Service, Map16ServiceClient } from '../common/map16-protocol'
import { Map16ServiceImpl } from './map16-server'

export default new ContainerModule(bind => {
  bind(Map16ServiceImpl).toSelf().inSingletonScope()
  bind(Map16Service).toService(Map16ServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        // Registering the client is what lets a palette edit - or a Map16
        // edit made through this very connection - push "re-render" to
        // whatever Map16 view is open, the same shape as gfx-backend-module.ts.
        new RpcConnectionHandler<Map16ServiceClient>(MAP16_SERVICE_PATH, client => {
          const server = ctx.container.get<Map16Service>(Map16Service)
          server.setClient(client)
          return server
        }),
    )
    .inSingletonScope()
})
