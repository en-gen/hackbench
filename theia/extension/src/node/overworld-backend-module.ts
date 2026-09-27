import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module'
import {
  OVERWORLD_SERVICE_PATH,
  OverworldService,
  OverworldServiceClient,
} from '../common/overworld-protocol'
import { OverworldServiceImpl } from './overworld-server'

// One OverworldServiceImpl per CONNECTION - see palette-backend-module.ts.
const overworldConnectionModule = ConnectionContainerModule.create(
  ({ bind, bindBackendService }) => {
    bind(OverworldServiceImpl).toSelf().inSingletonScope()
    bind(OverworldService).toService(OverworldServiceImpl)
    bindBackendService<OverworldService, OverworldServiceClient>(
      OVERWORLD_SERVICE_PATH,
      OverworldService,
      (server, client) => {
        server.setClient(client)
        client.onDidCloseConnection(() => server.setClient(undefined))
        return server
      },
    )
  },
)

export default new ContainerModule(bind => {
  bind(ConnectionContainerModule).toConstantValue(overworldConnectionModule)
})
