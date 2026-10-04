/** Electron-main side of the OS country bridge; see common/os-locale-protocol.ts. */
import { ContainerModule } from '@theia/core/shared/inversify'
import { RpcConnectionHandler } from '@theia/core/lib/common/messaging'
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler'
import { app } from '@theia/electron/shared/electron'
import { OS_LOCALE_PATH, OsLocaleService } from '../common/os-locale-protocol'

export default new ContainerModule(bind => {
  bind(ElectronConnectionHandler)
    .toDynamicValue(
      () =>
        new RpcConnectionHandler<OsLocaleService>(OS_LOCALE_PATH, () => ({
          countryCode: async () => app.getLocaleCountryCode(),
        })),
    )
    .inSingletonScope()
})
