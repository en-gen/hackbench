import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { GFX_SERVICE_PATH, GfxService } from '../common/gfx-protocol'
import { GfxServiceImpl } from './gfx-server'

export default new ContainerModule(bind => {
  bind(GfxServiceImpl).toSelf().inSingletonScope()
  bind(GfxService).toService(GfxServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx => new RpcConnectionHandler(GFX_SERVICE_PATH, () => ctx.container.get(GfxService)),
    )
    .inSingletonScope()
})
