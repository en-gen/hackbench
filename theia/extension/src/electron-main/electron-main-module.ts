import { ContainerModule, injectable } from '@theia/core/shared/inversify'
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application'
import { appIconPath } from './icon-path'

// The initial window is created from getDefaultOptions() before any
// ElectronMainApplicationContribution.onStart runs, so the icon has to come
// from here. Secondary windows build their own options (they read only
// minWidth and a webPreferences flag from these); with the custom title bar
// (!useNativeWindowFrame) they set a blank icon of their own, otherwise they
// keep Electron's default. Either way they are unaffected.
@injectable()
export class HackBenchElectronMainApplication extends ElectronMainApplication {
  private icon?: { path?: string }

  protected override getDefaultOptions() {
    const options = super.getDefaultOptions()
    // Resolved once, so a missing asset warns once rather than per window.
    if (!this.icon) {
      this.icon = { path: appIconPath() }
      if (!this.icon.path) {
        console.warn('HackBench: icon file not found, using the default window icon')
      }
    }
    return this.icon.path ? { ...options, icon: this.icon.path } : options
  }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  bind(HackBenchElectronMainApplication).toSelf().inSingletonScope()
  rebind(ElectronMainApplication).toService(HackBenchElectronMainApplication)
})
