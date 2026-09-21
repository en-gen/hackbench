/**
 * Creating, reopening and re-describing a project.
 *
 * The defect these guard against is drift between create and open: a project
 * that shows its maps when created but not when reopened looks like data loss
 * to whoever hits it, and no assertion about creation alone can see it.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

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
