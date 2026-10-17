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

const WHY = 'HackBench cannot draw this object type yet.'
const WHY_GATE = "This object's drawing code could not be read safely, so it was not drawn."
// $105 is horizontal (16 x 27 tile screens), $109 vertical (32 x 16, 7 screens): map-view.spec.cjs.
const MAPS = [
  { index: 0x105, screenPx: [256, 432] },
  { index: 0x109, screenPx: [512, 256] },
]
const root = index => `[id="hackbench.map-view:${index}"]`
let tmp
let openIndex

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-refused-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  if (openIndex !== undefined)
    await page
      .evaluate(i => getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + i), openIndex)
      .catch(() => undefined)
  openIndex = undefined
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Opens the map. Every mapScreen reply carries `window.__hbRefused` when it is an array (the global is read
 * per reply, so a test can change it and call `refresh()`); undefined leaves the real reply alone.
 */
async function openMap(page, index, cells) {
  const project = await page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index, cells }) => {
      window.__hbRefused = cells
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      const real = w.projects
      w.projects = new Proxy(real, {
        get: (t, k) => {
          if (k !== 'mapScreen') return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
          return async (...a) => {
            const r = await t.mapScreen(...a)
            return r.status === 'ok' && window.__hbRefused
              ? { ...r, refusedCells: window.__hbRefused }
              : r
          }
        },
      })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index, cells },
  )
  openIndex = index
  await expect(
    page.locator(`${root(index)} canvas[data-plane="l1Low"][data-drawn]`).first(),
  ).toHaveAttribute('data-drawn', /^\d+:\d{4}:\d{3}:\d+$/, { timeout: 30000 })
}

const bullet = c => (c.reasons.length > 1 ? '- ' : '')
const tooltipOf = c =>
  [`Object ${c.objectIndex} (${c.objectType})`, ...c.reasons.map(r => bullet(c) + r)].join('\n')

/** A cell's box in MAP pixels (strip origin, zoom divided out), and the zoom it was read at. */
const cellAt = (page, index, screenW, n) =>
  page.evaluate(
    ({ sel, screenW, n }) => {
      const strip = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
      const screen = document.querySelector(`${sel} .hb-map-view-screen`).getBoundingClientRect()
      const cells = document.querySelectorAll(`${sel} [data-control="refused-cell"] rect`)
      const r = cells[n].getBoundingClientRect()
      const zoom = screen.width / screenW
      return {
        zoom,
        x: (r.left - strip.left) / zoom,
        y: (r.top - strip.top) / zoom,
        w: r.width / zoom,
        h: r.height / zoom,
      }
    },
    { sel: root(index), screenW, n },
  )

for (const { index, screenPx } of MAPS) {
  test(`$${index.toString(16)}: cells land on their tiles at two zooms, with the reason as tooltip and label`, async ({
    page,
  }) => {
    const unported = { x: 3, y: 5, objectIndex: 7, objectType: 'type 9', handler: 0x0dfff0, reasons: [WHY] } // prettier-ignore
    const gate = { x: 9, y: 2, objectIndex: 8, objectType: 'extended type 5', handler: 0x0db49e, reasons: [WHY_GATE, WHY] } // prettier-ignore
    await openMap(page, index, [unported, gate])
    const g = page.locator(`${root(index)} [data-control="refused-cell"]`)
    await expect(g).toHaveCount(2, { timeout: 30000 })
    for (const [n, c] of [unported, gate].entries()) {
      const tip = tooltipOf(c)
      await expect(g.nth(n).locator('title')).toHaveText(tip)
      expect(await g.nth(n).getAttribute('aria-label')).toContain(tip)
    }
    const zooms = []
    for (const step of ['zoom-actual', 'zoom-in']) {
      await page.locator(`${root(index)} [data-control="${step}"]`).click()
      await page.waitForTimeout(400)
      for (const [n, c] of [unported, gate].entries()) {
        const at = await cellAt(page, index, screenPx[0], n)
        if (n === 0) zooms.push(at.zoom)
        expect(at.x).toBeCloseTo(c.x * 16, 0)
        expect(at.y).toBeCloseTo(c.y * 16, 0)
        expect(at.w).toBeCloseTo(16, 0)
        expect(at.h).toBeCloseTo(16, 0)
      }
    }
    // The two reads were at different zooms, so the agreement above is scaling, not a fixed pixel.
    expect(zooms[1]).toBeGreaterThan(zooms[0] * 1.2)
  })
}

/** Box of a node in MAP pixels, zoom divided out, relative to the strip. */
const boxesAt = (page, index, screenW) =>
  page.evaluate(
    ({ sel, screenW }) => {
      const strip = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
      const zoom = document.querySelector(`${sel} .hb-map-view-screen`).getBoundingClientRect().width / screenW // prettier-ignore
      const box = el => {
        const r = el.getBoundingClientRect()
        return { l: (r.left - strip.left) / zoom, t: (r.top - strip.top) / zoom, r: (r.right - strip.left) / zoom, b: (r.bottom - strip.top) / zoom } // prettier-ignore
      }
      return [...document.querySelectorAll(`${sel} [data-control="refused-cell"]`)].map(g => ({
        count: g.getAttribute('data-count'),
        rect: box(g.querySelector('rect')),
        badge: g.querySelector('[data-control="refused-badge"]')
          ? box(g.querySelector('[data-control="refused-badge"]'))
          : null,
        badgeText: g.querySelector('[data-control="refused-badge"] text')?.textContent ?? null,
        bang: box(g.querySelector(':scope > text')),
      }))
    },
    { sel: root(index), screenW },
  )

test('a count badge shows only for 2+ issues, lists every reason, and stays inside its cell at every zoom', async ({
  page,
}) => {
  const one = { x: 3, y: 5, objectIndex: 7, objectType: 'type 9', handler: 1, reasons: [WHY] }
  const three = { x: 9, y: 2, objectIndex: 8, objectType: 'type 5', handler: 2, reasons: [WHY_GATE + ' (a)', WHY_GATE + ' (b)', WHY] } // prettier-ignore
  const many = { x: 12, y: 8, objectIndex: 9, objectType: 'type 6', handler: 3, reasons: Array.from({ length: 11 }, (_, i) => `issue ${i}`) } // prettier-ignore
  await openMap(page, 0x105, [one, three, many])
  const g = page.locator(`${root(0x105)} [data-control="refused-cell"]`)
  await expect(g).toHaveCount(3, { timeout: 30000 })
  await expect(g.nth(0)).toHaveAttribute('data-count', '1')
  await expect(g.nth(0).locator('[data-control="refused-badge"]')).toHaveCount(0)
  await expect(g.nth(1)).toHaveAttribute('data-count', '3')
  await expect(g.nth(1).locator('[data-control="refused-badge"] text')).toHaveText('3')
  await expect(g.nth(2).locator('[data-control="refused-badge"] text')).toHaveText('9+')
  await expect(g.nth(1).locator('title')).toHaveText(tooltipOf(three))
  expect(await g.nth(1).locator('title').textContent()).toContain('(a)')
  const all = ['zoom-fit', 'zoom-actual', 'zoom-in', 'zoom-in']
  for (const step of all) {
    await page.locator(`${root(0x105)} [data-control="${step}"]`).click()
    await page.waitForTimeout(400)
    const boxes = await boxesAt(page, 0x105, 256)
    expect(boxes[0].badge).toBeNull()
    for (const b of boxes.slice(1)) {
      const e = 0.6 // stroke antialiasing, in map px
      expect(b.badge.l).toBeGreaterThanOrEqual(b.rect.l - e)
      expect(b.badge.r).toBeLessThanOrEqual(b.rect.r + e)
      expect(b.badge.t).toBeGreaterThanOrEqual(b.rect.t - e)
      expect(b.badge.b).toBeLessThanOrEqual(b.rect.b + e)
      // The badge must not sit on the "!" (boxes may touch, not overlap).
      expect(b.badge.l >= b.bang.r - 0.5 || b.badge.t >= b.bang.b - 0.5).toBe(true)
    }
  }
})

test('cells that were shown clear when the next reply has none', async ({ page }) => {
  const cell = { x: 3, y: 5, objectIndex: 7, objectType: 'type 9', handler: 0x0dfff0, reasons: [WHY] } // prettier-ignore
  await openMap(page, 0x105, [cell])
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(1, { timeout: 30000 }) // prettier-ignore
  await page.evaluate(async i => {
    window.__hbRefused = undefined
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
    w.refresh()
  }, 0x105)
  await expect(page.locator(`${root(0x105)} [data-control="refused-overlay"]`)).toHaveCount(0, { timeout: 30000 }) // prettier-ignore
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(0)
})

test('the map as the ROM draws it shows no refused cell', async ({ page }) => {
  await openMap(page, 0x105, undefined)
  // The overlay is absent, not merely empty; the screen drew, so the zero is not an unloaded page.
  await expect(page.locator(`${root(0x105)} [data-control="refused-overlay"]`)).toHaveCount(0)
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(0)
})
