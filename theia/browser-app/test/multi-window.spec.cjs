/**
 * Two windows on one project: an edit made through one connection must
 * re-render in the other's already-open tab with no action there, and
 * closing one window must not stop the other from still getting pushed to.
 *
 * Its own backend and port so two simultaneously open windows never collide
 * with whatever else is running against the suite's shared one.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const {
  snapshotRegistry,
  restoreRegistry,
  startBackend,
  stopBackend,
  waitForBackend,
} = require('./own-backend.cjs')
const { bgr555ToRgbTriplet, parseRgbTriplet } = require('./palette-color.cjs')

const PORT = Number(process.env.HB_MULTIWINDOW_PORT || 3101)
const APP = `http://127.0.0.1:${PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
const haveRom = fs.existsSync(ROM)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let backend
let tmp
let snapshot

const sel = id => '#' + id.replace(/[.:]/g, m => '\\' + m)

/** Opens a project in the shell the way File > Open does, so every palette widget reacts to it. */
async function openProject(page, project) {
  await page.evaluate(p => {
    getSvc('ProjectContext').current = p
  }, project)
  await page.waitForFunction(
    mp => getSvc('ProjectContext').current?.manifestPath === mp,
    project.manifestPath,
  )
}

/** Opens the 'player' group tab, returning its widget id. Mirrors palette-view.spec.cjs's openTab. */
async function openPlayerTab(page, manifestPath) {
  const id = await page.evaluate(async manifestPath => {
    const w = await getSvc('PaletteExplorerContribution').openGroup({
      manifestPath,
      groupId: 'player',
      pinned: true,
    })
    return w.id
  }, manifestPath)
  await page.waitForSelector(`${sel(id)} .hb-palette-swatch`, { timeout: 15000 })
  return id
}

/** Mario's red: variant 0 ("Mario"), CGRAM row 8 col 9, first `.hb-palette-variant` section. */
function marioRedSwatch(page, tabId) {
  return page
    .locator(`${sel(tabId)} .hb-palette-variant`)
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
}

/** Polls a swatch until its rendered color matches `word`, or times out failing the assertion. */
async function expectSwatchColor(swatch, word) {
  await expect
    .poll(async () =>
      parseRgbTriplet(await swatch.evaluate(e => getComputedStyle(e).backgroundColor)),
    )
    .toEqual(bgr555ToRgbTriplet(word))
}

test.beforeAll(() => {
  snapshot = snapshotRegistry()
})

test.afterAll(() => {
  stopBackend(backend)
  restoreRegistry(snapshot)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('a second window keeps getting pushes, and closing it does not break the first', async ({
  page,
  context,
}) => {
  test.skip(!haveRom, `ROM fixture not present on this machine (${ROM})`)
  test.setTimeout(300000)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-multiwindow-'))

  backend = startBackend(PORT)
  await waitForBackend(APP, true)

  const pageA = page
  const pageB = await context.newPage()
  for (const p of [pageA, pageB]) {
    await p.goto(APP, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('#theia-app-shell', { timeout: 90000 })
    await p.waitForFunction(() => !!window.theia && !!window.theia.container, null, {
      timeout: 30000,
    })
    await p.addScriptTag({ content: GET_SVC })
  }

  // One project, created through A's connection, opened in BOTH windows: two
  // ProjectServiceImpl instances, one manifest, one shared WorkingRom.
  const project = await pageA.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MultiWindow', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MultiWindow') },
  )
  await openProject(pageA, project)
  await openProject(pageB, project)

  const tabA = await openPlayerTab(pageA, project.manifestPath)
  const tabB = await openPlayerTab(pageB, project.manifestPath)
  const swatchA = marioRedSwatch(pageA, tabA)
  const swatchB = marioRedSwatch(pageB, tabB)
  await expectSwatchColor(swatchA, 0x391f)
  await expectSwatchColor(swatchB, 0x391f)

  // Edit through A's OWN connection. B does nothing: its already-open tab
  // must re-render on its own connection's push.
  const first = await pageA.evaluate(
    mp => getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, '$391F', '$03E0'),
    project.manifestPath,
  )
  expect(first.status).toBe('ok')
  await expectSwatchColor(swatchA, 0x03e0)
  await expectSwatchColor(swatchB, 0x03e0)

  await pageB.close()

  // A keeps editing on ITS OWN connection, unaffected by B's closure.
  const second = await pageA.evaluate(
    mp => getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, '$03E0', '$001F'),
    project.manifestPath,
  )
  expect(second.status).toBe('ok')
  await expectSwatchColor(swatchA, 0x001f)
})
