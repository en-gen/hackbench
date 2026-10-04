import { ContainerModule, injectable } from '@theia/core/shared/inversify'
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application'
import { appIconPath } from './icon-path'

// The initial window is created from getDefaultOptions() before any
// ElectronMainApplicationContribution.onStart runs, so the icon has to come
// from here. Secondary windows build their own options (they read only
// minWidth and a webPreferences flag from these) and set a blank `icon` of
// their own, so they are unaffected.
@injectable()
export class HackBenchElectronMainApplication extends ElectronMainApplication {
  protected override getDefaultOptions() {
    const options = super.getDefaultOptions()
    const icon = appIconPath()
    if (!icon) {
      console.warn('HackBench: icon file not found, using the default window icon')
      return options
    }
    return { ...options, icon }
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(HackBenchElectronMainApplication).toSelf().inSingletonScope()
  rebind(ElectronMainApplication).toService(HackBenchElectronMainApplication)
})
