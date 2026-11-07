/**
 * A single click on a row that already has an open (persistent) tab brings
 * that tab forward instead of opening a second, preview tab of the row (#1324).
 *
 * One block per view that previews: GFX, Map16, Palette and Overworld. The
 * Map view's cases, which also check presses, are in map-view.spec.cjs.
 * Each block asserts BEHAVIOUR through real tree clicks: how many tabs of the
 * view exist, which is active, and what the preview tab still holds.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp

test.beforeEach(async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-focus-open-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Creates a project, makes it current and loads the named explorers. */
async function openProject(page, explorers) {
  return page.evaluate(
    async ({ romPath, directory, explorers }) => {
      const projects = getSvc('Symbol(ProjectService)')
      const created = await projects.createProject({ romPath, name: 'MyHack', directory })
      getSvc('ProjectContext').current = await projects.openProject(created.manifestPath)
      for (const id of explorers) {
        const w = await getSvc('WidgetManager').getOrCreateWidget(id)
        if (w.load) await w.load(created.manifestPath)
      }
      return created.manifestPath
    },
    { romPath: ROM, directory: path.join(tmp, 'MyHack'), explorers },
  )
}

const reveal = (page, id) =>
  page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, id)

/** Every main-area tab of one view, as `{ id, label }`. */
const tabsOf = (page, re) =>
  page.evaluate(
    src =>
      getSvc('ApplicationShell')
        .getWidgets('main')
        .filter(w => new RegExp(src).test(w.id))
        .map(w => ({ id: w.id, label: w.title.label })),
    re.source,
  )
const activeId = page => page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id)
const pinnedOf = async (page, re) =>
  (await tabsOf(page, re)).filter(t => !t.id.includes(':preview'))
const previewOf = async (page, re) =>
  (await tabsOf(page, re)).filter(t => t.id.includes(':preview'))

/**
 * @param {string} name
 * @param {{ prepare: (page) => Promise<void>, rowA: (page) => any, rowB: (page) => any, re: RegExp, sharedPreview?: boolean, beforeB?: (page) => Promise<void> }} view
 */
function suite(name, view) {
  const { prepare, rowA, rowB, re, sharedPreview = true, beforeB } = view
  const clickB = async page => {
    await beforeB?.(page)
    await rowB(page).click()
  }
  /** A is pinned by double click and everything has settled. */
  async function pinA(page) {
    await prepare(page)
    await rowA(page).dblclick()
    await expect.poll(async () => (await pinnedOf(page, re)).length).toBe(1)
    await expect.poll(async () => (await previewOf(page, re)).length).toBe(0)
    return (await pinnedOf(page, re))[0].id
  }

  test(`${name}: a single click on an open row focuses its tab and opens no preview (1, 3)`, async ({
    page,
  }) => {
    const a = await pinA(page)
    await clickB(page) // moves focus off A's tab, so the click below has something to win back
    await expect.poll(async () => (await previewOf(page, re)).length).toBe(1)
    const [b] = await previewOf(page, re)
    await page.evaluate(id => getSvc('ApplicationShell').closeWidget(id), b.id)
    await expect.poll(async () => (await previewOf(page, re)).length).toBe(0)
    await rowA(page).click()
    await expect.poll(() => activeId(page)).toBe(a)
    await page.waitForTimeout(1500) // a second tab would be opening by now
    expect((await pinnedOf(page, re)).map(t => t.id)).toEqual([a])
    expect(await previewOf(page, re)).toEqual([])
  })

  test(`${name}: clicking an open row leaves another row's preview open (4, 4a)`, async ({
    page,
  }) => {
    const a = await pinA(page)
    await clickB(page)
    await expect.poll(async () => (await previewOf(page, re)).length).toBe(1)
    const [before] = await previewOf(page, re)
    await rowA(page).click()
    await expect.poll(() => activeId(page)).toBe(a)
    await page.waitForTimeout(1500)
    expect((await pinnedOf(page, re)).map(t => t.id)).toEqual([a])
    expect(await previewOf(page, re)).toEqual([before]) // still B's, same tab
  })

  // Map16's two tables have independent preview tabs by design, so there is no shared one to check.
  const shared = sharedPreview ? test : () => {}
  shared(
    `${name}: a row with no open tab previews, and rows share one preview tab (5)`,
    async ({ page }) => {
      await prepare(page)
      await rowA(page).click()
      await expect.poll(async () => (await previewOf(page, re)).length).toBe(1)
      const [first] = await previewOf(page, re)
      await clickB(page)
      // The tab's id is per-row while apply runs, so a poll on the label alone can see no tab at all.
      await expect
        .poll(async () => {
          const now = await previewOf(page, re)
          return now.length === 1 && now[0].label !== first.label
        })
        .toBe(true)
      expect((await previewOf(page, re)).length).toBe(1)
      expect((await pinnedOf(page, re)).length).toBe(0)
    },
  )

  test(`${name}: a double click on an open row still leaves one tab (6)`, async ({ page }) => {
    const a = await pinA(page)
    await rowA(page).dblclick()
    await page.waitForTimeout(1500)
    expect((await pinnedOf(page, re)).map(t => t.id)).toEqual([a])
    expect(await previewOf(page, re)).toEqual([])
  })
}

const GFX = '#hackbench\\.gfx-explorer .theia-TreeNode'
suite('GFX', {
  re: /^hackbench\.gfx-view:/,
  prepare: async page => {
    await openProject(page, ['hackbench.gfx-explorer'])
    await reveal(page, 'hackbench.gfx-explorer')
    await page.waitForSelector(GFX, { timeout: 15000 })
  },
  rowA: page => page.locator(GFX).nth(2), // after the two Map16 rows
  rowB: page => page.locator(GFX).nth(3),
})

suite('Map16', {
  sharedPreview: false,
  re: /^hackbench\.map16-view:/,
  prepare: async page => {
    await openProject(page, ['hackbench.gfx-explorer'])
    await reveal(page, 'hackbench.gfx-explorer')
    await page.waitForSelector(GFX, { timeout: 15000 })
  },
  rowA: page => page.locator(GFX).nth(0),
  rowB: page => page.locator(GFX).nth(1),
})

const PAL = '#hackbench\\.palette-explorer .theia-TreeNode'
suite('Palette', {
  re: /^hackbench\.palette-group-view:/,
  prepare: async page => {
    await openProject(page, ['hackbench.palette-explorer'])
    await reveal(page, 'hackbench.palette-explorer')
    await page.waitForSelector(PAL, { timeout: 15000 })
  },
  rowA: page => page.locator(PAL, { hasText: 'Shared Sprite Colors' }),
  rowB: page => page.locator(PAL, { hasText: 'Player Palettes' }),
})

const OW = id => `#hackbench\\.map-explorer .theia-TreeNode[data-node-id="${id}"]`
/** Opens the Overworld node if it is folded; it may or may not start open, and a double click on the hub row folds it. */
async function expandOverworld(page) {
  await page.waitForTimeout(1000)
  if (!(await page.locator(OW('overworld/area:1')).count())) {
    await page.locator(`${OW('overworld')} .theia-ExpansionToggle`).click()
  }
  await page.waitForSelector(OW('overworld/area:1'), { timeout: 15000 })
}
suite('Overworld', {
  re: /^hackbench\.overworld-(area-)?view/,
  prepare: async page => {
    await openProject(page, ['hackbench.map-explorer'])
    await reveal(page, 'hackbench.map-explorer')
    await page.waitForSelector(OW('overworld'), { timeout: 15000 })
    await expandOverworld(page)
  },
  beforeB: expandOverworld,
  rowA: page => page.locator(OW('overworld')),
  rowB: page => page.locator(OW('overworld/area:1')),
})
