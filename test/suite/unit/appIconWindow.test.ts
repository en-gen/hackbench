import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import * as path from 'path'

// Electron cannot run under vitest, so `electron` is swapped for a stub in the
// CJS cache before Theia loads, and this checks the option object the first
// window is built from. The verifier proves the real window at launch.
const req = createRequire(path.resolve(__dirname, '../../../theia/extension/package.json'))
const electronPath = req.resolve('electron', { paths: [req.resolve('@theia/core/package.json')] })
req.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { nativeTheme: { shouldUseDarkColors: false } },
} as unknown as NodeJS.Module
const { HackBenchElectronMainApplication } =
  await import('../../../theia/extension/src/electron-main/electron-main-module')
const { appIconPath } = await import('../../../theia/extension/src/electron-main/icon-path')

describe('main window options', () => {
  it('getDefaultOptions carries the icon, which is what the first window is built from', () => {
    const app = Object.create(HackBenchElectronMainApplication.prototype)
    Object.defineProperty(app, 'config', { value: { electron: { windowOptions: {} } } })
    expect(app.getDefaultOptions().icon).toBe(appIconPath())
  })
})
