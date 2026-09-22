import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { PROJECT_SERVICE_PATH, ProjectService } from '../common/project-protocol'
import { ProjectServiceImpl } from './project-server'
import { WorkingRomRegistry } from '../../../../src/project/WorkingRomRegistry'

export default new ContainerModule(bind => {
  // One shared instance for the whole backend: palette-server.ts writes
  // through it, gfx-server.ts reads through it, and project-server.ts
  // exports through it. `toDynamicValue` rather than `toSelf()` because
  // WorkingRomRegistry is plain TypeScript (src/project/ carries zero Theia
  // imports) and so is not `@injectable()`.
  bind(WorkingRomRegistry)
    .toDynamicValue(() => new WorkingRomRegistry())
    .inSingletonScope()

  bind(ProjectServiceImpl).toSelf().inSingletonScope()
  bind(ProjectService).toService(ProjectServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        new RpcConnectionHandler(PROJECT_SERVICE_PATH, () => ctx.container.get(ProjectService)),
    )
    .inSingletonScope()
})
