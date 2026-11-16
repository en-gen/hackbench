// Self-referencing package path: see map16-frontend-module.ts.
import 'hackbench-theia-extension/src/browser/style/objects.css'
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
import { OBJECTS_SERVICE_PATH, ObjectsService } from '../common/objects-protocol'
import { ObjectsContribution } from './objects-contribution'
import { ObjectsWidget, OBJECTS_VIEW_ID } from './objects-widget'

export default new ContainerModule(bind => {
  bind(ObjectsService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<ObjectsService>(OBJECTS_SERVICE_PATH)
    })
    .inSingletonScope()

  bind(ObjectsWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: OBJECTS_VIEW_ID,
      createWidget: () => ctx.container.get(ObjectsWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, ObjectsContribution)
  bind(FrontendApplicationContribution).toService(ObjectsContribution)
})
