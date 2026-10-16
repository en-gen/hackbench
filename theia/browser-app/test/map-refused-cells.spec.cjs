/**
 * The map tab marks Layer 1 objects the expander refused, en-gen/hackbench#816. Vanilla draws every object, so
 * the injected case replaces the service's mapScreen reply (the widget's own `projects` property swapped for a
 * Proxy before the map opens: a wrapper on the RPC proxy is never reached, docs/testing.md "Playwright and RPC").
 * The assertion is where the cell LANDS and what its tooltip SAYS, read from the DOM; the un-intercepted map
 * must show none.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

const INDEX = 0x105
const root = `[id="hackbench.map-view:${INDEX}"]`
const WHY = 'HackBench cannot draw this object type yet.'
let tmp
let opened = false

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-refused-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  if (opened)
    await page
      .evaluate(() => getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + 0x105))
      .catch(() => undefined)
  opened = false
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Opens the map; `cells` (when given) is spliced into every mapScreen reply. */
async function openMap(page, cells) {
  const project = await page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index, cells }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      if (cells) {
        const real = w.projects
        w.projects = new Proxy(real, {
          get: (t, k) => {
            if (k !== 'mapScreen') return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
            return async (...a) => {
              const r = await t.mapScreen(...a)
              return r.status === 'ok' ? { ...r, refusedCells: cells } : r
            }
          },
        })
      }
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index: INDEX, cells },
  )
  opened = true
  await expect(
    page.locator(`${root} canvas[data-plane="l1Low"][data-drawn]`).first(),
  ).toHaveAttribute('data-drawn', /^\d+:\d{4}:\d{3}:\d+$/, { timeout: 30000 })
}

test('an injected refusal draws one cell at its tile, with the reason as tooltip and label', async ({
  page,
}) => {
  const cell = { x: 3, y: 5, objectIndex: 7, objectType: 'type 9', handler: 0x0dfff0, why: WHY }
  await openMap(page, [cell])
  const g = page.locator(`${root} [data-control="refused-cell"]`)
  await expect(g).toHaveCount(1, { timeout: 30000 })
  const tip = `Object 7 (type 9): ${WHY}`
  await expect(g.locator('title')).toHaveText(tip)
  await expect(g).toHaveAttribute('aria-label', tip)
  // Where it lands: tile (3,5) of the strip, whatever the zoom.
  const at = await page.evaluate(sel => {
    const strip = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
    const screen = document.querySelector(`${sel} .hb-map-view-screen`).getBoundingClientRect()
    const r = document.querySelector(`${sel} [data-control="refused-cell"] rect`).getBoundingClientRect() // prettier-ignore
    const zoom = screen.width / 256 // a horizontal screen is 16 tiles of 16 px
    return {
      x: (r.left - strip.left) / zoom,
      y: (r.top - strip.top) / zoom,
      w: r.width / zoom,
      h: r.height / zoom,
    }
  }, root)
  expect(at.x).toBeCloseTo(3 * 16, 0)
  expect(at.y).toBeCloseTo(5 * 16, 0)
  expect(at.w).toBeCloseTo(16, 0)
  expect(at.h).toBeCloseTo(16, 0)
})

test('the map as the ROM draws it shows no refused cell', async ({ page }) => {
  await openMap(page, undefined)
  // The overlay is absent, not merely empty; the screen drew, so the zero is not an unloaded page.
  await expect(page.locator(`${root} [data-control="refused-overlay"]`)).toHaveCount(0)
  await expect(page.locator(`${root} [data-control="refused-cell"]`)).toHaveCount(0)
})
