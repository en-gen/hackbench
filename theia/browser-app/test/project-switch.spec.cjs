/**
 * HackBench: opening another project closes the previous project's views (#628).
 *
 * GFX, Map16 and map views hold their own manifest path and never re-target,
 * so a leftover A view made Ctrl+Z undo B's layer. B is opened through
 * HackBenchContribution.openPath, the handler File > Open Recent runs, not by
 * assigning ProjectContext.current, or the close code would never execute.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

const BOUND = ['hackbench.gfx-view', 'hackbench.map16-view', 'hackbench.map-view']
const KEPT = ['hackbench.palette-explorer', 'hackbench.music-explorer']

let tmp

test.beforeEach(async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'the vanilla ROM is not on this machine')
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-switch-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const createProject = (page, name) =>
  page.evaluate(
    ({ romPath, directory, name }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
    { romPath: ROM, directory: path.join(tmp, name), name },
  )

/** The File > Open Recent handler: the real path that must close the old views. */
const openViaMenuPath = (page, manifestPath) =>
  page.evaluate(mp => getSvc('HackBenchContribution').openPath(mp), manifestPath)

/** Ids of every widget attached to the shell that starts with a prefix in `prefixes`. */
const shellIds = (page, prefixes) =>
  page.evaluate(
    ps =>
      getSvc('ApplicationShell')
        .widgets.map(w => w.id)
        .filter(id => ps.some(p => id.startsWith(p))),
    prefixes,
  )

/** Opens a GFX, a Map16 and a map view of `mp` in the main area, plus the two explorers. */
async function openViews(page, mp) {
  await page.evaluate(async mp => {
    const wm = getSvc('WidgetManager')
    const shell = getSvc('ApplicationShell')
    await getSvc('PreviewTabs').pin(
      'hackbench.gfx-view',
      { index: 0 },
      w => w.open({ manifestPath: mp, index: 0, label: 'GFX 0' }),
      p => p.shows(0),
      {},
    )
    const m16 = await wm.getOrCreateWidget('hackbench.map16-view', { layer: 'fg' })
    await m16.open({ manifestPath: mp, label: 'Map16 Foreground', layer: 'fg' })
    await shell.addWidget(m16, { area: 'main' })
    const map = await wm.getOrCreateWidget('hackbench.map-view', { index: 0 })
    await map.open({ manifestPath: mp, index: 0, label: '0', iconClass: '' })
    await shell.addWidget(map, { area: 'main' })
    for (const id of ['hackbench.palette-explorer', 'hackbench.music-explorer']) {
      const w = await wm.getOrCreateWidget(id)
      if (!w.isAttached) await shell.addWidget(w, { area: 'left' })
    }
  }, mp)
  await expect.poll(() => shellIds(page, BOUND).then(a => a.length)).toBe(3)
  expect((await shellIds(page, KEPT)).length).toBe(2)
}

const opFiles = dir =>
  fs.existsSync(path.join(dir, 'ops'))
    ? fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))
    : []

const setColor = (page, mp) =>
  page.evaluate(mp => getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, '$391F', '$03E0'), mp)

test('opening B closes the GFX, Map16 and map views of A and keeps palette and music', async ({
  page,
}) => {
  const a = await createProject(page, 'A')
  const b = await createProject(page, 'B')
  await openViaMenuPath(page, a.manifestPath)
  await openViews(page, a.manifestPath)

  await openViaMenuPath(page, b.manifestPath)

  await expect.poll(() => shellIds(page, BOUND)).toEqual([])
  expect((await shellIds(page, KEPT)).sort()).toEqual([...KEPT].sort())
  expect(await page.evaluate(() => getSvc('ProjectContext').current.manifestPath)).toBe(
    b.manifestPath,
  )
})

test('reopening the open project closes nothing', async ({ page }) => {
  const a = await createProject(page, 'A')
  await openViaMenuPath(page, a.manifestPath)
  await openViews(page, a.manifestPath)
  const before = (await shellIds(page, BOUND)).sort()

  await openViaMenuPath(page, a.manifestPath)
  await page.waitForTimeout(1000)

  expect((await shellIds(page, BOUND)).sort()).toEqual(before)
})

test('Ctrl+Z in B own GFX view undoes B layer and never touches A', async ({ page }) => {
  const a = await createProject(page, 'A')
  const b = await createProject(page, 'B')
  await openViaMenuPath(page, a.manifestPath)
  await setColor(page, a.manifestPath)
  await openViews(page, a.manifestPath)

  await openViaMenuPath(page, b.manifestPath)
  await expect.poll(() => shellIds(page, BOUND)).toEqual([])
  await setColor(page, b.manifestPath)
  expect(opFiles(path.join(tmp, 'B'))).toHaveLength(1)

  await page.evaluate(async mp => {
    await getSvc('PreviewTabs').pin(
      'hackbench.gfx-view',
      { index: 0 },
      w => w.open({ manifestPath: mp, index: 0, label: 'GFX 0' }),
      p => p.shows(0),
      {},
    )
  }, b.manifestPath)
  await page.waitForSelector('#hb-gfx-canvas', { timeout: 15000 })
  await expect
    .poll(() => page.evaluate(() => getSvc('EditStackContribution').state.canUndo))
    .toBe(true)
  const viewId = await page.evaluate(async () => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    await getSvc('ApplicationShell').activateWidget(w.id)
    return w.id
  })
  expect(await page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id)).toBe(viewId)

  await page.keyboard.press('Control+z')

  await expect.poll(() => opFiles(path.join(tmp, 'B')).length).toBe(0)
  expect(opFiles(path.join(tmp, 'A'))).toHaveLength(1)
})
