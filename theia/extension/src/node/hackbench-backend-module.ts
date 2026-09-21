import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { PROJECT_SERVICE_PATH, ProjectService } from '../common/project-protocol'
import { ProjectServiceImpl } from './project-server'

export default new ContainerModule(bind => {
  bind(ProjectServiceImpl).toSelf().inSingletonScope()
  bind(ProjectService).toService(ProjectServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        new RpcConnectionHandler(PROJECT_SERVICE_PATH, () => ctx.container.get(ProjectService)),
    )
    .inSingletonScope()
})
