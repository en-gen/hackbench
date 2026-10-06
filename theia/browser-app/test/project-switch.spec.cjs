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
  await openGfx(page, mp)
  await page.evaluate(async mp => {
    const wm = getSvc('WidgetManager')
    const shell = getSvc('ApplicationShell')
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

/** Pins GFX sheet 0 of `mp` the way the sheet list does. */
const openGfx = (page, mp) =>
  page.evaluate(async mp => {
    await getSvc('PreviewTabs').pin(
      'hackbench.gfx-view',
      { index: 0 },
      w => w.open({ manifestPath: mp, index: 0, label: 'GFX 0' }),
      p => p.shows(0),
      {},
    )
  }, mp)

/** Activates the one GFX view and asserts the shell agrees, so Ctrl+Z reaches it. */
async function activateGfx(page) {
  const viewId = await page.evaluate(async () => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    await getSvc('ApplicationShell').activateWidget(w.id)
    return w.id
  })
  expect(await page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id)).toBe(viewId)
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

  await openGfx(page, b.manifestPath)
  await page.waitForSelector('#hb-gfx-canvas', { timeout: 15000 })
  await expect
    .poll(() => page.evaluate(() => getSvc('EditStackContribution').state.canUndo))
    .toBe(true)
  await activateGfx(page)

  await page.keyboard.press('Control+z')

  await expect.poll(() => opFiles(path.join(tmp, 'B')).length).toBe(0)
  expect(opFiles(path.join(tmp, 'A'))).toHaveLength(1)
})

const pixelAt = (page, { x, y }) =>
  page.evaluate(
    ({ x, y }) =>
      Array.from(
        document.querySelector('#hb-gfx-canvas').getContext('2d').getImageData(x, y, 1, 1).data,
      ),
    { x, y },
  )

/**
 * A is open with its GFX view and one unsaved stroke; B's open is started and
 * left waiting on the dirty prompt (window.__switch is the pending promise).
 */
async function dirtyThenSwitch(page, { refuseSave = false } = {}) {
  const a = await createProject(page, 'A')
  const b = await createProject(page, 'B')
  await openViaMenuPath(page, a.manifestPath)
  await openGfx(page, a.manifestPath)
  await page.waitForSelector('#hb-gfx-canvas', { timeout: 15000 })
  await expect(page.locator('#hb-gfx-swatch-1')).toBeVisible()
  const P = { x: 3, y: 5 }
  const before = await pixelAt(page, P)
  const colors = await page.evaluate(() =>
    getSvc('WidgetManager')
      .getWidgets('hackbench.gfx-view')[0]
      .sheet.paletteColors.map(c => [c.r, c.g, c.b, c.a]),
  )
  const index = colors.findIndex((c, i) => i > 0 && c[3] > 0 && c.join() !== before.join())
  await page.click(`#hb-gfx-swatch-${index}`)
  const box = await page.locator('#hb-gfx-canvas').boundingBox()
  const width = await page.evaluate(() => document.querySelector('#hb-gfx-canvas').width)
  const k = box.width / width
  await page.mouse.move(box.x + (P.x + 0.5) * k, box.y + (P.y + 0.5) * k)
  await page.mouse.down()
  await page.mouse.up()
  const painted = await pixelAt(page, P)
  expect(painted).not.toEqual(before)

  if (refuseSave) {
    // The view's own save() then returns false, which Theia's close prompt ignores.
    await page.evaluate(() => {
      const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
      w.gfx = new Proxy(w.gfx, {
        get: (t, k) =>
          k === 'saveGfx' ? async () => ({ status: 'refused', reason: 'stubbed' }) : t[k],
      })
    })
  }
  await page.evaluate(mp => {
    window.__switch = getSvc('HackBenchContribution').openPath(mp)
  }, b.manifestPath)
  await expect(page.locator('.dialogOverlay').first()).toBeVisible()
  return { a, b, P, before, painted }
}

const currentPath = page => page.evaluate(() => getSvc('ProjectContext').current?.manifestPath)

test('cancelling the unsaved-strokes prompt aborts the switch and keeps the stroke', async ({
  page,
}) => {
  const { a, b, P, before, painted } = await dirtyThenSwitch(page)

  await page
    .locator('#theia-dialog-shell')
    .getByRole('button', { name: /cancel/i })
    .click()
  await page.evaluate(() => window.__switch)

  expect(await currentPath(page)).toBe(a.manifestPath)
  await expect(page.locator('#hb-gfx-canvas')).toHaveCount(1)
  expect(await pixelAt(page, P)).toEqual(painted)
  await activateGfx(page)
  const ofB = await page.evaluate(
    mp =>
      getSvc('ApplicationShell')
        .widgets.filter(w => w.manifestPath === mp)
        .map(w => w.id),
    b.manifestPath,
  )
  expect(ofB, 'no view of B was opened').toEqual([])

  // Ctrl+Z walks the stroke back, not a layer of either project.
  await page.keyboard.press('Control+z')
  await expect.poll(() => pixelAt(page, P)).toEqual(before)
  expect(opFiles(path.join(tmp, 'A'))).toHaveLength(0)
  expect(opFiles(path.join(tmp, 'B'))).toHaveLength(0)
})

test('Save in the unsaved-strokes prompt writes one layer and completes the switch', async ({
  page,
}) => {
  const { b } = await dirtyThenSwitch(page)

  await page
    .locator('#theia-dialog-shell')
    .getByRole('button', { name: 'Save', exact: true })
    .click()
  await page.evaluate(() => window.__switch)

  expect(opFiles(path.join(tmp, 'A'))).toHaveLength(1)
  await expect(page.locator('#hb-gfx-canvas')).toHaveCount(0)
  expect(await currentPath(page)).toBe(b.manifestPath)
})

/** Attached project-bound widgets whose manifest is not the open project's. */
const leftovers = page =>
  page.evaluate(() => {
    const cur = getSvc('ProjectContext').current?.manifestPath
    return getSvc('ApplicationShell')
      .widgets.filter(w => w.projectBound === true && w.manifestPath !== cur)
      .map(w => w.id)
  })

test('a refused Save in the prompt keeps A open and aborts the switch', async ({ page }) => {
  const { a, P, before } = await dirtyThenSwitch(page, { refuseSave: true })
  const dialog = page.locator('#theia-dialog-shell')

  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  // Theia asks again because the save failed; answering Cancel leaves the view open.
  await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible()
  await dialog.getByRole('button', { name: /cancel/i }).click()
  await page.evaluate(() => window.__switch)

  expect(await currentPath(page)).toBe(a.manifestPath)
  await expect(page.locator('#hb-gfx-canvas')).toHaveCount(1)
  expect(await leftovers(page)).toEqual([])
  await activateGfx(page)
  await page.keyboard.press('Control+z')
  await expect.poll(() => pixelAt(page, P)).toEqual(before)
  expect(opFiles(path.join(tmp, 'A'))).toHaveLength(0)
  expect(opFiles(path.join(tmp, 'B'))).toHaveLength(0)
})

test('a view of A still opening when B opens never attaches', async ({ page }) => {
  const a = await createProject(page, 'A')
  const b = await createProject(page, 'B')
  await openViaMenuPath(page, a.manifestPath)
  // Not awaited, and held in their load for 1.5 s so the switch lands inside it:
  // neither is in shell.widgets yet when B opens.
  await page.evaluate(mp => {
    const tabs = getSvc('PreviewTabs')
    const slow = open => async w => {
      await new Promise(r => setTimeout(r, 1500))
      await open(w)
    }
    void tabs.preview(
      'hackbench.gfx-view',
      slow(w => w.open({ manifestPath: mp, index: 0, label: 'G' })),
    )
    void tabs.preview(
      'hackbench.map16-view',
      slow(w => w.open({ manifestPath: mp, label: 'M', layer: 'fg' })),
      { layer: 'fg' },
    )
  }, a.manifestPath)

  await openViaMenuPath(page, b.manifestPath)
  await page.waitForTimeout(3500) // past the held load

  expect(await currentPath(page)).toBe(b.manifestPath)
  expect(await leftovers(page)).toEqual([])
})
