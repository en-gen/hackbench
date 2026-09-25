import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module'
import { MAP16_SERVICE_PATH, Map16Service, Map16ServiceClient } from '../common/map16-protocol'
import { Map16ServiceImpl } from './map16-server'

// One Map16ServiceImpl per CONNECTION - see palette-backend-module.ts.
const map16ConnectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
  bind(Map16ServiceImpl).toSelf().inSingletonScope()
  bind(Map16Service).toService(Map16ServiceImpl)
  bindBackendService<Map16Service, Map16ServiceClient>(
    MAP16_SERVICE_PATH,
    Map16Service,
    (server, client) => {
      server.setClient(client)
      client.onDidCloseConnection(() => server.setClient(undefined))
      return server
    },
  )
})

export default new ContainerModule(bind => {
  bind(ConnectionContainerModule).toConstantValue(map16ConnectionModule)
})
