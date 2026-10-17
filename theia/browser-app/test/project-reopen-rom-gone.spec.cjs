/**
 * #975: reopening a project whose base ROM file was renamed must show it as
 * not located everywhere. Project properties read workstationPaths; the map
 * view reads mapDetails. Both are asserted, plus the recovery when the file
 * returns. Works on a COPY of the ROM in a temp dir; no corpus file is renamed.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
// A named skip when the ROM is not on this machine (docs/testing.md).
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
}`

let tmp
test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reopen-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(async ({ page }) => {
  // The ROM registry is per-user and keyed by hash: point it back at the real file.
  await page.evaluate(rp => getSvc('Symbol(ProjectService)').registerRom(rp), ROM)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('reopen with the base ROM renamed shows not located in properties, maps and an open map view; restored ROM recovers', async ({
  page,
}) => {
  const copy = path.join(tmp, 'game.sfc')
  fs.copyFileSync(ROM, copy)
  const manifestPath = await page.evaluate(
    async ({ rom, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const p = await svc.createProject({ romPath: rom, name: 'Gone', directory })
      // The app's own show path: closes other views, sets the context, loads the explorer.
      await getSvc('HackBenchContribution').openPath(p.manifestPath)
      const w = await getWidget('hackbench.map-view')
      await w.open({ manifestPath: p.manifestPath, index: 0x105, label: '105', iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
      return p.manifestPath
    },
    { rom: copy, directory: path.join(tmp, 'Gone') },
  )
  const probe = () =>
    page.evaluate(async mp => {
      const svc = getSvc('Symbol(ProjectService)')
      const paths = await svc.workstationPaths(mp)
      const maps = await svc.mapDetails(mp, 0x105)
      return { rom: paths.romPath, maps: maps.status }
    }, manifestPath)
  const explorerRows = () =>
    page.evaluate(async () => {
      const w = await getWidget('hackbench.map-explorer')
      return (w.model.root.children || []).map(n => n.name).join(' | ')
    })
  // The real UI: File > Open Recent Project, entry 0 (the most recently opened).
  const reopenViaRecent = async () => {
    await expect
      .poll(() =>
        page.evaluate(() =>
          getSvc('CommandRegistry').commandIds.includes('hackbench.project.openRecent.0'),
        ),
      )
      .toBe(true)
    await page.evaluate(() =>
      getSvc('CommandRegistry').executeCommand('hackbench.project.openRecent.0'),
    )
  }
  const viewBody = '.hb-map-view-body'
  const drawn = `${viewBody} canvas[data-drawn]`
  const err = '[data-control="map-error"]'

  const before = await probe()
  expect(before.rom).toBe(copy)
  expect(before.maps).toBe('ok')
  await expect(page.locator(drawn).first()).toBeVisible({ timeout: 20000 })

  fs.renameSync(copy, copy + '.moved')
  await reopenViaRecent()
  const gone = await probe()
  expect(gone.rom).toBeNull()
  expect(gone.maps).toBe('rom-not-located')
  // The visible UI: the open map view, the Maps explorer, then Project Properties.
  await expect(page.locator(err)).toHaveText(/The base ROM .* is not on this machine\./, {
    timeout: 20000,
  })
  await expect.poll(explorerRows).toMatch(/^Locate .+ to load its maps$/)
  await page.evaluate(() =>
    getSvc('CommandRegistry').executeCommand('hackbench.project.properties'),
  )
  const romField = page.locator(
    '.dialogBlock .hb-dialog-row:has(label:text-is("ROM location")) input',
  )
  await expect(romField).toHaveValue('not located', { timeout: 15000 })
  await page.keyboard.press('Escape')

  fs.renameSync(copy + '.moved', copy)
  await reopenViaRecent()
  const back = await probe()
  expect(back.rom).toBe(copy)
  expect(back.maps).toBe('ok')
  await expect(page.locator(err)).toHaveCount(0, { timeout: 20000 })
  await expect(page.locator(drawn).first()).toBeVisible({ timeout: 20000 })
})
