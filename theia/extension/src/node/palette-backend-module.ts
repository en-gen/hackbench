import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { PALETTE_SERVICE_PATH, PaletteService } from '../common/palette-protocol'
import { PaletteServiceImpl } from './palette-server'

// No client to push to: edits reach the frontend as the one edit event on the
// project connection (working-copy-notifier.ts), so this is an ordinary
// singleton. WorkingRomRegistry still resolves from the same container.
export default new ContainerModule(bind => {
  bind(PaletteServiceImpl).toSelf().inSingletonScope()
  bind(PaletteService).toService(PaletteServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        new RpcConnectionHandler(PALETTE_SERVICE_PATH, () => ctx.container.get(PaletteService)),
    )
    .inSingletonScope()
})
