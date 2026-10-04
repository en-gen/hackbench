import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../../theia/extension/src/electron-main/icon-path', async importActual => {
  const actual =
    await importActual<typeof import('../../../theia/extension/src/electron-main/icon-path')>()
  return { appIconPath: vi.fn(actual.appIconPath) }
})
import { createRequire } from 'module'
import * as fs from 'fs'
import * as path from 'path'

// Needs the theia/ workspace, which the unit CI job does not install, so the
// whole body is guarded (ConnectionDi.test.ts does the same). Electron cannot
// run under vitest: `electron` is swapped for a stub in the CJS cache before
// Theia loads. The verifier proves the real window at launch.
const root = path.resolve(__dirname, '../../..')
const T = '../../../theia/node_modules/@theia/core/'
const theiaInstalled = fs.existsSync(path.join(root, 'theia/node_modules/@theia/core/package.json'))

describe.skipIf(!theiaInstalled)('main window icon wiring', () => {
  let App: abstract new (...args: never[]) => object
  let Ours: typeof import('../../../theia/extension/src/electron-main/electron-main-module').HackBenchElectronMainApplication
  let oursModule: typeof import('../../../theia/extension/src/electron-main/electron-main-module')
  let appIconPath: typeof import('../../../theia/extension/src/electron-main/icon-path').appIconPath

  beforeAll(async () => {
    const req = createRequire(path.join(root, 'theia/extension/package.json'))
    const electronPath = req.resolve('electron', {
      paths: [req.resolve('@theia/core/package.json')],
    })
    req.cache[electronPath] = {
      id: electronPath,
      filename: electronPath,
      loaded: true,
      exports: {
        nativeTheme: { shouldUseDarkColors: false },
        app: { getAppPath: () => root, getPath: () => root, on: () => {}, isPackaged: false },
      },
    } as unknown as NodeJS.Module
    await import(path.join(root, 'theia/node_modules/reflect-metadata'))
    App = (await import(T + 'lib/electron-main/electron-main-application')).ElectronMainApplication
    oursModule = await import('../../../theia/extension/src/electron-main/electron-main-module')
    Ours = oursModule.HackBenchElectronMainApplication
    appIconPath = (await import('../../../theia/extension/src/electron-main/icon-path')).appIconPath
  })
  afterEach(() => vi.restoreAllMocks())

  const options = () => {
    const app = Object.create(Ours.prototype)
    Object.defineProperty(app, 'config', { value: { electron: { windowOptions: {} } } })
    return app.getDefaultOptions()
  }

  it('getDefaultOptions carries the icon, which the first window is built from', () => {
    expect(options().icon).toBe(appIconPath())
  })

  it('warns and omits the icon when the asset is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(appIconPath).mockReturnValueOnce(undefined)
    const app = Object.create(Ours.prototype)
    Object.defineProperty(app, 'config', { value: { electron: { windowOptions: {} } } })
    expect(app.getDefaultOptions().icon).toBeUndefined()
    expect(app.getDefaultOptions().icon).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('the container resolves ElectronMainApplication to our subclass', async () => {
    const { Container } = await import(T + 'shared/inversify')
    const core = (await import(T + 'lib/electron-main/electron-main-application-module')).default
    const container = new Container()
    const { ElectronMainApplicationGlobals } = await import(
      T + 'lib/electron-main/electron-main-constants'
    )
    container.bind(ElectronMainApplicationGlobals).toConstantValue({})
    container.load(core, oursModule.default)
    const first = container.get(App)
    expect(first).toBeInstanceOf(Ours)
    // Theia injects ElectronMainApplication elsewhere; a transient binding
    // would hand those an instance that was never started.
    expect(container.get(App)).toBe(first)
  })
})
