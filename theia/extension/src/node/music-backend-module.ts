import { ContainerModule } from '@theia/core/shared/inversify'
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { MUSIC_SERVICE_PATH, MusicService } from '../common/music-protocol'
import { MusicServiceImpl } from './music-server'
import { BackendApplicationContribution } from '@theia/core/lib/node'
import { SpcAssetContribution } from './spc-assets'

export default new ContainerModule(bind => {
  // Serves spc.js and spc.wasm; the frontend loads both by URL because an
  // Emscripten global script does not survive the frontend bundler.
  bind(SpcAssetContribution).toSelf().inSingletonScope()
  bind(BackendApplicationContribution).toService(SpcAssetContribution)

  bind(MusicServiceImpl).toSelf().inSingletonScope()
  bind(MusicService).toService(MusicServiceImpl)
  bind(ConnectionHandler)
    .toDynamicValue(
      ctx => new RpcConnectionHandler(MUSIC_SERVICE_PATH, () => ctx.container.get(MusicService)),
    )
    .inSingletonScope()
})
