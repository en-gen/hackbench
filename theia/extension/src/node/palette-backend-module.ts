import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import {
  PALETTE_SERVICE_PATH,
  PaletteService,
  PaletteServiceClient,
} from '../common/palette-protocol'
import { PaletteServiceImpl } from './palette-server'

export default new ContainerModule(bind => {
  bind(PaletteServiceImpl).toSelf().inSingletonScope()
  bind(PaletteService).toService(PaletteServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        // The client passed to the handler's factory is THIS connection's proxy
        // back to the frontend; registering it is what lets setColor's own
        // writer (and, via WorkingRomRegistry, any other service touching the
        // same project) push "re-render" to the widget that opened it.
        new RpcConnectionHandler<PaletteServiceClient>(PALETTE_SERVICE_PATH, client => {
          const server = ctx.container.get<PaletteService>(PaletteService)
          server.setClient(client)
          return server
        }),
    )
    .inSingletonScope()
})
