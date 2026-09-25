import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module'
import {
  PALETTE_SERVICE_PATH,
  PaletteService,
  PaletteServiceClient,
} from '../common/palette-protocol'
import { PaletteServiceImpl } from './palette-server'

// One PaletteServiceImpl per CONNECTION - see hackbench-backend-module.ts.
// WorkingRomRegistry still resolves from the parent container.
const paletteConnectionModule = ConnectionContainerModule.create(({ bind, bindBackendService }) => {
  bind(PaletteServiceImpl).toSelf().inSingletonScope()
  bind(PaletteService).toService(PaletteServiceImpl)
  bindBackendService<PaletteService, PaletteServiceClient>(
    PALETTE_SERVICE_PATH,
    PaletteService,
    (server, client) => {
      server.setClient(client)
      client.onDidCloseConnection(() => server.setClient(undefined))
      return server
    },
  )
})

export default new ContainerModule(bind => {
  bind(ConnectionContainerModule).toConstantValue(paletteConnectionModule)
})
