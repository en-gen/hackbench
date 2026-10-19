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

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
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
const GATE_A = 'Its drawing code was changed where HackBench expects a call (byte $0DB4B1 is $00).'
const GATE_B = 'Its drawing code was changed where HackBench expects a call (byte $0DB4D2 is $1F).'
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
const ariaOf = c => (c.reasons.length > 1 ? `${c.reasons.length} issues. ` : '') + tooltipOf(c)
const tooltipOf = c =>
  [`Object ${c.objectIndex} (${c.objectType})`, ...c.reasons.map(r => bullet(c) + r)].join('\n')

/** A cell's box in MAP pixels (strip origin, zoom divided out), and the zoom it was read at. */
const cellAt = (page, index, screenW, n) =>
  page.evaluate(
    ({ sel, screenW, n }) => {
      const strip = document
        .querySelector(`${sel} [data-control="map-edge"]`)
        .getBoundingClientRect() // the map's own origin (#1004)
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
    const gate = { x: 9, y: 2, objectIndex: 8, objectType: 'extended type 5', handler: 0x0db49e, reasons: [GATE_A, WHY] } // prettier-ignore
    await openMap(page, index, [unported, gate])
    const g = page.locator(`${root(index)} [data-control="refused-cell"]`)
    await expect(g).toHaveCount(2, { timeout: 30000 })
    for (const [n, c] of [unported, gate].entries()) {
      const tip = tooltipOf(c)
      await expect(g.nth(n).locator('title')).toHaveText(tip)
      await expect(g.nth(n)).toHaveAttribute('aria-label', ariaOf(c))
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

/**
 * Every cell's geometry read from the SVG's own attributes through getScreenCTM, so the numbers are
 * SCREEN pixels at the current zoom and font-independent: cell box (no dash stroke), its top-right
 * quadrant, the badge circle (no outline, so just r), the badge text's centring attributes, and the "!"
 * attributes in map units.
 */
const geometryAt = (page, index) =>
  page.evaluate(sel => {
    const screenBox = (el, x, y, w, h) => {
      const m = el.getScreenCTM()
      return { l: m.e + x * m.a, t: m.f + y * m.d, r: m.e + (x + w) * m.a, b: m.f + (y + h) * m.d, k: m.a } // prettier-ignore
    }
    return [...document.querySelectorAll(`${sel} [data-control="refused-cell"]`)].map(g => {
      const rect = g.querySelector('rect')
      const n = k => Number(rect.getAttribute(k))
      const c = g.querySelector('[data-control="refused-badge"] circle')
      const t = g.querySelector(':scope > text')
      const a = k => Number(c.getAttribute(k))
      const out = c ? a('r') : 0
      const bt = g.querySelector('[data-control="refused-badge"] text')
      const cell = screenBox(rect, n('x'), n('y'), n('width'), n('height'))
      return {
        x: Number(g.dataset.x),
        y: Number(g.dataset.y),
        count: g.dataset.count,
        cell,
        quad: { l: (cell.l + cell.r) / 2, r: cell.r, t: cell.t, b: (cell.t + cell.b) / 2 },
        stroke: c ? c.getAttribute('stroke') + '|' + c.getAttribute('stroke-width') : null,
        centred: bt ? { x: Number(bt.getAttribute('x')), y: Number(bt.getAttribute('y')), anchor: bt.getAttribute('text-anchor'), baseline: bt.getAttribute('dominant-baseline') } : null, // prettier-ignore
        badge: c ? screenBox(c, a('cx') - out, a('cy') - out, 2 * out, 2 * out) : null,
        badgeText: g.querySelector('[data-control="refused-badge"] text')?.textContent ?? null,
        circle: c ? { cx: a('cx'), cy: a('cy'), out } : null,
        bang: { x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), fs: Number(t.getAttribute('font-size')) }, // prettier-ignore
      }
    })
  }, root(index))

const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5 // prettier-ignore

test('a count badge shows only for 2+ issues, lists every reason, and stays inside its own cell at zoom 1 to 4', async ({
  page,
}) => {
  const mk = (x, y, i, reasons) => ({ x, y, objectIndex: i, objectType: 'type 5', handler: 2, reasons }) // prettier-ignore
  const one = mk(3, 5, 7, [WHY])
  const three = mk(9, 4, 8, [GATE_A, GATE_B, WHY])
  // Neighbours of `three` on the right and above: a badge must not spill onto either.
  const right = mk(10, 4, 9, [GATE_A, WHY])
  const above = mk(9, 3, 10, [GATE_B, WHY])
  const many = mk(
    14,
    8,
    11,
    Array.from({ length: 11 }, (_, i) => `issue ${i}`),
  )
  const cells = [one, three, right, above, many]
  await openMap(page, 0x105, cells)
  const g = page.locator(`${root(0x105)} [data-control="refused-cell"]`)
  await expect(g).toHaveCount(cells.length, { timeout: 30000 })
  for (const [n, c] of cells.entries()) {
    await expect(g.nth(n)).toHaveAttribute('data-count', String(c.reasons.length))
    await expect(g.nth(n)).toHaveAttribute('aria-label', ariaOf(c))
    await expect(g.nth(n).locator('title')).toHaveText(tooltipOf(c))
  }
  await expect(g.nth(0).locator('[data-control="refused-badge"]')).toHaveCount(0)
  await expect(g.nth(1).locator('[data-control="refused-badge"] text')).toHaveText('3')
  await expect(g.nth(4).locator('[data-control="refused-badge"] text')).toHaveText('9+')

  const zooms = []
  for (const step of ['zoom-actual', 'zoom-in', 'zoom-in', 'zoom-in']) {
    await page.locator(`${root(0x105)} [data-control="${step}"]`).click()
    await page.waitForTimeout(400)
    const boxes = await geometryAt(page, 0x105)
    const zoom = boxes[0].cell.k
    zooms.push(zoom)
    expect(boxes[0].badge).toBeNull()
    for (const b of boxes.slice(1)) {
      const tol = 0.5 // screen px, antialiasing
      // The cell is 16 map px, so 16 * zoom on screen; the badge lies wholly in its top-right 8 x 8 quadrant.
      expect(b.cell.r - b.cell.l).toBeCloseTo(16 * zoom, 0)
      expect(b.badge.l).toBeGreaterThanOrEqual(b.quad.l - tol)
      expect(b.badge.r).toBeLessThanOrEqual(b.quad.r + tol)
      expect(b.badge.t).toBeGreaterThanOrEqual(b.quad.t - tol)
      expect(b.badge.b).toBeLessThanOrEqual(b.quad.b + tol)
      // No outline, and the number is centred on the circle by attributes (not by glyph box).
      expect(b.stroke).toBe('null|null')
      expect(b.centred).toEqual({ x: b.circle.cx, y: b.circle.cy, anchor: 'middle', baseline: 'central' }) // prettier-ignore
      for (const o of boxes) if (o !== b) expect(overlap(b.badge, o.cell)).toBe(false) // prettier-ignore
      // The "!" box (generous 0.6 x 0.9 of its font size, map units) must clear the circle.
      const hw = 0.3 * b.bang.fs
      const hh = 0.45 * b.bang.fs
      const nx = Math.max(b.bang.x - hw, Math.min(b.circle.cx, b.bang.x + hw))
      const ny = Math.max(b.bang.y - hh, Math.min(b.circle.cy, b.bang.y + hh))
      expect(Math.hypot(nx - b.circle.cx, ny - b.circle.cy)).toBeGreaterThan(b.circle.out)
    }
  }
  // 1, 2, 3, 4: each step really changed the zoom, so the containment above held at four scales.
  expect(zooms.map(z => Math.round(z * 100) / 100)).toEqual([1, 2, 3, 4])
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
