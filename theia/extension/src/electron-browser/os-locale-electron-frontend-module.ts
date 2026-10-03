/** Electron-only frontend binding: the browser build binds nothing and the widget falls back. */
import { ContainerModule } from '@theia/core/shared/inversify'
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source'
import { OS_LOCALE_PATH, OsLocaleService } from '../common/os-locale-protocol'

export default new ContainerModule(bind => {
  bind(OsLocaleService)
    .toDynamicValue(ctx =>
      ElectronIpcConnectionProvider.createProxy<OsLocaleService>(ctx.container, OS_LOCALE_PATH),
    )
    .inSingletonScope()
})
