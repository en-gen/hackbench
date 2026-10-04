/**
 * Creating, reopening and re-describing a project.
 *
 * The defect these guard against is drift between create and open: a project
 * that shows its maps when created but not when reopened looks like data loss
 * to whoever hits it, and no assertion about creation alone can see it.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords } = require('./rom-words.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) { return getSvc('WidgetManager').getOrCreateWidget(id) }`

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-life-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('both Open Project and Project Properties are reachable from the File menu', async ({
  page,
}) => {
  // A command registered but never contributed to a menu is unreachable,
  // which this project has shipped before (#379).
  const found = await page.evaluate(() => {
    const menus = getSvc('MenuModelRegistry')
    const root = menus.getMenu(['menubar']) || menus.getMenu([])
    const seen = new Set()
    const ids = []
    const walk = node => {
      if (!node || seen.has(node)) return
      seen.add(node)
      if (node.command) ids.push(node.command)
      if (node.id) ids.push(node.id)
      ;(node.children || []).forEach(walk)
    }
    walk(root)
    return {
      open: ids.includes('hackbench.project.open'),
      props: ids.includes('hackbench.project.properties'),
    }
  })
  expect(found.open).toBe(true)
  expect(found.props).toBe(true)
})

/**
 * The File menu offers projects, not workspaces.
 *
 * Asserted as ABSENCE from the live menu model rather than by reading our
 * unregister list back, which would only prove we called a function. Every id
 * here was read out of a running app before being removed.
 */
test('workspace and loose-file entries are gone from the File menu', async ({ page }) => {
  // Seed a project, then reload. The recent submenu is generated per
  // remembered project and RecentProjects persists to disk, so on a developer
  // machine an earlier project satisfied this while a clean CI runner had
  // none: the test asserted a precondition it never established (runs
  // 35683353340, 35684409050).
  //
  // The reload is what makes the seed visible. refreshRecentMenu() runs from
  // show() and from command registration at startup, and calling the service
  // directly goes through neither, so the project is remembered while the
  // menu still holds nothing. Reloading rebuilds it through the app's own
  // startup path rather than reaching into a protected method.
  await page.evaluate(
    async ({ romPath, directory }) => {
      await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'RecentSeed',
        directory,
      })
    },
    { romPath: ROM, directory: path.join(tmp, 'RecentSeed') },
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })

  const ids = await page.evaluate(() => {
    const menus = getSvc('MenuModelRegistry')
    const root = menus.getMenu(['menubar']) || menus.getMenu([])
    const seen = new Set()
    const out = []
    const walk = node => {
      if (!node || seen.has(node)) return
      seen.add(node)
      if (node.id) out.push(node.id)
      if (node.command) out.push(node.command)
      ;(node.children || []).forEach(walk)
    }
    const file = (root.children || []).find(c => c.id === '1_file')
    walk(file)
    return out
  })

  for (const gone of [
    'workbench.action.files.newUntitledFile',
    'workbench.action.files.pickNewFile',
    'file.newFolder',
    'workbench.action.newWindow',
    'workspace:open',
    'workspace:openWorkspace',
    'workspace:openRecent',
    'workspace:addFolder',
    'workspace:saveAs',
    'workspace:close',
  ]) {
    expect(ids, `${gone} should not be in the File menu`).not.toContain(gone)
  }

  // Ours are there, and so is Preferences, which is where the colour theme is.
  expect(ids).toContain('hackbench.project.new')
  expect(ids).toContain('hackbench.project.open')
  // Open Recent is a SUBMENU now, matching VS Code: the entries are
  // generated per remembered project, so the stable things to assert are the
  // submenu itself and that it actually holds entries.
  expect(ids).toContain('recent')
  expect(
    ids.filter(id => id.startsWith('hackbench.project.openRecent.')).length,
    'the recent submenu should list the project this run created',
  ).toBeGreaterThan(0)
  expect(ids).toContain('hackbench.project.properties')
  expect(ids).toContain('1_settings_submenu')
})

/**
 * The recent list offers working projects only.
 *
 * A list whose entries fail when clicked reads as data loss, so the pruning
 * is asserted through the service the menu actually calls.
 */
test('a deleted project drops out of the recent list', async ({ page }) => {
  const dir = path.join(tmp, 'Transient')

  const before = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({ romPath, name: 'Transient', directory })
      const list = await svc.recentProjects()
      return list.map(e => e.name)
    },
    { romPath: ROM, directory: dir },
  )

  expect(before).toContain('Transient')

  fs.rmSync(dir, { recursive: true, force: true })

  const after = await page.evaluate(async () => {
    const list = await getSvc('Symbol(ProjectService)').recentProjects()
    return list.map(e => e.name)
  })
  expect(after).not.toContain('Transient')
})

test('a reopened project shows the same maps it showed when created', async ({ page }) => {
  const dir = path.join(tmp, 'Reopened')

  const counts = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const w = await getWidget('hackbench.map-explorer')

      const created = await svc.createProject({ romPath, name: 'Reopened', directory })
      await w.load(created.manifestPath)
      const onCreate = w.mapCount

      // Drop the project and come back to it, which is the path a second
      // session takes and the one that drifts.
      await w.load('').catch(() => {})
      const reopened = await svc.openProject(created.manifestPath)
      await w.load(reopened.manifestPath)

      return { onCreate, onReopen: w.mapCount, name: reopened.name }
    },
    { romPath: ROM, directory: dir },
  )

  expect(counts.onCreate).toBe(235)
  expect(counts.onReopen).toBe(counts.onCreate)
  expect(counts.name).toBe('Reopened')
})

test('editing properties rewrites the manifest without touching the cartridge identity', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Described')
  const manifestPath = path.join(dir, 'Described.hbproj')

  await page.evaluate(
    async ({ romPath, directory }) => {
      await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Described',
        directory,
      })
    },
    { romPath: ROM, directory: dir },
  )

  const before = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  // Title defaults to the project name, which is what a new project gets.
  expect(before.title).toBe('Described')

  const after = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    return svc.updateProject(mp, {
      title: 'Super Kaizo World',
      authors: ['engenb'],
      version: '1.1.0',
      summary: 'Now with more spikes.',
    })
  }, manifestPath)

  expect(after.title).toBe('Super Kaizo World')

  const onDisk = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  expect(onDisk.title).toBe('Super Kaizo World')
  expect(onDisk.authors).toEqual(['engenb'])
  expect(onDisk.version).toBe('1.1.0')
  // The cartridge and the creation date are facts, not opinions. Editing the
  // description must not quietly repoint the project at a different game.
  expect(onDisk.baseRom).toEqual(before.baseRom)
  expect(onDisk.created).toBe(before.created)
})

test('the mushroom is visible against the title bar, not merely present', async ({ page }) => {
  // The icon is a single unfilled path, so it renders BLACK by default. Drawn
  // on a dark title bar it is present, on screen and invisible, and passes
  // every "is it there" check. So this asserts a contrast ratio.
  await page.waitForSelector('.hb-brand svg', { timeout: 15000 })

  const contrast = await page.evaluate(() => {
    const svg = document.querySelector('.hb-brand svg')
    const brand = document.querySelector('.hb-brand')
    const lum = rgb => {
      const [r, g, b] = rgb
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map(v => {
          const c = v / 255
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
        })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    // The path inherits currentColor from .hb-brand.
    const fg = getComputedStyle(brand).color
    let node = brand
    let bg = 'rgba(0, 0, 0, 0)'
    while (node) {
      const c = getComputedStyle(node).backgroundColor
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) {
        bg = c
        break
      }
      node = node.parentElement
    }
    const a = lum(fg)
    const b = lum(bg)
    return {
      ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      fg,
      bg,
      width: svg.getBoundingClientRect().width,
    }
  })

  expect(contrast.width).toBeGreaterThan(8)
  expect(contrast.ratio, `logo ${contrast.fg} on ${contrast.bg}`).toBeGreaterThan(3)
})

test('Project Properties speaks of ROMs, never cartridges, even for an untitled ROM', async ({
  page,
}) => {
  const project = await page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'Untitled', directory }),
    { romPath: ROM, directory: path.join(tmp, 'Untitled') },
  )
  await page.evaluate(p => {
    // Not awaited: editFor resolves only when the dialog closes.
    void getSvc('ProjectPropertiesDialog').editFor({ ...p, baseRom: { ...p.baseRom, title: '' } })
  }, project)
  await page.waitForSelector('.hb-dialog-facts', { timeout: 15000 })
  const words = await shownWords(page, '.dialogBlock')
  expect(words).toContain('unrecognized ROM')
  expect(words).not.toMatch(CART)
  await page.keyboard.press('Escape')
})

/**
 * Local workstation section (#527). Asserted against the registry FILES the
 * backend writes, not against what the dialog displays.
 */
function appDataFile(name) {
  const home = os.homedir()
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_DATA_HOME || path.join(home, '.local', 'share')
  return path.join(base, 'hackbench', name)
}
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'))
const registeredRom = sha => readJson(appDataFile('rom-registry.json')).roms[sha].path
const registeredCore = () => readJson(appDataFile('core-registry.json')).core?.jsPath

/** A core that passes validateCore: both driver markers, sibling .wasm with the magic. */
function makeCore(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const js = path.join(dir, 'core.js')
  fs.writeFileSync(js, 'var a="EJS_Runtime";Module["_get_current_frame_count"]=1;')
  fs.writeFileSync(path.join(dir, 'core.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  return js
}

/** Open Project Properties through its command, with Browse answering `picks` in order. */
async function openProps(page, project, picks) {
  await page.evaluate(
    async ({ p, picks }) => {
      getSvc('ProjectContext').current = p
      const dlg = getSvc('ProjectPropertiesDialog')
      const queue = [...picks]
      dlg.fileDialog.showOpenDialog = async () => ({ path: { fsPath: () => queue.shift() } })
      void getSvc('CommandRegistry').executeCommand('hackbench.project.properties')
    },
    { p: project, picks },
  )
  await page.waitForSelector('.hb-dialog-facts', { timeout: 15000 })
}

const browse = (page, n) => page.locator('.dialogBlock button:has-text("Browse...")').nth(n).click()
const fieldValues = page =>
  page.locator('.dialogBlock input[readonly]').evaluateAll(els => els.map(e => e.value))

async function makeProject(page, name) {
  return page.evaluate(
    async ({ romPath, directory, name }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
    { romPath: ROM, directory: path.join(tmp, name), name },
  )
}

test('Project Properties shows the registered ROM and core paths', async ({ page }) => {
  const core = makeCore(path.join(tmp, 'core'))
  await page.evaluate(c => getSvc('Symbol(EmulatorService)').locateCore(c), core)
  const project = await makeProject(page, 'Shown')
  await openProps(page, project, [])
  expect(await page.locator('.dialogBlock').innerText()).toContain('Local workstation')
  const [rom, shownCore] = await fieldValues(page)
  expect(rom).toBe(registeredRom(project.baseRom.sha256))
  expect(shownCore).toBe(registeredCore())
  await page.keyboard.press('Escape')
})

test('browsing to the same ROM at a new path and saving registers it, and the project opens from it', async ({
  page,
}) => {
  const project = await makeProject(page, 'Moved')
  const moved = path.join(tmp, 'moved.sfc')
  fs.copyFileSync(ROM, moved)
  await openProps(page, project, [moved])
  await browse(page, 0)
  await expect.poll(() => fieldValues(page).then(v => v[0])).toBe(moved)
  // Browsing alone persists nothing.
  expect(registeredRom(project.baseRom.sha256)).not.toBe(moved)
  await page.locator('.dialogBlock .theia-button.main').click()
  await expect.poll(() => registeredRom(project.baseRom.sha256)).toBe(moved)

  const result = await page.evaluate(async mp => {
    const r = await getSvc('Symbol(ProjectService)').loadMaps(mp)
    return { status: r.status, romPath: r.romPath }
  }, project.manifestPath)
  expect(result).toEqual({ status: 'ok', romPath: moved })
})

test('a ROM with a different hash is refused inline, naming both hashes, and nothing is saved', async ({
  page,
}) => {
  const project = await makeProject(page, 'Refused')
  const before = registeredRom(project.baseRom.sha256)
  const other = path.join(tmp, 'other.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[0x100] ^= 0xff
  fs.writeFileSync(other, bytes)
  await openProps(page, project, [other])
  await browse(page, 0)
  const error = page.locator('.dialogBlock .hb-dialog-error')
  await expect(error).toContainText(project.baseRom.sha256.slice(0, 12))
  expect((await error.innerText()).match(/[0-9a-f]{12}…/g)).toHaveLength(2)
  expect((await fieldValues(page))[0]).toBe(before)
  await page.locator('.dialogBlock .theia-button.main').click()
  await expect(page.locator('.dialogBlock')).toHaveCount(0)
  expect(registeredRom(project.baseRom.sha256)).toBe(before)
})

test('Browse then Cancel leaves both registries unchanged', async ({ page }) => {
  const project = await makeProject(page, 'Cancelled')
  const romBefore = registeredRom(project.baseRom.sha256)
  const coreBefore = fs.existsSync(appDataFile('core-registry.json')) ? registeredCore() : undefined
  const moved = path.join(tmp, 'cancel.sfc')
  fs.copyFileSync(ROM, moved)
  const core = makeCore(path.join(tmp, 'cancelcore'))
  await openProps(page, project, [moved, core])
  await browse(page, 0)
  await browse(page, 1)
  await expect.poll(() => fieldValues(page).then(v => v[1])).toBe(core)
  await page.locator('.dialogBlock .theia-button.secondary:has-text("Cancel")').click()
  await expect(page.locator('.dialogBlock')).toHaveCount(0)
  expect(registeredRom(project.baseRom.sha256)).toBe(romBefore)
  expect(fs.existsSync(appDataFile('core-registry.json')) ? registeredCore() : undefined).toBe(
    coreBefore,
  )
})

test('changing the core and saving registers the new core', async ({ page }) => {
  const project = await makeProject(page, 'CoreMoved')
  const core = makeCore(path.join(tmp, 'newcore'))
  await openProps(page, project, [core])
  await browse(page, 1)
  await expect.poll(() => fieldValues(page).then(v => v[1])).toBe(core)
  await page.locator('.dialogBlock .theia-button.main').click()
  await expect.poll(() => registeredCore()).toBe(core)
})
