// Self-referencing package path, same reason as hackbench-frontend-module.ts:
// this package compiles with rootDir at the repo root (#391).
import 'hackbench-theia-extension/src/browser/style/emulator.css'
import 'hackbench-theia-extension/src/browser/style/volume.css'
import 'hackbench-theia-extension/src/browser/style/save-slots.css'
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
import { EMULATOR_SERVICE_PATH, EmulatorService } from '../common/emulator-protocol'
import { EmulatorContribution } from './emulator-contribution'
import { EmulatorWidget, EMULATOR_VIEW_ID } from './emulator-widget'

export default new ContainerModule(bind => {
  bind(EmulatorService)
    .toDynamicValue(ctx => {
      const provider = ctx.container.get<ServiceConnectionProvider>(RemoteConnectionProvider)
      return provider.createProxy<EmulatorService>(EMULATOR_SERVICE_PATH)
    })
    .inSingletonScope()

  // Not a singleton binding on the class itself: WidgetManager owns one
  // instance per id, keyed the same way MapViewWidget's factory is.
  bind(EmulatorWidget).toSelf()
  bind(WidgetFactory)
    .toDynamicValue(ctx => ({
      id: EMULATOR_VIEW_ID,
      createWidget: () => ctx.container.get(EmulatorWidget),
    }))
    .inSingletonScope()

  bindViewContribution(bind, EmulatorContribution)
  bind(FrontendApplicationContribution).toService(EmulatorContribution)
})
