/**
 * SPIKE (#946, not for merge): the selected map with its neighbours as thumbnail cards.
 *
 * Hovering a link changes its computed stroke; clicking a card selects that slot in the
 * Maps tree AND leaves the preview map tab as a row click does; the re-targeted view then
 * shows a card back. Vanilla ROM; $00B has two exits, a side pipe on screen 3 to $0E1 and a
 * down pipe on screen 7 to $0E0, so exactly two cards. An exit line has its circle at the map
 * end and its arrow at the card end; a return line has its arrow at the map end.
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
const TO2 = 0xe0

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
  opened.push(`hackbench.map-view:${index}`, `hackbench.map-view:preview`, `hackbench.map-subareas:${index}`) // prettier-ignore
  return page.locator('.hb-map-subareas')
}

test('hovering a link changes its stroke; clicking the card opens that map, and the view shows the way back', async ({
  page,
}) => {
  test.setTimeout(240000)
  const view = await showNeighbours(page, FROM)
  await expect(view.locator('[data-ready="true"]').first()).toBeVisible({ timeout: 120000 })
  await expect(view.locator(`[data-slot="${TO}"][data-ready="true"]`)).toHaveCount(1, { timeout: 120000 }) // prettier-ignore
  expect(await view.locator(`[data-slot="${TO}"]`).getAttribute('data-side')).toBe('beside')

  // (a) Hover the link's own midpoint; the computed stroke must change.
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
  // A Maps row click opens the shared preview tab (PreviewTabs.preview): revealed as its bar's current tab.
  const previewState = () =>
    page.evaluate(() => {
      const shell = getSvc('ApplicationShell')
      const w = shell.getWidgetById('hackbench.map-view:preview')
      const bar = w && shell.getTabBarFor(w)
      return bar ? { index: w.viewOptions?.index, current: bar.currentTitle?.owner === w, area: shell.getAreaFor(w) } : null // prettier-ignore
    })
  await expect.poll(previewState, { timeout: 30000 }).toEqual({ index: TO, current: true, area: 'main' }) // prettier-ignore

  // (c) The same view re-targets to the new map and has a card back to the origin.
  await expect(view.locator(`[data-entry-slot="${TO}"]`)).toHaveCount(1, { timeout: 60000 })
  const back = view.locator(`[data-slot="${FROM}"]`)
  await expect(back).toHaveCount(1)
  expect(await back.getAttribute('data-side')).toBe('left')
})

/** The centre of an element's box in client pixels. */
const centre = loc =>
  loc.evaluate(el => {
    const b = el.getBoundingClientRect()
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
  })

test('$00B has exactly one card per exit, and each line points from the pipe to the card', async ({
  page,
}) => {
  test.setTimeout(240000)
  const view = await showNeighbours(page, FROM)
  await expect(view.locator('[data-slot][data-ready="true"]')).toHaveCount(2, { timeout: 120000 })
  await expect(view.locator('[data-slot]')).toHaveCount(2)
  await expect(view.locator(`[data-slot="${TO}"]`)).toHaveCount(1)
  await expect(view.locator(`[data-slot="${TO2}"]`)).toHaveCount(1)

  // Exit line to $0E1: the circle at the map end, the arrowhead at the card end.
  const link = view.locator(`[data-link^="${TO}:"][data-dir="exit"]`)
  await expect(link).toHaveCount(1)
  const map = await view.locator(`canvas[data-entry-slot="${FROM}"]`).boundingBox()
  const card = await view.locator(`[data-slot="${TO}"]`).boundingBox()
  const inside = (p, b, pad) => p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad // prettier-ignore
  const dot = await centre(link.locator('circle'))
  const line = link.locator('line.vis')
  const tip = await line.evaluate(el => {
    const b = el.ownerSVGElement.getBoundingClientRect()
    return { x: b.left + Number(el.getAttribute('x2')), y: b.top + Number(el.getAttribute('y2')) }
  })
  expect(inside(dot, map, 6)).toBe(true)
  expect(inside(dot, card, 0)).toBe(false)
  expect(inside(tip, card, 6)).toBe(true)
  expect(await line.getAttribute('marker-end')).toContain('sa-arrow')
  expect(await link.locator('circle').count()).toBe(1)
})

test('a return line has its arrowhead at the map end and no circle on the card', async ({
  page,
}) => {
  test.setTimeout(240000)
  const view = await showNeighbours(page, TO)
  await expect(view.locator(`[data-slot="${FROM}"][data-ready="true"]`)).toHaveCount(1, { timeout: 120000 }) // prettier-ignore
  const link = view.locator(`[data-link^="${FROM}:"][data-dir="return"]`)
  await expect(link).toHaveCount(1)
  const map = await view.locator(`canvas[data-entry-slot="${TO}"]`).boundingBox()
  const card = await view.locator(`[data-slot="${FROM}"]`).boundingBox()
  const inside = (p, b, pad) => p.x >= b.x - pad && p.x <= b.x + b.width + pad && p.y >= b.y - pad && p.y <= b.y + b.height + pad // prettier-ignore
  const dot = await centre(link.locator('circle'))
  const tip = await link.locator('line.vis').evaluate(el => {
    const b = el.ownerSVGElement.getBoundingClientRect()
    return { x: b.left + Number(el.getAttribute('x2')), y: b.top + Number(el.getAttribute('y2')) }
  })
  expect(inside(dot, card, 6)).toBe(true) // starts at the card map's exit pipe
  expect(inside(tip, map, 6)).toBe(true) // ends at this map's entrance
  expect(inside(tip, card, 0)).toBe(false)
})
