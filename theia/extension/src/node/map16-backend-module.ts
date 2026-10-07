import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { MAP16_SERVICE_PATH, Map16Service } from '../common/map16-protocol'
import { Map16ServiceImpl } from './map16-server'

// No client to push to: see palette-backend-module.ts.
export default new ContainerModule(bind => {
  bind(Map16ServiceImpl).toSelf().inSingletonScope()
  bind(Map16Service).toService(Map16ServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx => new RpcConnectionHandler(MAP16_SERVICE_PATH, () => ctx.container.get(Map16Service)),
    )
    .inSingletonScope()
})
