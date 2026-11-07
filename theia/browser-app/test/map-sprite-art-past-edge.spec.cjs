/**
 * Sprite art past a map's edge grows no canvas, en-gen/hackbench#1325 (owner, 2026-11-07: "I don't want the
 * empty row beyond the bottom of the map even if sprites render off the bottom of the map"). A synthetic
 * sprite placed ON $1B's last rows whose art reaches 16 px past the bottom is injected into the mapSprites reply
 * (RPC intercept, docs/testing.md "Playwright and RPC"), so the case does not depend on the real Wooden Spikes.
 * Behaviour asserted: the strip is exactly the map tall (no extra row), the grid stops at the map's edge, Fit
 * fits the map alone, the art is cut (nothing painted below), and the part left on the map hovers and selects.
 *
 * Planted defect for the verifier: feed `offMapPad` the sprite's `box` again (`contentRects` in
 * off-map-extent.ts): the strip becomes 448 px tall and the cases below go red.
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
const INDEX = 0x1b
const MAP_H = 432
// Placed at (64, 416), the last map row; its art runs to y 448, 16 px past the bottom.
const ART = { x0: 64, y0: 416, x1: 96, y1: 448 }
const root = `[id="hackbench.map-view:${INDEX}"]`
let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-artedge-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  await page
    .evaluate(i => getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + i), INDEX)
    .catch(() => undefined)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const inWidget = (page, fn) =>
  page.evaluate(
    async ({ i, src }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
      return new Function('w', `return (${src})(w)`)(w)
    },
    { i: INDEX, src: fn.toString() },
  )

async function openMap(page) {
  const project = await page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index, art }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      const real = w.projects
      w.projects = new Proxy(real, {
        get: (t, k) => {
          if (k !== 'mapSprites') return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
          return async (...a) => {
            const r = await t.mapSprites(...a)
            if (r.status !== 'ok') return r
            const n = (art.x1 - art.x0) * (art.y1 - art.y0) * 4
            const rgba = btoa(String.fromCharCode(...new Uint8Array(n).fill(255)))
            const sp = { index: 900, id: 1, name: 'Test sprite', x: art.x0, y: art.y0, box: art, rgba, status: 'drawn' } // prettier-ignore
            return { ...r, sprites: [...r.sprites, sp] }
          }
        },
      })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index: INDEX, art: ART },
  )
  await expect(
    page.locator(`${root} canvas[data-plane="l1Low"][data-drawn]`).first(),
  ).toHaveAttribute('data-drawn', /^\d+:\d{4}:\d{3}:\d+$/, { timeout: 30000 })
  await expect
    .poll(
      () =>
        inWidget(
          page,
          w => w.spritesVersion > 0 && !!w.sprites && w.sprites.sprites.some(s => s.index === 900),
        ),
      { timeout: 30000 },
    ) // prettier-ignore
    .toBe(true)
}

const rects = page =>
  page.evaluate(sel => {
    const r = e => e && e.getBoundingClientRect().toJSON()
    return {
      strip: r(document.querySelector(`${sel} .hb-map-view-strip`)),
      edge: r(document.querySelector(`${sel} [data-control="map-edge"]`)),
      screen: r(document.querySelector(`${sel} .hb-map-view-screen`)),
    }
  }, root)

const actual = async page => {
  await page.locator(`${root} [data-control="zoom-actual"]`).click()
  await page.waitForTimeout(400)
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollLeft = 0
    s.scrollTop = s.scrollHeight
  }, root)
  await page.waitForTimeout(300)
}

test('$1B: art 16 px past the bottom adds no row: the strip is the map tall and the art is cut at the edge', async ({
  page,
}) => {
  await openMap(page)
  await actual(page)
  const r = await rects(page)
  const zoom = r.screen.width / 256
  expect(r.strip.height / zoom).toBeCloseTo(MAP_H, 0)
  expect(r.strip.bottom - r.edge.bottom).toBeCloseTo(0, 0)
  const painted = await page.evaluate(sel => {
    const c = document.querySelector(`${sel} canvas[data-layer="off-map-sprites"]`)
    if (!c) return 0
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) n++
    return n
  }, root)
  expect(painted).toBe(0)
})

test('$1B: the grid stops at the map bottom, and the scroll range ends there', async ({ page }) => {
  await openMap(page)
  await actual(page)
  const toggle = page.locator(`${root} [data-control="grid-toggle"]`)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  const grid = page.locator(`${root} canvas.hb-grid-overlay`)
  await expect(grid).toHaveCount(1, { timeout: 15000 })
  await page.waitForTimeout(500)
  const lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  expect(Math.max(...lines.y.map(l => l.pos))).toBeLessThanOrEqual(MAP_H)
  // The scroller cannot scroll past the map's bottom. The viewport may be taller than the map, so the bound is
  // the larger of the view and the map's bottom; the old extra row is caught by the grid's last line above
  // (448 with the row) and by the strip height in the first case, at any viewport.
  const m = await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const e = document.querySelector(`${sel} [data-control="map-edge"]`).getBoundingClientRect()
    const mapBottom = e.bottom - s.getBoundingClientRect().top + s.scrollTop
    return { scrollH: s.scrollHeight, clientH: s.clientHeight, mapBottom }
  }, root)
  expect(m.scrollH).toBeLessThanOrEqual(Math.max(m.clientH, Math.ceil(m.mapBottom)) + 1)
})

test('$1B: Fit frames the map alone: its height is the map, with no vertical scroll', async ({
  page,
}) => {
  await openMap(page)
  await page.locator(`${root} [data-control="zoom-fit"]`).click()
  await page.waitForTimeout(600)
  const m = await page.evaluate(sel => {
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    return { clientH: sc.clientHeight, scrollH: sc.scrollHeight }
  }, root)
  expect(m.scrollH).toBeLessThanOrEqual(m.clientH + 1)
  const r = await rects(page)
  expect(r.strip.height / (r.screen.width / 256)).toBeCloseTo(MAP_H, 0)
})

test('$1B: the cut sprite hovers and selects from the part left on the map', async ({ page }) => {
  await openMap(page)
  await actual(page)
  const r = await rects(page)
  const zoom = r.screen.width / 256
  // On the map: (80, 424) is inside the art (64-96, 416-448) and inside the map (y < 432).
  const at = { x: r.edge.left + 80.5 * zoom, y: r.edge.top + 424.5 * zoom }
  await page.mouse.move(at.x, at.y)
  await expect
    .poll(() => inWidget(page, w => w.hoverSprite?.index ?? null), { timeout: 10000 })
    .toBe(900)
  await page.mouse.click(at.x, at.y)
  await expect
    .poll(() => inWidget(page, w => w.selectedSprite?.index ?? null), { timeout: 10000 })
    .toBe(900)
})
