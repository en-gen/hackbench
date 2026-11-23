import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { OBJECTS_SERVICE_PATH, ObjectsService } from '../common/objects-protocol'
import { ObjectsServiceImpl } from './objects-server'

// No client to push to: see palette-backend-module.ts.
export default new ContainerModule(bind => {
  bind(ObjectsServiceImpl).toSelf().inSingletonScope()
  bind(ObjectsService).toService(ObjectsServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        new RpcConnectionHandler(OBJECTS_SERVICE_PATH, () => ctx.container.get(ObjectsService)),
    )
    .inSingletonScope()
})
