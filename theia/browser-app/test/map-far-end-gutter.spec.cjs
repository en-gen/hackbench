/**
 * The map view's far-end gutter, en-gen/hackbench#1228. Owner, 2026-11-04: "I don't want any gutter to the left
 * of the map, only to the right for the purpose of leaving space to add more map to the right" and "the gutter
 * should be 1 screen wide". This replaces the left half of D48 part 2 and R24.
 *
 * SYNTHETIC maps, no ROM: the widget's `projects` is swapped for canned replies (docs/testing.md "Playwright and
 * RPC"), so a map of any screen count, orientation and sprite set can be asked for. Pixel alpha is read from real
 * screenshots over a white panel: the back color is (200, 0, 0), so its green channel is 255 * (1 - alpha).
 *
 * Planted-defect sanity for the verifier: put `GUTTER_PX` back on `left`/`top` in offMapPad (the pad and the
 * band-opacity cases go red), or return the two-sided gradient from fadeMask (the near-end alpha cases go red).
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const G = 256
const BACK = [200, 0, 0]
const INDEX = 0x7f0
const root = `[id="hackbench.map-view:${INDEX}"]`
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

/** Opens a synthetic map: `screens` screens, `vertical`, plus opaque 16 x 16 sprites at `boxes` ([x0, y0] map px, index 900 up). */
async function openSynthetic(page, { screens, vertical = false, boxes = [] }) {
  await page.evaluate(
    async ({ index, screens, vertical, boxes, back }) => {
      const [width, height] = vertical ? [512, 256] : [256, 432]
      const orientation = vertical ? 'vertical' : 'horizontal'
      const sprites = boxes.map(([x0, y0], i) => {
        const box = { x0, y0, x1: x0 + 16, y1: y0 + 16 }
        const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
        return {
          index: 900 + i,
          id: 1,
          name: 'Test sprite',
          x: x0,
          y: y0,
          box,
          rgba,
          status: 'drawn',
        }
      })
      const canned = {
        mapStart: () => ({ status: 'ok', x: 100, y: 100 }),
        mapScreen: (_m, _i, screen) => ({
          status: 'ok', screen, screenCount: screens, orientation, width, height,
          planes: { l2Low: null, l1Low: null, l2High: null, l1High: null, l3Low: null, l3High: null },
          layer3: { priority: false, reason: null }, screens: { main: ['l1Low'], sub: [] },
          math: null, layer2Interactive: false, layerNotes: [], backdrop: back,
        }), // prettier-ignore
        mapSprites: () => ({
          status: 'ok',
          orientation,
          screenCount: screens,
          width,
          height,
          sprites,
        }),
      }
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      w.projects = new Proxy({}, {
        get: (_t, k) => async (...a) => canned[k]?.(...a) ?? { status: 'unavailable', reason: 'synthetic map' },
      }) // prettier-ignore
      await w.open({ manifestPath: 'synthetic.hbproj', index, label: 'synthetic', iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { index: INDEX, screens, vertical, boxes, back: BACK },
  )
  await expect
    .poll(() => page.locator(`${root} .hb-map-view-screen`).count(), { timeout: 30000 })
    .toBe(screens)
  // Only the back area is left to see: a white panel, no checkerboard, screens, sprites, edge line or grid.
  await page.addStyleTag({
    content: `${root} .hb-map-view-scroller { background: #fff !important }
      ${root} .hb-checkerboard, ${root} .hb-map-view-screen, ${root} [data-control="map-edge"],
      ${root} .hb-map-view-strip canvas { visibility: hidden !important }`,
  })
  const grid = page.locator(`${root} [data-control="grid-toggle"]`)
  if ((await grid.getAttribute('aria-pressed')) === 'true') await grid.click()
  await page.locator(`${root} [data-control="zoom-actual"]`).click()
  await page.waitForTimeout(600)
}

/** Strip, scroller and checkerboard rects in client px, the zoom, and the strip's leading pads in map px. */
const measure = page =>
  page.evaluate(sel => {
    const r = q => document.querySelector(`${sel} ${q}`).getBoundingClientRect()
    const [strip, scroller, checker, screen] = [r('.hb-map-view-strip'), r('[data-control="map-scroller"]'), r('[data-layer="checkerboard"]'), r('.hb-map-view-screen')] // prettier-ignore
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const zoom = sc.classList.contains('hb-vertical') ? screen.width / 512 : screen.width / 256
    return {
      strip, scroller, checker, zoom,
      view: { w: sc.clientWidth, h: sc.clientHeight },
      pad: { left: (screen.left - strip.left) / zoom, top: (screen.top - strip.top) / zoom },
    }
  }, root) // prettier-ignore

/** Scrolls the scroll axis to its start (`end` false) or end. */
const scrollAxis = (page, vertical, end) =>
  page.evaluate(({ sel, vertical, end }) => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s[vertical ? 'scrollTop' : 'scrollLeft'] = end ? 1e9 : 0
  }, { sel: root, vertical, end }) // prettier-ignore

/** The back color's alpha over the white panel at a client pixel, from a real screenshot's green channel. */
async function alphaAt(page, x, y) {
  const png = await page.screenshot({
    clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 },
  })
  const px = await page.evaluate(async b64 => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
    const g = new OffscreenCanvas(1, 1).getContext('2d')
    g.drawImage(bmp, 0, 0)
    return Array.from(g.getImageData(0, 0, 1, 1).data)
  }, png.toString('base64'))
  return 1 - px[1] / 255
}

/** Client coordinates of a point `along` the scroll axis and `across` it. */
const at = (vertical, along, across) => (vertical ? [across, along] : [along, across])

/** Where the strip's far end is on screen: its end, or the scroller's if the strip runs past it. */
const farEdge = (m, vertical) =>
  vertical
    ? Math.min(m.strip.bottom, m.scroller.top + m.view.h)
    : Math.min(m.strip.right, m.scroller.left + m.view.w)

/** Alpha one pixel inside the near edge, at the middle of the far gutter and one pixel inside the far edge. */
async function alphas(page, vertical) {
  await scrollAxis(page, vertical, false)
  await page.waitForTimeout(300)
  let m = await measure(page)
  const cross = vertical ? m.scroller.left + m.view.w / 2 : m.scroller.top + m.view.h / 2
  const near = await alphaAt(
    page,
    ...at(vertical, (vertical ? m.strip.top : m.strip.left) + 1, cross),
  )
  await scrollAxis(page, vertical, true)
  await page.waitForTimeout(300)
  m = await measure(page)
  const end = farEdge(m, vertical)
  const far = await alphaAt(page, ...at(vertical, end - 1, cross))
  const mid = await alphaAt(page, ...at(vertical, end - (G / 2) * m.zoom, cross))
  return { near, mid, far }
}

for (const vertical of [false, true]) {
  const shape = vertical ? 'vertical' : 'horizontal'
  const [mapW, mapH] = vertical ? [512, 4 * 256] : [4 * 256, 432]

  test(`${shape} map, nothing off it: pad 0 before, 256 px after; the checkerboard reaches the near edge; opaque near, transparent far (acceptance 1, 3, 4, 7)`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 4, vertical })
    const m = await measure(page)
    expect(m.pad.left).toBeCloseTo(0, 0)
    expect(m.pad.top).toBeCloseTo(0, 0)
    const [along, across] = vertical
      ? [m.strip.height, m.strip.width]
      : [m.strip.width, m.strip.height]
    expect(along / m.zoom).toBeCloseTo((vertical ? mapH : mapW) + G, 0)
    expect(across / m.zoom).toBeCloseTo(vertical ? mapW : mapH, 0)
    // The checkerboard reaches the near canvas edge and stops at the far gutter.
    const [c, s] = vertical
      ? [[m.checker.top, m.checker.bottom], [m.strip.top, m.strip.bottom]]
      : [[m.checker.left, m.checker.right], [m.strip.left, m.strip.right]] // prettier-ignore
    expect(c[0] - s[0]).toBeCloseTo(0, 0)
    expect(s[1] - c[1]).toBeCloseTo(G * m.zoom, 0)
    const a = await alphas(page, vertical)
    expect(a.near).toBeGreaterThan(0.97)
    expect(a.mid).toBeGreaterThan(0.35)
    expect(a.mid).toBeLessThan(0.65)
    expect(a.far).toBeLessThan(0.05)
  })

  test(`${shape} map, a sprite 32 px before the map: that pad is exactly 32 px and solid; the gutter still fades after (acceptance 2)`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 4, vertical, boxes: [vertical ? [40, -32] : [-32, 40]] })
    const lead = vertical ? 'top' : 'left'
    await expect
      .poll(async () => (await measure(page)).pad[lead], { timeout: 10000 })
      .toBeCloseTo(32, 0)
    const m = await measure(page)
    expect(m.pad[vertical ? 'left' : 'top']).toBeCloseTo(0, 0)
    await scrollAxis(page, vertical, false)
    await page.waitForTimeout(300)
    const start = vertical ? m.strip.top : m.strip.left
    const cross = vertical ? m.scroller.left + 4 : m.scroller.top + 4
    for (const px of [1, 16, 31]) {
      expect(await alphaAt(page, ...at(vertical, start + px * m.zoom, cross))).toBeGreaterThan(0.97)
    }
    expect((await alphas(page, vertical)).far).toBeLessThan(0.05)
  })
}

for (const vertical of [false, true]) {
  for (const [screens, far] of [
    [32, 0],
    [31, G],
  ]) {
    test(`${vertical ? 'vertical' : 'horizontal'} map of ${screens} screens: far-end pad ${far}${screens === 32 ? ', no fade' : ''} (acceptance 8)`, async ({
      page,
    }) => {
      await openSynthetic(page, { screens, vertical })
      const m = await measure(page)
      expect((vertical ? m.strip.height : m.strip.width) / m.zoom).toBeCloseTo(
        screens * 256 + far,
        0,
      )
      if (screens === 32) {
        // Nothing to fade into: the back color is opaque at the far end too.
        await scrollAxis(page, vertical, true)
        await page.waitForTimeout(300)
        const e = await measure(page)
        const cross = vertical ? e.scroller.left + e.view.w / 2 : e.scroller.top + e.view.h / 2
        expect(
          await alphaAt(page, ...at(vertical, farEdge(e, vertical) - 1, cross)),
        ).toBeGreaterThan(0.97)
      }
    })
  }
}

// Acceptance 5: a click lands on the same MAP pixel with and without content before the map.
for (const content of [false, true]) {
  test(`click selection hits the sprite at map pixel (108, 108) ${content ? 'with' : 'without'} content before the map (acceptance 5)`, async ({
    page,
  }) => {
    await openSynthetic(page, {
      screens: 4,
      boxes: content
        ? [
            [100, 100],
            [-32, 40],
          ]
        : [[100, 100]],
    })
    await expect
      .poll(async () => (await measure(page)).pad.left, { timeout: 10000 })
      .toBeCloseTo(content ? 32 : 0, 0)
    await scrollAxis(page, false, false)
    await page.waitForTimeout(300)
    const m = await measure(page)
    await page.mouse.click(
      m.strip.left + (m.pad.left + 108) * m.zoom,
      m.strip.top + (m.pad.top + 108) * m.zoom,
    )
    await expect
      .poll(
        () =>
          page.evaluate(
            i =>
              getSvc('WidgetManager')
                .getOrCreateWidget('hackbench.map-view', { index: i })
                .then(w => w.selectedSprite?.index),
            INDEX,
          ),
        { timeout: 5000 },
      )
      .toBe(900)
  })
}
