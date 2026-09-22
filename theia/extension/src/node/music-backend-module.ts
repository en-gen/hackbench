import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { MUSIC_SERVICE_PATH, MusicService } from '../common/music-protocol'
import { MusicServiceImpl } from './music-server'

export default new ContainerModule(bind => {
  bind(MusicServiceImpl).toSelf().inSingletonScope()
  bind(MusicService).toService(MusicServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx => new RpcConnectionHandler(MUSIC_SERVICE_PATH, () => ctx.container.get(MusicService)),
    )
    .inSingletonScope()
})
