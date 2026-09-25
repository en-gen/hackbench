import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module'
import {
  PROJECT_SERVICE_PATH,
  ProjectService,
  ProjectServiceClient,
} from '../common/project-protocol'
import { ProjectServiceImpl } from './project-server'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'

// One ProjectServiceImpl per CONNECTION: see working-copy-notifier.ts for
// why a shared instance is the wrong shape for a service that pushes.
const projectConnectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
  bind(ProjectServiceImpl).toSelf().inSingletonScope()
  bind(ProjectService).toService(ProjectServiceImpl)
  bindBackendService<ProjectService, ProjectServiceClient>(
    PROJECT_SERVICE_PATH,
    ProjectService,
    (server, client) => {
      // onDidCloseConnection is this connection's own close event.
      server.setClient(client)
      client.onDidCloseConnection(() => server.setClient(undefined))
      return server
    },
  )
})

export default new ContainerModule(bind => {
  // `toDynamicValue` rather than `toSelf()`: WorkingRomRegistry is plain
  // TypeScript, not `@injectable()`. Bound in the PARENT container - the
  // per-connection services above still resolve it from here.
  bind(WorkingRomRegistry)
    .toDynamicValue(() => new WorkingRomRegistry())
    .inSingletonScope()

  bind(ConnectionContainerModule).toConstantValue(projectConnectionModule)
})
