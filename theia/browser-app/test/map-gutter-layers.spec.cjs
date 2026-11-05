/**
 * Layers 2 and 3 through the map view's far-end gutter, en-gen/hackbench#1197. Owner (R41, 2026-11-04): "the
 * background layer(s) should extend through this gutter and fade out as the back area color does". Scope after
 * #1228: the right gutter of a horizontal map and the bottom one of a vertical map, nothing before position 0.
 *
 * SYNTHETIC maps, no ROM: the widget's `projects` is swapped for canned replies (docs/testing.md "Playwright and
 * RPC"). `mapScreen` answers a blank map; `mapBeyond` answers screens past the last with Layer 2 as opaque green
 * over the whole screen and Layer 3 as opaque blue over its top 100 rows, so each layer is told apart by color.
 * The pixels are read from the gutter canvas itself (`data-layer="gutter-layers"`, a bitmap in map pixels), and
 * the expected alpha is arithmetic on the gutter width, never read from the element under test.
 *
 * Planted defects for the verifier to plant in SOURCE (each should turn the named cases red):
 *   G1 syncGutterLayers skips fadeFarEnd: the fade case and the vertical case.
 *   G2 syncGutterLayers ignores layerShown (passes every plane): the two toggle cases.
 *   G3 fetchBeyond runs from requestVisible without the last-screen check: the lazy-fetch case.
 *   G4 clearUncovered is dropped: not caught here (no color math in these maps); the unit tests cover it.
 *   G5 the canvas z-index goes above the off-map canvas (110 -> 130): the sprite case.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const G = 256
const INDEX = 0x7f1
const root = `[id="hackbench.map-view:${INDEX}"]`
const gutter = `${root} [data-layer="gutter-layers"]`
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let pageErrors
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(async ({ page }) => {
  await page
    .evaluate(i => getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + i), INDEX)
    .catch(() => undefined)
  expect(pageErrors).toEqual([])
})

/**
 * Opens a synthetic map of `screens` screens. `boxes` are opaque 16 x 16 white sprites at [x0, y0] map px. The
 * screens asked of `mapBeyond` are kept in `window.__beyond`. A vertical map has Layer 2 only.
 */
async function openSynthetic(page, { screens, vertical = false, boxes = [] }) {
  await page.evaluate(
    async ({ index, screens, vertical, boxes }) => {
      window.__beyond = []
      const [width, height] = vertical ? [512, 256] : [256, 432]
      const orientation = vertical ? 'vertical' : 'horizontal'
      const plane = (rows, rgb) => {
        const b = new Uint8Array(width * height * 4)
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < width; x++) b.set([...rgb, 255], (y * width + x) * 4)
        return btoa(String.fromCharCode(...b))
      }
      const none = {
        l2Low: null,
        l1Low: null,
        l2High: null,
        l1High: null,
        l3Low: null,
        l3High: null,
      }
      const base = screen => ({
        status: 'ok', screen, screenCount: screens, orientation, width, height, planes: none,
        layer3: { priority: false, reason: null }, screens: { main: ['l2Low', 'l3Low'], sub: [] },
        math: null, layer2Interactive: false, layerNotes: [], backdrop: [200, 0, 0],
      }) // prettier-ignore
      const sprites = boxes.map(([x0, y0], i) => {
        const box = { x0, y0, x1: x0 + 16, y1: y0 + 16 }
        const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
        return { index: 900 + i, id: 1, name: 'Test sprite', x: x0, y: y0, box, rgba, status: 'drawn' } // prettier-ignore
      })
      const canned = {
        mapStart: () => ({ status: 'ok', x: 1500, y: 1500 }),
        mapScreen: (_m, _i, screen) => base(screen),
        mapBeyond: (_m, _i, screen) => {
          window.__beyond.push(screen)
          return {
            ...base(screen),
            planes: { ...none, l2Low: plane(height, [0, 255, 0]), l3Low: vertical ? null : plane(100, [0, 0, 255]) },
          }
        },
        mapSprites: () => ({ status: 'ok', orientation, screenCount: screens, width, height, sprites }),
      } // prettier-ignore
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      w.projects = new Proxy({}, {
        get: (_t, k) => async (...a) => canned[k]?.(...a) ?? { status: 'unavailable', reason: 'synthetic map' },
      }) // prettier-ignore
      await w.open({ manifestPath: 'synthetic.hbproj', index, label: 'synthetic', iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { index: INDEX, screens, vertical, boxes },
  )
  await expect
    .poll(() => page.locator(`${root} .hb-map-view-screen`).count(), { timeout: 30000 })
    .toBe(screens)
  await expect
    .poll(
      () =>
        page.evaluate(
          i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.spritesVersion > 0 && !!w.sprites),
          INDEX,
        ),
      { timeout: 30000 },
    )
    .toBe(true) // prettier-ignore
  await page.locator(`${root} [data-control="zoom-actual"]`).click()
  await page.waitForTimeout(600)
}

const scrollEnd = (page, vertical) =>
  page.evaluate(
    ({ sel, vertical }) => {
      const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
      s[vertical ? 'scrollTop' : 'scrollLeft'] = 1e9
    },
    { sel: root, vertical },
  )

/** RGBA of bitmap pixels `at` ([x, y] in map px on the gutter canvas), once the canvas has been painted. */
const pixels = (page, at) =>
  page.evaluate(
    ({ sel, at }) => {
      const c = document.querySelector(sel)
      const ctx = c.getContext('2d')
      return at.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data))
    },
    { sel: gutter, at },
  )

/** The canvas bitmap size once something is painted on it. */
const painted = async page => {
  await expect(page.locator(gutter)).toHaveAttribute('data-drawn', /.+/, { timeout: 20000 })
  return page.evaluate(sel => {
    const c = document.querySelector(sel)
    return {
      w: c.width,
      h: c.height,
      cssW: c.getBoundingClientRect().width,
      cssH: c.getBoundingClientRect().height,
    }
  }, gutter)
}

const toggle = (page, layer) => page.locator(`${root} [data-control="layer-${layer}"]`).click()

test('the layers run through the gutter and fade to clear, as the back color does', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 3 })
  await scrollEnd(page, false)
  const size = await painted(page)
  expect([size.w, size.h]).toEqual([G, 432]) // from the map edge to the canvas far end, a map tall
  expect([size.cssW, size.cssH]).toEqual([G, 432]) // at Actual size one map px is one css px
  // Fade is 1 - (x + 0.5) / G on the far axis; at x = 0 the layer is opaque, then falls steadily.
  const xs = [0, 64, 128, 192, 255]
  const px = await pixels(
    page,
    xs.map(x => [x, 300]),
  )
  const alphas = px.map(p => p[3])
  expect(alphas[0]).toBe(255)
  xs.forEach((x, i) =>
    expect(Math.abs(alphas[i] - 255 * (1 - (x + 0.5) / G))).toBeLessThanOrEqual(1),
  )
  expect(alphas[4]).toBeLessThanOrEqual(2)
  expect(alphas).toEqual([...alphas].sort((a, b) => b - a))
  // Layer 3 (blue) is over Layer 2 (green) where it has pixels, by the map's own stacking.
  const [l3, l2] = (
    await pixels(page, [
      [0, 50],
      [0, 300],
    ])
  ).map(p => p.slice(0, 3))
  expect(l3).toEqual([0, 0, 255])
  expect(l2).toEqual([0, 255, 0])
})

test('hiding Layer 3 and then Layer 2 removes each from the gutter', async ({ page }) => {
  await openSynthetic(page, { screens: 3 })
  await scrollEnd(page, false)
  await painted(page)
  const top = [[0, 50]]
  const low = [[0, 300]]
  await toggle(page, 'l3')
  await expect.poll(async () => (await pixels(page, top))[0].slice(0, 3)).toEqual([0, 255, 0]) // L2 shows through
  expect((await pixels(page, low))[0].slice(0, 3)).toEqual([0, 255, 0])
  await toggle(page, 'l2')
  await expect.poll(async () => (await pixels(page, top))[0][3]).toBe(0)
  expect((await pixels(page, low))[0][3]).toBe(0)
  await toggle(page, 'l3')
  await expect.poll(async () => (await pixels(page, top))[0].slice(0, 3)).toEqual([0, 0, 255]) // L3 alone
  expect((await pixels(page, low))[0][3]).toBe(0)
  await toggle(page, 'l2')
  await expect.poll(async () => (await pixels(page, low))[0].slice(0, 3)).toEqual([0, 255, 0])
})

test('the gutter layers are fetched once the last screen is in view, not on open', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 12 })
  expect(await page.evaluate(() => window.__beyond)).toEqual([])
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([12]) // the first screen past screen 11
})

test('an off-map sprite draws at full strength over the layers, which run through its band', async ({
  page,
}) => {
  // The sprite sits 100 px past the map edge: the band is 128 px (whole tiles), solid, then the 256 px gutter.
  await openSynthetic(page, { screens: 2, boxes: [[2 * 256 + 100, 50]] })
  await scrollEnd(page, false)
  const size = await painted(page)
  expect(size.w).toBe(128 + G)
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([2, 3]) // 384 px of far end is two screens
  const [inBand, afterBand, nearEnd] = (await pixels(page, [[108, 300], [128 + 128, 300], [size.w - 1, 300]])).map(p => p[3]) // prettier-ignore
  expect(inBand).toBe(255)
  expect(Math.abs(afterBand - 127.5)).toBeLessThanOrEqual(1)
  expect(nearEnd).toBeLessThanOrEqual(2)
  // The sprite is on its own canvas, opaque, above the gutter canvas.
  const z = await page.evaluate(
    sel => ({
      sprites: Number(
        getComputedStyle(document.querySelector(`${sel} [data-layer="off-map-sprites"]`)).zIndex,
      ),
      layers: Number(
        getComputedStyle(document.querySelector(`${sel} [data-layer="gutter-layers"]`)).zIndex,
      ),
    }),
    root,
  )
  expect(z.sprites).toBeGreaterThan(z.layers)
  const sprite = await page.evaluate(sel => {
    const c = document.querySelector(`${sel} [data-layer="off-map-sprites"]`)
    return Array.from(c.getContext('2d').getImageData(2 * 256 + 108, 58, 1, 1).data)
  }, root)
  expect(sprite[3]).toBe(255)
})

test('a vertical map continues Layer 2 down through its bottom gutter and fades it', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, vertical: true })
  await scrollEnd(page, true)
  const size = await painted(page)
  expect([size.w, size.h]).toEqual([512, G])
  const ys = [0, 128, 255]
  const alphas = (
    await pixels(
      page,
      ys.map(y => [300, y]),
    )
  ).map(p => p[3])
  expect(alphas[0]).toBe(255)
  ys.forEach((y, i) =>
    expect(Math.abs(alphas[i] - 255 * (1 - (y + 0.5) / G))).toBeLessThanOrEqual(1),
  )
  expect((await pixels(page, [[300, 10]]))[0].slice(0, 3)).toEqual([0, 255, 0])
  // No Layer 3 on a vertical map: hiding it changes nothing, hiding Layer 2 clears the gutter.
  await toggle(page, 'l2')
  await expect.poll(async () => (await pixels(page, [[300, 10]]))[0][3]).toBe(0)
})

test('a 32-screen map has no gutter and no gutter-layers canvas', async ({ page }) => {
  await openSynthetic(page, { screens: 32 })
  await scrollEnd(page, false)
  await page.waitForTimeout(800)
  await expect(page.locator(gutter)).toHaveCount(0)
  expect(await page.evaluate(() => window.__beyond)).toEqual([])
})
