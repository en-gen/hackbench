/**
 * SPIKE (#946, not for merge): the selected map with its neighbours as thumbnail cards.
 *
 * Checked against the `mapSubAreas` RPC and the shell, not against the page itself:
 * hovering a link changes its computed stroke; clicking a card selects that slot in
 * the Maps tree AND opens it in a map view; the re-targeted view then shows a card
 * back to the map that was left. Vanilla ROM; $00B (down pipe) -> $0E1.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const FROM = 0x0b
const TO = 0xe1

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
let opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subareas-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    const shell = getSvc('ApplicationShell')
    await Promise.all(ids.map(id => shell.closeWidget(id).catch(() => {})))
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Opens the project as File > Open does (loads the Maps tree, wires row clicks), then the neighbours view. */
async function showNeighbours(page, index) {
  await page.evaluate(
    async ({ romPath, directory, index }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }) // prettier-ignore
      const mp = project.manifestPath
      await getSvc('HackBenchContribution').openPath(mp)
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
      await getSvc('CommandRegistry').executeCommand('hackbench.mapView.showWithSubAreas')
    },
    { romPath: ROM, directory: tmp, index },
  )
  opened.push(`hackbench.map-view:${index}`, `hackbench.map-view:${TO}`, `hackbench.map-subareas:${index}`) // prettier-ignore
  return page.locator('.hb-map-subareas')
}

test('hovering a link changes its stroke; clicking the card opens that map, and the view shows the way back', async ({
  page,
}) => {
  test.setTimeout(240000)
  const view = await showNeighbours(page, FROM)
  await expect(view.locator('[data-ready="true"]').first()).toBeVisible({ timeout: 120000 })
  await expect(view.locator(`[data-slot="${TO}"][data-ready="true"]`)).toHaveCount(1, { timeout: 120000 }) // prettier-ignore
  expect(await view.locator(`[data-slot="${TO}"]`).getAttribute('data-side')).toBe('below')

  // (a) Hover: read the computed stroke before and after, pointing at the link's own midpoint.
  const link = view.locator(`[data-link="${TO}:0"]`)
  const stroke = () =>
    link.locator('line').first().evaluate(el => `${getComputedStyle(el).stroke}|${getComputedStyle(el).strokeWidth}`) // prettier-ignore
  const before = await stroke()
  const mid = await link
    .locator('line')
    .last()
    .evaluate(el => {
      const b = el.ownerSVGElement.getBoundingClientRect()
      const a = n => Number(el.getAttribute(n))
      return { x: b.left + (a('x1') + a('x2')) / 2, y: b.top + (a('y1') + a('y2')) / 2 }
    })
  await page.mouse.move(mid.x, mid.y)
  await expect.poll(stroke).not.toBe(before)
  await page.mouse.move(2, 2)
  await expect.poll(stroke).toBe(before)

  // (b) Click: the Maps tree selects that slot and the map view for it opens.
  await view.locator(`[data-slot="${TO}"]`).first().click()
  const tree = () =>
    page.evaluate(async () => {
      const ex = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-explorer')
      return ex.model.selectedNodes.map(n => n.index)
    })
  await expect.poll(tree, { timeout: 30000 }).toEqual([TO])
  const shown = id => page.evaluate(i => !!getSvc('ApplicationShell').getWidgetById(i)?.isVisible, id) // prettier-ignore
  await expect.poll(() => shown(`hackbench.map-view:${TO}`), { timeout: 30000 }).toBe(true)

  // (c) The same view re-targets to the new map and has a card back to the origin.
  await expect(view.locator(`[data-entry-slot="${TO}"]`)).toHaveCount(1, { timeout: 60000 })
  const back = view.locator(`[data-slot="${FROM}"]`)
  await expect(back).toHaveCount(1)
  expect(await back.getAttribute('data-side')).toBe('above')
})
