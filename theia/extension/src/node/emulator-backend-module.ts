import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { EMULATOR_SERVICE_PATH, EmulatorService } from '../common/emulator-protocol'
import { EmulatorServiceImpl } from './emulator-server'

export default new ContainerModule(bind => {
  bind(EmulatorServiceImpl).toSelf().inSingletonScope()
  bind(EmulatorService).toService(EmulatorServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx =>
        new RpcConnectionHandler(EMULATOR_SERVICE_PATH, () => ctx.container.get(EmulatorService)),
    )
    .inSingletonScope()
})
