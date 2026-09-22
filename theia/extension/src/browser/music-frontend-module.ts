// Self-referencing package path, same reason as hackbench-frontend-module.ts:
// this package compiles with rootDir at the repo root (tsconfig.json, #391).
import 'hackbench-theia-extension/src/browser/style/music.css'
import { ContainerModule } from '@theia/core/shared/inversify'
import {
  FrontendApplicationContribution,
  WidgetFactory,
  bindViewContribution,
} from '@theia/core/lib/browser'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { MUSIC_SERVICE_PATH, MusicService } from '../common/music-protocol'
import { createMusicExplorerWidget, MUSIC_EXPLORER_ID } from './music-explorer-widget'
import { MusicViewWidget, MUSIC_VIEW_ID } from './music-view-widget'
import { MusicExplorerContribution } from './music-explorer-contribution'

export default new ContainerModule(bind => {
  // The frontend cannot touch the filesystem, so reading the cartridge is a
  // proxy onto the backend service over JSON-RPC, same as ProjectService.
  bind(MusicService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<MusicService>(MUSIC_SERVICE_PATH)
    })
    .inSingletonScope()

  // The tree gets its own child container, same reason as the map explorer:
  // Theia builds a model, expansion service and selection service per tree.
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MUSIC_EXPLORER_ID,
      createWidget: () => createMusicExplorerWidget(ctx.container),
    }))
    .inSingletonScope()

  // One widget per track, keyed by BGM command, so reopening a track focuses
  // the one already on screen instead of stacking duplicates.
  bind(MusicViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: MUSIC_VIEW_ID,
      createWidget: () => ctx.container.get(MusicViewWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, MusicExplorerContribution)
  bind(FrontendApplicationContribution).toService(MusicExplorerContribution)
})
