/**
 * The Playwright suite never touches the per-machine state of whoever runs it
 * (#637). A run used to snapshot recent-projects.json and the registries,
 * write the real ones through the server under test, and restore the
 * snapshot at the end, discarding whatever the user did in between.
 *
 * Runs with no ROM. The "real" app-data folder is a fake home, so the test
 * never reads or writes the actual one on the machine running it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'module'
import { spawnSync, type SpawnOptions } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appDataDir } from '../../../src/project/appData'
import { RecentProjects, defaultRecentPath } from '../../../src/project/RecentProjects'
import { defaultRegistryPath } from '../../../src/project/RomRegistry'
import { defaultCoreRegistryPath } from '../../../src/project/CoreRegistry'

const nodeRequire = createRequire(__filename)
const BROWSER_APP = path.resolve(__dirname, '../../../theia/browser-app')
const CONFIG = path.join(BROWSER_APP, 'playwright.config.cjs')
const ISOLATION = path.join(BROWSER_APP, 'test/app-data.cjs')
const { backendSpawnArgs } = nodeRequire(path.join(BROWSER_APP, 'test/own-backend.cjs'))
const { prepareTestServer, MARKER } = nodeRequire(
  path.join(BROWSER_APP, 'test/start-test-server.cjs'),
)

const ENV_KEYS = [
  'APPDATA',
  'XDG_DATA_HOME',
  'USERPROFILE',
  'HOME',
  'HB_APP_URL',
  'HB_TEST_APPDATA',
  'HB_TEST_APPDATA_OWNER',
  'THEIA_CONFIG_DIR',
]
const BEFORE = JSON.stringify({ version: 1, projects: [] })
const USER_EDIT = JSON.stringify({
  version: 1,
  projects: [{ manifestPath: 'C:/mine/Mine.hbproj', name: 'Mine', title: 'Mine', lastOpened: '' }],
})

let saved: Record<string, string | undefined>
let fakeHome: string
let realFile: string

interface Isolation {
  cleanupAppData(): void
}

/** Loads the config the way Playwright does in each process: fresh module state. */
function loadConfig(): { config: any; iso: Isolation } {
  delete nodeRequire.cache[CONFIG]
  delete nodeRequire.cache[ISOLATION]
  const config = nodeRequire(CONFIG)
  return { config, iso: nodeRequire(ISOLATION) }
}

/** The app data a child process actually sees when spawned with these options. */
function childEnv(options: SpawnOptions): { a?: string; x?: string; t?: string } {
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      'const e=process.env;process.stdout.write(JSON.stringify({a:e.APPDATA,x:e.XDG_DATA_HOME,t:e.THEIA_CONFIG_DIR}))',
    ],
    { ...options, stdio: 'pipe', encoding: 'utf8' },
  )
  return JSON.parse(String(r.stdout))
}

const isUnder = (child: string, parent: string) => {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

interface Harness {
  setup(): void
  teardown(): void
}

/**
 * A spec run that overlaps real use: the user opens a project of their own
 * mid-run, then a spec creates one through the server. The real file must
 * end up holding exactly the user's edit.
 */
function runOverlapping(h: Harness) {
  h.setup()
  const afterSetup = fs.readFileSync(realFile, 'utf8')
  fs.writeFileSync(realFile, USER_EDIT)
  const specWroteTo = defaultRecentPath()
  new RecentProjects(specWroteTo).remember({ manifestPath: 'spec.hbproj', name: 's', title: 's' })
  const specWrote = fs.existsSync(specWroteTo)
  h.teardown()
  return { afterSetup, specWroteTo, specWrote, after: fs.readFileSync(realFile, 'utf8') }
}

// appData.ts ignores the environment on macOS, so the config refuses there.
describe.skipIf(process.platform === 'darwin')('Playwright app-data isolation (#637)', () => {
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-fakehome-'))
    process.env.USERPROFILE = process.env.HOME = fakeHome
    process.env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming')
    process.env.XDG_DATA_HOME = path.join(fakeHome, '.local', 'share')
    for (const k of ['HB_APP_URL', 'HB_TEST_APPDATA', 'HB_TEST_APPDATA_OWNER', 'THEIA_CONFIG_DIR'])
      delete process.env[k]
    fs.mkdirSync(appDataDir(), { recursive: true })
    realFile = path.join(appDataDir(), 'recent-projects.json')
    expect(realFile.startsWith(fakeHome)).toBe(true)
    fs.writeFileSync(realFile, BEFORE)
  })

  afterEach(() => {
    // A failing case never reaches cleanupAppData; do not leak its folder.
    const left = process.env.HB_TEST_APPDATA
    if (left && isUnder(left, os.tmpdir())) fs.rmSync(left, { recursive: true, force: true })
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    fs.rmSync(fakeHome, { recursive: true, force: true })
  })

  it('a run writes per-machine files to a temp folder, and a real recent-projects.json it overlaps survives', () => {
    let iso: Isolation | undefined
    let root = ''
    const r = runOverlapping({
      setup: () => {
        iso = loadConfig().iso
        root = process.env.HB_TEST_APPDATA!
      },
      teardown: () => iso!.cleanupAppData(),
    })
    expect(isUnder(root, os.tmpdir())).toBe(true)
    expect(appDataDir()).toBe(path.join(root, 'hackbench'))
    for (const p of [r.specWroteTo, defaultRegistryPath(), defaultCoreRegistryPath()]) {
      expect(isUnder(p, root)).toBe(true)
    }
    expect(r.specWrote).toBe(true)
    expect(r.afterSetup).toBe(BEFORE)
    expect(r.after).toBe(USER_EDIT)
    expect(fs.existsSync(root)).toBe(false)
  })

  it('the webServer and own-backend servers inherit the per-run folder', () => {
    const { config } = loadConfig()
    const root = process.env.HB_TEST_APPDATA!
    expect(config.webServer.reuseExistingServer).toBe(false)
    const wsEnv = config.webServer.env ?? {}
    for (const k of ['APPDATA', 'XDG_DATA_HOME', 'HB_TEST_APPDATA'])
      expect(wsEnv).not.toHaveProperty(k)
    // Playwright's own merge for the webServer process.
    expect(childEnv({ env: { ...process.env, ...wsEnv } })).toMatchObject({ a: root, x: root })
    const [, , options] = backendSpawnArgs(3999)
    expect(childEnv(options)).toMatchObject({ a: root, x: root })
  })

  it("a worker reloading the config shares the runner's folder and does not delete it", () => {
    const runner = loadConfig().iso
    const root = process.env.HB_TEST_APPDATA!
    const worker = loadConfig().iso
    expect(process.env.HB_TEST_APPDATA).toBe(root)
    worker.cleanupAppData()
    expect(fs.existsSync(root)).toBe(true)
    runner.cleanupAppData()
    expect(fs.existsSync(root)).toBe(false)
  })

  it('a pre-set HB_TEST_APPDATA that no runner created is refused', () => {
    process.env.HB_TEST_APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-preset-'))
    expect(() => loadConfig()).toThrow(/HB_TEST_APPDATA/)
  })

  it('an inherited folder outside the temp dir is refused', () => {
    process.env.HB_TEST_APPDATA = path.join(path.parse(os.tmpdir()).root, 'hb-not-temp')
    process.env.HB_TEST_APPDATA_OWNER = String(process.pid)
    expect(() => loadConfig()).toThrow(/temp dir/)
  })

  it('HB_APP_URL is refused without a start-test-server folder for that port', () => {
    process.env.HB_APP_URL = 'http://127.0.0.1:3999'
    expect(() => loadConfig()).toThrow(/start-test-server/)
    process.env.HB_TEST_APPDATA = prepareTestServer(3998).root
    expect(() => loadConfig()).toThrow(/start-test-server/)
  })

  it('HB_APP_URL runs against the start-test-server folder for that port, and keeps it', () => {
    const { root } = prepareTestServer(3999)
    process.env.HB_APP_URL = 'http://127.0.0.1:3999'
    process.env.HB_TEST_APPDATA = root
    loadConfig().iso.cleanupAppData()
    expect(appDataDir()).toBe(path.join(root, 'hackbench'))
    expect(fs.existsSync(root)).toBe(true)
  })

  it('start-test-server gives its server the folder it names, and marks it with the port', () => {
    const { root, env } = prepareTestServer(3999)
    try {
      expect(isUnder(root, os.tmpdir())).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8')).port).toBe(3999)
      const [, , options] = backendSpawnArgs(3999, { env })
      const seen = childEnv(options)
      expect(seen).toMatchObject({ a: root, x: root })
      expect(isUnder(seen.t!, root)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('stale per-run folders older than a day are swept, and nothing else', () => {
    const mk = (name: string, ageDays: number) => {
      const p = path.join(os.tmpdir(), name)
      fs.mkdirSync(p, { recursive: true })
      const t = Date.now() / 1000 - ageDays * 86400
      fs.utimesSync(p, t, t)
      return p
    }
    const stale = mk(`hb-appdata-stale${process.pid}`, 2)
    const fresh = mk(`hb-appdata-fresh${process.pid}`, 0)
    const other = mk(`hb-other-old${process.pid}`, 2)
    try {
      loadConfig().iso.cleanupAppData()
      expect([fs.existsSync(stale), fs.existsSync(fresh), fs.existsSync(other)]).toEqual([
        false,
        true,
        true,
      ])
    } finally {
      for (const p of [stale, fresh, other]) fs.rmSync(p, { recursive: true, force: true })
    }
  })

  it('macOS is refused before any folder is made, without blaming HB_APP_URL', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      expect(() => loadConfig()).toThrow(/macOS/)
      expect(() => loadConfig()).not.toThrow(/HB_APP_URL/)
      expect(process.env.HB_TEST_APPDATA).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  // The overlap oracle must be able to fail. Two harness shapes that shipped
  // or nearly shipped, each run through the same scenario.
  it('planted: a harness that does not isolate turns the oracle red', () => {
    const r = runOverlapping({ setup() {}, teardown() {} })
    expect(r.specWroteTo).toBe(realFile)
    expect(r.after).not.toBe(USER_EDIT)
  })

  it('planted: snapshot and restore of the real folder turns the oracle red', () => {
    let snapshot = ''
    const r = runOverlapping({
      setup: () => (snapshot = fs.readFileSync(realFile, 'utf8')),
      teardown: () => fs.writeFileSync(realFile, snapshot),
    })
    expect(r.after).toBe(BEFORE)
  })
})
