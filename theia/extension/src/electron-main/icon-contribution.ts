import { injectable } from '@theia/core/shared/inversify'
import type {
  ElectronMainApplication,
  ElectronMainApplicationContribution,
} from '@theia/core/lib/electron-main/electron-main-application'
import { appIconPath } from './icon-path'

// Main-window icon via the window options Theia merges into every Theia window.
// Secondary windows build their own options (a blank icon, deliberately) and
// are not touched.
@injectable()
export class AppIconContribution implements ElectronMainApplicationContribution {
  onStart(application: ElectronMainApplication): void {
    const electron = application.config.electron
    Object.assign(electron, { windowOptions: { ...electron.windowOptions, icon: appIconPath() } })
  }
}
