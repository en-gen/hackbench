import { ContainerModule } from '@theia/core/shared/inversify'
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application'
import { AppIconContribution } from './icon-contribution'

export default new ContainerModule(bind => {
  bind(AppIconContribution).toSelf().inSingletonScope()
  bind(ElectronMainApplicationContribution).toService(AppIconContribution)
})
