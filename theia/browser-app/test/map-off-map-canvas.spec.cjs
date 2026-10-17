/**
 * The map view's canvas extends past the map for content the data places off it, en-gen/hackbench#1004
 * (owner ruling D76 call 2: "draw it off the map where the game indicates it is drawn"). Vanilla has no
 * off-map refused object, so the cases inject refused cells at x = -2, past the end and (vertical map)
 * above the top, by swapping the widget's own `projects` for a Proxy before the map opens (the RPC
 * intercept pattern, docs/testing.md "Playwright and RPC", and map-refused-cells.spec.cjs).
 *
 * Asserted from the DOM: where each mark lands against the map's EDGE element (so a clamp, or an
 * offset that forgot the zoom, fails), that the scroller can reach it, that Fit shows the whole cross
 * axis including the margin, that hit-testing inside the map is not shifted by the margin, and that a
 * map with nothing off the map keeps today's strip exactly.
 *
 * The fingerprint test is the pixel-identical check against develop: run it once on develop with
 * HB_WRITE_BASELINE=1 (writes <HB_BASELINE_DIR>/<map>.json), then on the branch without it.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const nodeCrypto = require('crypto')
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
const root = index => `[id="hackbench.map-view:${index}"]`
let tmp
let openIndex
let pageErrors

test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-offmap-'))
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

const cell = (x, y, n) => ({ x, y, objectIndex: n, objectType: 'type 9', handler: 0x0dfff0, why: WHY }) // prettier-ignore
const tip = c => `Object ${c.objectIndex} (${c.objectType}): ${c.why}`

/**
 * Opens the map. `cells` replaces every mapScreen reply's refusedCells (undefined leaves the real reply);
 * `block` ({x, y}, map px) replaces mapBlockContents with one l1High indicator there.
 */
async function openMap(page, index, { cells, block } = {}) {
  const project = await page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index, cells, block }) => {
      window.__hbRefused = cells
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      const real = w.projects
      w.projects = new Proxy(real, {
        get: (t, k) => {
          if (k === 'mapScreen')
            return async (...a) => {
              const r = await t.mapScreen(...a)
              return r.status === 'ok' && window.__hbRefused
                ? { ...r, refusedCells: window.__hbRefused }
                : r
            }
          if (k === 'mapBlockContents' && block)
            return async (...a) => {
              const r = await t.mapBlockContents(...a)
              if (r.status !== 'ok') return r
              const art = btoa(String.fromCharCode(...new Uint8Array(1024).fill(200)))
              return {
                ...r,
                arts: { a: art },
                indicators: [{ plane: 'l1High', x: block.x, y: block.y, art: 'a' }],
              }
            }
          return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
        },
      })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index, cells, block },
  )
  openIndex = index
  await expect(
    page.locator(`${root(index)} canvas[data-plane="l1Low"][data-drawn]`).first(),
  ).toHaveAttribute('data-drawn', /^\d+:\d{4}:\d{3}:\d+$/, { timeout: 30000 })
}

/** Rects in client px: the strip, the scroller, the map's edge element (null when absent), one screen. */
const rects = (page, index) =>
  page.evaluate(sel => {
    const r = e => {
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }
    }
    const scroller = document.querySelector(`${sel} [data-control="map-scroller"]`)
    return {
      strip: r(document.querySelector(`${sel} .hb-map-view-strip`)),
      scroller: r(scroller),
      scrollW: scroller.scrollWidth,
      clientW: scroller.clientWidth,
      scrollH: scroller.scrollHeight,
      clientH: scroller.clientHeight,
      edge: r(document.querySelector(`${sel} [data-control="map-edge"]`)),
      screen: r(document.querySelector(`${sel} .hb-map-view-screen`)),
      screens: document.querySelectorAll(`${sel} .hb-map-view-screen`).length,
      marks: [...document.querySelectorAll(`${sel} [data-control="refused-cell"] rect`)].map(r),
    }
  }, root(index))

/**
 * Opens the map, reads how many screens it has, then swaps in `cellsFor(screens)` and refreshes: the
 * past-the-end cells need the real screen count, which no fixed tile number can stand in for.
 */
async function openWithCells(page, index, cellsFor, opts = {}) {
  await openMap(page, index, opts)
  const screens = (await rects(page, index)).screens
  const cells = cellsFor(screens)
  await page.evaluate(
    async ({ i, cells }) => {
      window.__hbRefused = cells
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
      w.refresh()
    },
    { i: index, cells },
  )
  await expect(page.locator(`${root(index)} [data-control="refused-cell"]`)).toHaveCount(cells.length, { timeout: 30000 }) // prettier-ignore
  return cells
}

const click = (page, index, control) =>
  page.locator(`${root(index)} [data-control="${control}"]`).click()

// $105 is horizontal (256 x 432 px screens), $109 vertical (512 x 256): map-refused-cells.spec.cjs.
// `past` is a cell one tile beyond the last column (horizontal) or row (vertical) of an N-screen map.
const CASES = [
  { index: 0x105, screenW: 256, past: n => cell(n * 16 + 1, 5, 3) },
  { index: 0x109, screenW: 512, past: n => cell(5, n * 16 + 1, 3) },
]

for (const { index, screenW, past } of CASES) {
  test(`$${index.toString(16)}: off-map marks land at the data's own offset from the map edge at two zooms`, async ({
    page,
  }) => {
    // Tiles: 2 left of the map, one above it, one past the far end, and one inside (the control).
    const cs = await openWithCells(page, index, n => [cell(-2, 5, 1), cell(5, -1, 2), past(n), cell(7, 9, 4)]) // prettier-ignore
    const zooms = []
    for (const step of ['zoom-actual', 'zoom-in']) {
      await click(page, index, step)
      await page.waitForTimeout(400)
      const r = await rects(page, index)
      expect(r.edge).not.toBeNull()
      const zoom = r.screen.w / screenW
      zooms.push(zoom)
      for (const [n, c] of cs.entries()) {
        // Against the edge element, not the strip: a clamp to the map edge or a margin of the wrong size both fail.
        expect(r.marks[n].left - r.edge.left).toBeCloseTo(c.x * 16 * zoom, 0)
        expect(r.marks[n].top - r.edge.top).toBeCloseTo(c.y * 16 * zoom, 0)
        expect(r.marks[n].w).toBeCloseTo(16 * zoom, 0)
      }
      // The first two marks are OUTSIDE the map rect; the in-map one is inside it.
      expect(r.marks[0].right).toBeLessThanOrEqual(r.edge.left + 1)
      expect(r.marks[1].bottom).toBeLessThanOrEqual(r.edge.top + 1)
      expect(r.marks[3].left).toBeGreaterThanOrEqual(r.edge.left)
      // The strip is the map plus whole-tile margin on the overflowing sides only: 48 px left, 32 px above.
      expect(r.edge.left - r.strip.left).toBeCloseTo(48 * zoom, 0)
      expect(r.edge.top - r.strip.top).toBeCloseTo(32 * zoom, 0)
    }
    expect(zooms[1]).toBeGreaterThan(zooms[0] * 1.2)
  })

  test(`$${index.toString(16)}: the scroller covers the margin and scrolling reaches the far mark; the tooltip is kept`, async ({
    page,
  }) => {
    const [, far] = await openWithCells(page, index, n => [cell(-2, 5, 1), past(n)])
    await click(page, index, 'zoom-actual')
    await page.waitForTimeout(400)
    const r = await rects(page, index)
    const vertical = index === 0x109
    // The strip is wider/taller than the map alone by the pads, and the scroller can scroll over all of it.
    expect(r.strip.w).toBeGreaterThan(r.edge.w)
    expect(vertical ? r.strip.h : r.strip.w).toBeGreaterThan(vertical ? r.edge.h : r.edge.w)
    expect(r.scrollW).toBeGreaterThanOrEqual(Math.floor(r.strip.w) - 1)
    expect(r.scrollH).toBeGreaterThanOrEqual(Math.floor(r.strip.h) - 1)
    // Scroll to the end, and the far mark (past the last column, or row on the vertical map) is inside the view.
    await page.evaluate(sel => {
      const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
      s.scrollLeft = s.scrollWidth
      s.scrollTop = s.scrollHeight
    }, root(index))
    await page.waitForTimeout(300)
    const end = await rects(page, index)
    const m = end.marks[1]
    expect(m.right).toBeGreaterThan(end.scroller.left)
    expect(m.left).toBeLessThan(end.scroller.right)
    expect(m.bottom).toBeGreaterThan(end.scroller.top)
    expect(m.top).toBeLessThan(end.scroller.bottom)
    // The mark is the topmost thing at its centre (hit-testable in the margin) and keeps its tooltip.
    const centre = { x: (m.left + m.right) / 2, y: (m.top + m.bottom) / 2 }
    await page.mouse.move(centre.x, centre.y)
    const hit = await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-control="refused-cell"]')
          ?.getAttribute('data-object'),
      centre,
    )
    expect(hit).toBe(String(far.objectIndex))
    await expect(
      page.locator(`${root(index)} [data-control="refused-cell"][data-object="3"] title`),
    ).toHaveText(tip(far))
    expect(pageErrors).toEqual([])
  })
}

test('Fit shows the whole cross axis including the margin (vertical map, both sides padded)', async ({
  page,
}) => {
  // $109 is 512 px wide; x = -3 pads 64 px on the left, x = 34 (right edge 560) pads 64 px on the right.
  await openMap(page, 0x109, { cells: [cell(-3, 4, 1), cell(34, 4, 2)] })
  await click(page, 0x109, 'zoom-fit')
  await page.waitForTimeout(500)
  const r = await rects(page, 0x109)
  // No horizontal scrolling at Fit: the margin is inside the view, not cut off.
  expect(r.scrollW).toBeLessThanOrEqual(r.clientW + 1)
  expect(r.strip.w).toBeLessThanOrEqual(r.clientW + 1)
  // And Fit used the margin in its sum: 512 + 64 + 64 px of cross axis fill the view (zoom is not at a clamp).
  const zoom = r.screen.w / 512
  expect(r.strip.w / zoom).toBeCloseTo(512 + 128, 0)
  expect(r.marks[0].left).toBeGreaterThanOrEqual(r.scroller.left - 1)
  expect(r.marks[1].right).toBeLessThanOrEqual(r.scroller.right + 1)
})

test('hit-testing inside the map is not shifted by the margin, and the margin does not throw', async ({
  page,
}) => {
  // One refused cell at tile -3 pads the left of $105 by 64 px; the item block is at map px (32, 48).
  await openMap(page, 0x105, { cells: [cell(-3, 5, 1)], block: { x: 32, y: 48 } })
  await click(page, 0x105, 'zoom-actual')
  await page.waitForTimeout(500)
  const r = await rects(page, 0x105)
  const zoom = r.screen.w / 256
  const hover = () =>
    page.evaluate(async i => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
      return w.hover ? [w.hover.x, w.hover.y] : null
    }, 0x105)
  // Over the block, measured from the MAP's origin: found.
  await page.mouse.move(r.edge.left + 40 * zoom, r.edge.top + 56 * zoom)
  await expect.poll(hover, { timeout: 10000 }).toEqual([32, 48])
  // The same offset from the STRIP's origin is 64 px short of it (in the margin): nothing there.
  await page.mouse.move(r.strip.left + 40 * zoom, r.strip.top + 56 * zoom)
  await expect.poll(hover, { timeout: 10000 }).toBeNull()
  // Deep in the margin, and off the strip's far end: no throw, no hit.
  await page.mouse.move(r.strip.left + 2, r.strip.top + 2)
  await page.mouse.move(r.strip.right - 2, r.strip.bottom - 2)
  expect(await hover()).toBeNull()
  expect(pageErrors).toEqual([])
})

test('a map with nothing off the map keeps the strip exactly the map: no margin, no edge line', async ({
  page,
}) => {
  await openMap(page, 0x105, { cells: [cell(3, 5, 1)] })
  await click(page, 0x105, 'zoom-actual')
  await page.waitForTimeout(400)
  const r = await rects(page, 0x105)
  const zoom = r.screen.w / 256
  expect(r.strip.w).toBeCloseTo(r.screens * 256 * zoom, 0)
  expect(r.strip.h).toBeCloseTo(432 * zoom, 0)
  await expect(page.locator(`${root(0x105)} [data-control="map-edge"]`)).toHaveCount(0)
  await expect(page.locator(`${root(0x105)} .hb-map-view-strip`)).not.toHaveAttribute('style', /./)
  await expect(page.locator(`${root(0x105)} [data-layer="off-map-sprites"]`)).toHaveCount(0)
})

/**
 * Pixel-identical check against develop: a fingerprint of the strip's DOM shape and every screen's
 * composite pixels, for vanilla maps, at Fit. Written on develop, compared on the branch.
 */
for (const index of [0x105, 0x109, 0x106]) {
  test(`$${index.toString(16)}: vanilla strip fingerprint matches the recorded develop baseline`, async ({
    page,
  }) => {
    test.skip(!process.env.HB_BASELINE_DIR, 'HB_BASELINE_DIR not set')
    await openMap(page, index)
    await click(page, index, 'zoom-fit')
    await page.waitForTimeout(1500)
    const fp = await page.evaluate(sel => {
      const strip = document.querySelector(`${sel} .hb-map-view-strip`)
      const b = strip.getBoundingClientRect()
      const screens = [...strip.querySelectorAll('.hb-map-view-screen')]
      return {
        stripSize: [b.width, b.height],
        stripStyle: strip.getAttribute('style'),
        children: [...strip.children].map(c => c.className + '|' + (c.getAttribute('style') ?? '')),
        screenSizes: screens.map(s => [s.style.width, s.style.height]),
        // Composite canvases only: the plane canvases hold the same data at opacity 0.
        composites: screens.map(
          s => s.querySelector('canvas[data-layer="screen"]')?.toDataURL() ?? '',
        ),
      }
    }, root(index))
    const sums = fp.composites.map(d => nodeCrypto.createHash('sha256').update(d).digest('hex'))
    expect(sums.some(s => s.length === 64)).toBe(true)
    const out = JSON.stringify({ ...fp, composites: sums }, null, 1)
    const file = path.join(process.env.HB_BASELINE_DIR, `off-map-${index.toString(16)}.json`)
    if (process.env.HB_WRITE_BASELINE) {
      fs.mkdirSync(process.env.HB_BASELINE_DIR, { recursive: true })
      fs.writeFileSync(file, out)
    } else {
      expect(fs.existsSync(file), `baseline ${file}: run on develop with HB_WRITE_BASELINE=1 first`).toBe(true) // prettier-ignore
      expect(out).toBe(fs.readFileSync(file, 'utf8'))
    }
  })
}
