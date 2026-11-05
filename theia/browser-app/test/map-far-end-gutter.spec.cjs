/**
 * The map view's far-end gutter, en-gen/hackbench#1228. Owner (R36, R41, 2026-11-04): "I don't want any gutter
 * to the left of the map, only to the right for the purpose of leaving space to add more map to the right.
 * adding to the left would be problematic as position (0,0) would have to move and shift all tiles to the right"
 * and "I think "the gutter" should be 1 screen wide". This replaces the left half of D48 part 2 and R24.
 *
 * SYNTHETIC maps, no ROM: the widget's `projects` is swapped for canned replies (docs/testing.md "Playwright and
 * RPC"), so a map of any screen count, orientation and sprite set can be asked for. Pixel alpha is read from real
 * screenshots over a white panel: the back color is (200, 0, 0), so its green channel is 255 * (1 - alpha).
 * Expected pads and map pixels come from arithmetic on the map's size and the content placed, never from the
 * element being tested, so a dropped or added pad turns a case red.
 *
 * Planted defects for the verifier to plant in SOURCE (each should turn the named cases red):
 *   W1 offMapPad adds `farGutter` to `left` (or `top`): the nothing-off and planted-defect cases.
 *   W2 the checker inset starts at the leading pad (`pad.left * z`): the content-before cases only (the far-content cases have no leading pad).
 *   W6 measureFit adds `p.left` (or `p.top`) to the cross size, or drops its cross pad term: the Fit cases.
 *   W7 updateHover, the strip onClick or the sprite anchor drop `pad` or scale it by the wrong zoom: the zoomed-in hover case.
 *   W3 fadeMask returns the two-ended gradient: every near-end alpha case.
 *   W4 `farGutter` ignores MAX_SCREENS: the 32-screen cases.
 *   W5 updateHover, the strip onClick or placeStart drop their `pad` term: the hover, click and start cases.
 * The "planted defect" cases also apply W1 and W3 to the live element and require the SAME predicates to fail.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
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

/**
 * Opens a synthetic map: `screens` screens, `vertical`, plus opaque 16 x 16 sprites at `boxes` ([x0, y0] map px,
 * index 900 up). `fit` leaves the tab in Fit, as a new tab opens; otherwise it is set to Actual size. `start` is
 * the player start mapStart reports (both axes). Resolves once the sprites have landed, so the pad is final.
 * A sprite selection reaches the Properties follower, whose frame request for `synthetic.hbproj` rejects into
 * the player's own handler (sprite-frames.ts `select`), so no stub is needed and none reaches `pageerror`.
 */
async function openSynthetic(
  page,
  { screens, vertical = false, boxes = [], fit = false, start = 1500, zoomStep = 'zoom-actual' },
) {
  await page.evaluate(
    async ({ index, screens, vertical, boxes, back, start }) => {
      const [width, height] = vertical ? [512, 256] : [256, 432]
      const orientation = vertical ? 'vertical' : 'horizontal'
      const sprites = boxes.map(([x0, y0], i) => {
        const box = { x0, y0, x1: x0 + 16, y1: y0 + 16 }
        const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
        return { index: 900 + i, id: 1, name: 'Test sprite', x: x0, y: y0, box, rgba, status: 'drawn' } // prettier-ignore
      })
      const canned = {
        mapStart: () => ({ status: 'ok', x: start, y: start }),
        mapScreen: (_m, _i, screen) => ({
          status: 'ok', screen, screenCount: screens, orientation, width, height,
          planes: { l2Low: null, l1Low: null, l2High: null, l1High: null, l3Low: null, l3High: null },
          layer3: { priority: false, reason: null }, screens: { main: ['l1Low'], sub: [] },
          math: null, layer2Interactive: false, layerNotes: [], backdrop: back,
        }), // prettier-ignore
        mapSprites: () => ({ status: 'ok', orientation, screenCount: screens, width, height, sprites }), // prettier-ignore
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
    { index: INDEX, screens, vertical, boxes, back: BACK, start },
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
  // Only the back area is left to see: a white panel, no checkerboard, screens, sprites, edge line or grid.
  await page.addStyleTag({
    content: `${root} .hb-map-view-scroller { background: #fff !important }
      ${root} .hb-checkerboard, ${root} .hb-map-view-screen, ${root} [data-control="map-edge"],
      ${root} .hb-map-view-strip canvas { visibility: hidden !important }`,
  })
  const grid = page.locator(`${root} [data-control="grid-toggle"]`)
  if ((await grid.getAttribute('aria-pressed')) === 'true') await grid.click()
  if (fit) {
    await expect(page.locator(`${root} [data-control="zoom-fit"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(page.locator(`${root} [data-control="map-scroller"]`)).toHaveAttribute('data-start', 'placed', { timeout: 15000 }) // prettier-ignore
  } else {
    await page.locator(`${root} [data-control="${zoomStep}"]`).click()
    await page.waitForTimeout(600)
  }
}

/** Strip, scroller and checkerboard rects in client px, the zoom, the scroller's metrics and the strip's leading pads in map px. */
const measure = page =>
  page.evaluate(sel => {
    const r = q => document.querySelector(`${sel} ${q}`).getBoundingClientRect()
    const [strip, scroller, checker, screen] = [r('.hb-map-view-strip'), r('[data-control="map-scroller"]'), r('[data-layer="checkerboard"]'), r('.hb-map-view-screen')] // prettier-ignore
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const zoom = sc.classList.contains('hb-vertical') ? screen.width / 512 : screen.width / 256
    return {
      strip, scroller, checker, zoom,
      view: { w: sc.clientWidth, h: sc.clientHeight },
      scroll: { left: sc.scrollLeft, top: sc.scrollTop, w: sc.scrollWidth, h: sc.scrollHeight },
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

/** Items 1 and 7: nothing is padded before position 0 (the strip starts at the map). The ONE predicate for the pad. */
const noLeadPad = m => Math.abs(m.pad.left) < 0.5 && Math.abs(m.pad.top) < 0.5

/** Items 3 and 7: opaque at the near edge, about half-faded mid-gutter, transparent at the far end. The ONE predicate for the fade. */
const fadesFarEndOnly = a => a.near > 0.97 && a.mid > 0.35 && a.mid < 0.65 && a.far < 0.05

for (const vertical of [false, true]) {
  const shape = vertical ? 'vertical' : 'horizontal'
  const [mapW, mapH] = vertical ? [512, 4 * 256] : [4 * 256, 432]

  test(`${shape} map, nothing off it: pad 0 before, 256 px after; the checkerboard reaches the near edge; opaque near, transparent far (acceptance 1, 3, 4, 7)`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 4, vertical })
    const m = await measure(page)
    expect(noLeadPad(m)).toBe(true)
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
    expect(fadesFarEndOnly(await alphas(page, vertical))).toBe(true)
  })

  test(`${shape} map, a sprite 32 px before the map: that pad is exactly 32 px and solid; the checkerboard still starts at the strip edge; the gutter still fades after (acceptance 2, 4)`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 4, vertical, boxes: [vertical ? [40, -32] : [-32, 40]] })
    const m = await measure(page)
    // The pad is 32 by arithmetic on the sprite's box, not read back from the strip's own layout alone.
    expect(m.pad[vertical ? 'top' : 'left']).toBeCloseTo(32, 0)
    expect(m.pad[vertical ? 'left' : 'top']).toBeCloseTo(0, 0)
    expect((vertical ? m.strip.height : m.strip.width) / m.zoom).toBeCloseTo(
      (vertical ? mapH : mapW) + 32 + G,
      0,
    )
    // The checkerboard covers the content band: it begins at the strip's edge, not at the map's, and stops at the gutter.
    const [c, s] = vertical
      ? [[m.checker.top, m.checker.bottom], [m.strip.top, m.strip.bottom]]
      : [[m.checker.left, m.checker.right], [m.strip.left, m.strip.right]] // prettier-ignore
    expect(c[0] - s[0]).toBeCloseTo(0, 0)
    expect(s[1] - c[1]).toBeCloseTo(G * m.zoom, 0)
    await scrollAxis(page, vertical, false)
    await page.waitForTimeout(300)
    // Measured after the scroll: the start scroll moved the strip, so the earlier rect is stale.
    const s0 = await measure(page)
    const start = vertical ? s0.strip.top : s0.strip.left
    const cross = vertical ? s0.scroller.left + 4 : s0.scroller.top + 4
    for (const px of [1, 16, 31]) {
      expect(await alphaAt(page, ...at(vertical, start + px * s0.zoom, cross))).toBeGreaterThan(
        0.97,
      )
    }
    expect((await alphas(page, vertical)).far).toBeLessThan(0.05)
  })

  for (const screens of [4, 32]) {
    const gutter = screens === 32 ? 0 : G
    test(`${shape} map of ${screens} screens, a sprite 32 px past the far end: pad 32 + ${gutter}; the content band is solid, ${gutter ? 'the gutter fades after it' : 'there is no fade'}; the checkerboard covers the band (acceptance 3, 4, 8)`, async ({
      page,
    }) => {
      const along = screens * 256
      await openSynthetic(page, {
        screens,
        vertical,
        boxes: [vertical ? [40, along + 16] : [along + 16, 40]],
      })
      const m = await measure(page)
      expect((vertical ? m.strip.height : m.strip.width) / m.zoom).toBeCloseTo(
        along + 32 + gutter,
        0,
      )
      const [c, s] = vertical
        ? [[m.checker.top, m.checker.bottom], [m.strip.top, m.strip.bottom]]
        : [[m.checker.left, m.checker.right], [m.strip.left, m.strip.right]] // prettier-ignore
      expect(c[0] - s[0]).toBeCloseTo(0, 0)
      expect(s[1] - c[1]).toBeCloseTo(gutter * m.zoom, 0)
      await scrollAxis(page, vertical, true)
      await page.waitForTimeout(300)
      const e = await measure(page)
      const end = farEdge(e, vertical)
      const cross = vertical ? e.scroller.left + e.view.w / 2 : e.scroller.top + e.view.h / 2
      // Inside the 32 px content band, just before the gutter: solid.
      expect(
        await alphaAt(page, ...at(vertical, end - (gutter + 16) * e.zoom, cross)),
      ).toBeGreaterThan(0.97)
      if (gutter) {
        expect(await alphaAt(page, ...at(vertical, end - 1, cross))).toBeLessThan(0.05)
        const mid = await alphaAt(page, ...at(vertical, end - (gutter / 2) * e.zoom, cross))
        expect(mid).toBeGreaterThan(0.35)
        expect(mid).toBeLessThan(0.65)
      } else {
        expect(await alphaAt(page, ...at(vertical, end - 1, cross))).toBeGreaterThan(0.97)
      }
    })
  }

  test(`${shape} map: a leading pad and a two-ended mask applied to the live element make the item 1 and 3 predicates fail (acceptance 6)`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 4, vertical })
    // The unplanted view passes the same predicates, so a failure below is the plant, not the harness.
    const clean = await measure(page)
    expect(noLeadPad(clean)).toBe(true)
    expect(fadesFarEndOnly(await alphas(page, vertical))).toBe(true)
    await page.evaluate(({ sel, vertical, g }) => {
      const strip = document.querySelector(`${sel} .hb-map-view-strip`)
      const back = document.querySelector(`${sel} [data-layer="back-area"]`)
      // W1: the gutter back before position 0. W3: the old gradient, transparent at both ends.
      strip.style[vertical ? 'paddingTop' : 'paddingLeft'] = `${parseFloat(getComputedStyle(strip)[vertical ? 'paddingTop' : 'paddingLeft']) + g}px`
      const two = `linear-gradient(${vertical ? 'to bottom' : 'to right'}, transparent, #000 ${g}px, #000 calc(100% - ${g}px), transparent)`
      back.style.maskImage = two
      back.style.webkitMaskImage = two
    }, { sel: root, vertical, g: G * clean.zoom }) // prettier-ignore
    await page.waitForTimeout(300)
    expect(noLeadPad(await measure(page))).toBe(false)
    expect(fadesFarEndOnly(await alphas(page, vertical))).toBe(false)
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

// Acceptance 5. The expected pad is arithmetic on the content placed (a sprite 32 px before the map, or none), so a
// dropped or extra pad term in the hover, click or start code turns these red. The in-map sprite is at map px
// (100, 100) to (116, 116) on both shapes.
for (const vertical of [false, true]) {
  for (const content of [false, true]) {
    const shape = `${vertical ? 'vertical' : 'horizontal'} map ${content ? 'with' : 'without'} content before it`
    const near = vertical ? [60, -32] : [-32, 60]
    const sprites = content ? [[100, 100], near] : [[100, 100]]
    const lead = content ? 32 : 0
    const [padL, padT] = vertical ? [0, lead] : [lead, 0]

    for (const zoomStep of content ? ['zoom-actual', 'zoom-in'] : ['zoom-actual']) {
      test(`${shape}, ${zoomStep}: hover, the sprite anchor and click land on map pixel (108, 108) (acceptance 5)`, async ({
        page,
      }) => {
        await openSynthetic(page, { screens: 4, vertical, boxes: sprites, zoomStep })
        await scrollAxis(page, vertical, false)
        await page.waitForTimeout(300)
        const m = await measure(page)
        // Zoom 1 at Actual size; a step in must leave 1, so the pad is scaled by the zoom, not added in map pixels.
        if (zoomStep === 'zoom-actual') expect(m.zoom).toBeCloseTo(1, 2)
        else expect(m.zoom).toBeGreaterThan(1.05)
        const [px, py] = [m.strip.left + (padL + 108) * m.zoom, m.strip.top + (padT + 108) * m.zoom]
        const widget = fn => page.evaluate(({ i, src }) => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => new Function('w', `return (${src})(w)`)(w)), { i: INDEX, src: fn.toString() }) // prettier-ignore
        await page.mouse.move(px, py)
        await expect
          .poll(() => widget(w => w.hoverSprite?.index ?? null), { timeout: 10000 })
          .toBe(900)
        const a = await page.evaluate(() => {
          const b = document.querySelector('.hb-map-sprite-anchor')?.getBoundingClientRect()
          return b && { left: b.left, top: b.top, w: b.width }
        })
        expect(a).not.toBeNull()
        expect(a.left - m.strip.left).toBeCloseTo((padL + 100) * m.zoom, 0)
        expect(a.top - m.strip.top).toBeCloseTo((padT + 100) * m.zoom, 0)
        expect(a.w).toBeCloseTo(16 * m.zoom, 0)
        await page.mouse.click(px, py)
        await expect.poll(() => widget(w => w.selectedSprite?.index ?? null)).toBe(900)
        if (content) {
          // The same client point measured from the strip's origin is the pad short of the sprite: no hit.
          const [wx, wy] = [m.strip.left + 108 * m.zoom, m.strip.top + 108 * m.zoom]
          await page.mouse.move(wx, wy)
          await expect
            .poll(() => widget(w => w.hoverSprite?.index ?? null), { timeout: 10000 })
            .toBeNull()
          await page.mouse.click(wx, wy)
          await expect.poll(() => widget(w => w.selectedSprite?.index ?? null)).toBeNull()
        }
      })
    }

    test(`${shape}: Fit holds the padded strip to the map and the start centers at (start + pad) (acceptance 5)`, async ({
      page,
    }) => {
      const start = 1500
      // A sprite 16 px on the cross side (above a horizontal map, left of a vertical one) feeds measureFit's cross term.
      const cross = vertical ? [-16, 60] : [60, -16]
      await openSynthetic(page, {
        screens: 12,
        vertical,
        boxes: [...(content ? [near] : []), cross],
        fit: true,
        start,
      })
      const m = await measure(page)
      // Fit frames the cross axis: the map plus the short-side pad the cross sprite makes (16), and nothing of the
      // scroll-axis content. The zoom is the available size over that, clamped to 0.25..4, by arithmetic.
      const [along, across] = vertical
        ? [m.strip.height, m.strip.width]
        : [m.strip.width, m.strip.height]
      expect(along / m.zoom).toBeCloseTo(12 * 256 + lead + G, 0)
      expect(across / m.zoom).toBeCloseTo((vertical ? 512 : 432) + 16, 0)
      const wantZoom = Math.min(4, Math.max(0.25, (vertical ? m.view.w : m.view.h) / ((vertical ? 512 : 432) + 16))) // prettier-ignore
      expect(Math.abs(m.zoom - wantZoom)).toBeLessThanOrEqual(0.01 * wantZoom)
      // The start scroll: (start + pad) * zoom - view / 2, clamped to the scroll range.
      const [view, size, got] = vertical
        ? [m.view.h, m.scroll.h, m.scroll.top]
        : [m.view.w, m.scroll.w, m.scroll.left]
      const want = Math.min(Math.max((start + lead) * m.zoom - view / 2, 0), size - view)
      expect(want).toBeGreaterThan(0)
      expect(Math.abs(got - want)).toBeLessThanOrEqual(1.5)
    })
  }
}
