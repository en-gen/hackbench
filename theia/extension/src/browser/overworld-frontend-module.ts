import { ContainerModule } from '@theia/core/shared/inversify'
import {
  bindViewContribution,
  FrontendApplicationContribution,
  WidgetFactory,
} from '@theia/core/lib/browser'
import {
  RemoteConnectionProvider,
  ServiceConnectionProvider,
} from '@theia/core/lib/browser/messaging/service-connection-provider'
import { OVERWORLD_SERVICE_PATH, OverworldService } from '../common/overworld-protocol'
import {
  OverworldContribution,
  OverworldLauncherWidget,
  OVERWORLD_LAUNCHER_ID,
} from './overworld-contribution'
import {
  OverworldFrontendClient,
  OverworldViewWidget,
  OVERWORLD_VIEW_ID,
} from './overworld-view-widget'

export default new ContainerModule(bind => {
  bind(OverworldFrontendClient).toSelf().inSingletonScope()
  bind(OverworldService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<OverworldService>(
        OVERWORLD_SERVICE_PATH,
        ctx.container.get(OverworldFrontendClient),
      )
    })
    .inSingletonScope()

  // WidgetManager caches by factory id, so there is one Overworld widget.
  bind(OverworldViewWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: OVERWORLD_VIEW_ID,
      createWidget: () => ctx.container.get(OverworldViewWidget),
    }))
    .inSingletonScope()
  bind(WidgetFactory)
    .toDynamicValue(() => ({
      id: OVERWORLD_LAUNCHER_ID,
      createWidget: () => new OverworldLauncherWidget(),
    }))
    .inSingletonScope()

  bindViewContribution(bind, OverworldContribution)
  bind(FrontendApplicationContribution).toService(OverworldContribution)
})
