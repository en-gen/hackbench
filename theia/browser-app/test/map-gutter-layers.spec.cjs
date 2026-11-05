/**
 * Layers 2 and 3 through the map view's far-end gutter, en-gen/hackbench#1197. Owner (R41, 2026-11-04): "the
 * background layer(s) should extend through this gutter and fade out as the back area color does". Scope after
 * #1228: the right gutter of a horizontal map and the bottom one of a vertical map, nothing before position 0.
 *
 * SYNTHETIC maps, no ROM: the widget's `projects` is swapped for canned replies (docs/testing.md "Playwright and
 * RPC"). `mapScreen` answers a blank map; `mapBeyond` answers screens past the last with a KNOWN non-uniform
 * pattern: Layer 2 is opaque over the whole screen with green = 100 + (x & 127), red = y & 127 and blue =
 * 40 * (its position past the end), Layer 3 is opaque pure blue over its top 100 rows. A wrong column, row or
 * screen order therefore changes the pixel read. The pixels are read from the gutter canvas itself
 * (`data-layer="gutter-layers"`, a bitmap in map pixels) and the expected values are arithmetic on the gutter
 * width and the pattern, never read from the element under test.
 *
 * What the browser-side logic is held to: the pure pieces (`composeGutter`, `fadeFarEnd`, `clearUncovered`,
 * `beyondScreens`) have unit tests with planted defects (test/suite/unit/GutterLayers.test.ts). This spec holds
 * the wiring those cannot: the toggles reaching the canvas, the lazy fetch, a stale reply dropped by the
 * generation guard, a failed read shown as a note and not re-sent, and the sprite canvas above the layers.
 *
 * Planted defects for the verifier to plant in SOURCE (each should turn the named cases red):
 *   G1 syncGutterLayers does not pass `k => this.layerShown(k)` to composeGutter (passes `() => true`): the toggle case.
 *   G3 fetchBeyond runs from requestVisible without the last-screen check: the lazy-fetch case.
 *   G5 the canvas z-index goes above the off-map canvas (110 -> 130): the sprite cases.
 *   G6 fetchBeyond drops its `generation !== this.generation` guard: the stale-reply case.
 *   G7 fetchBeyond leaves a failed key in `pending` instead of the `gutterFailed` map, or drops the `gutterFailed` skip: the failure case (it would re-ask on every scroll, or never be skipped).
 *   G10 the note stops being derived (it is set once and never recomputed per current key): the note-follows-the-current-key case.
 *   G11 refresh() does not clear `gutterFailed`: the cleared-on-refresh case.
 *   G13 keepViewOnPadChange drops its first `this.fitStrip()` (the one in the first animation frame): the late-sprites case, which has no scroll to fetch for it.
 *   G14 gutterFailure() looks at every failed key, not the current ones: the late-failure-of-an-old-key case.
 *   G8 the gutter canvas repaints blank while replies are pending (drop the `shots.some(x => !x)` keep): the edit case.
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
 * Opens a synthetic map of `screens` screens. `boxes` are opaque 16 x 16 white sprites at [x0, y0] map px.
 * `mode` is how mapBeyond answers: 'ok'; 'fail' (always unavailable); 'failOnce' (the first call fails, later
 * ones answer); 'failThenHold' (the first fails, later ones wait for `window.__openGate()`); 'stale' (the first
 * call waits for the gate and then answers with red 200, later ones at once); 'failLate' (the first call waits
 * for the gate and then fails). `holdSprites` keeps mapSprites waiting for `window.__openSprites()`.
 * Waiting on a gate the test opens, not on a timer, keeps the order of events certain. The screens asked of `mapBeyond` are kept in
 * `window.__beyond`. `math` is the CGADSUB state every reply carries (null: none). A vertical map has Layer 2 only.
 */
async function openSynthetic(
  page,
  {
    screens,
    vertical = false,
    boxes = [],
    mode = 'ok',
    math = null,
    l2Rows = null,
    holdSprites = false,
  },
) {
  await page.evaluate(
    async ({ index, screens, vertical, boxes, mode, math, l2Rows, holdSprites }) => {
      window.__beyond = []
      const [width, height] = vertical ? [512, 256] : [256, 432]
      const orientation = vertical ? 'vertical' : 'horizontal'
      // btoa over 1.7 MB: spreading it into String.fromCharCode overflows the stack, so convert in chunks.
      const b64 = bytes => {
        let s = ''
        for (let i = 0; i < bytes.length; i += 0x8000)
          s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(s)
      }
      const plane = (rows, rgbAt) => {
        const b = new Uint8Array(width * height * 4)
        for (let y = 0; y < rows; y++)
          for (let x = 0; x < width; x++) b.set([...rgbAt(x, y), 255], (y * width + x) * 4)
        return b64(b)
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
        math, layer2Interactive: false, layerNotes: [], backdrop: [200, 0, 0],
      }) // prettier-ignore
      const sprites = boxes.map(([x0, y0], i) => {
        const box = { x0, y0, x1: x0 + 16, y1: y0 + 16 }
        const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
        return { index: 900 + i, id: 1, name: 'Test sprite', x: x0, y: y0, box, rgba, status: 'drawn' } // prettier-ignore
      })
      let calls = 0
      const gate = new Promise(r => (window.__openGate = r))
      const spritesGate = new Promise(r => (window.__openSprites = r))
      const canned = {
        mapStart: () => ({ status: 'ok', x: 1500, y: 1500 }),
        mapScreen: (_m, _i, screen) => base(screen),
        mapBeyond: async (_m, _i, screen) => {
          window.__beyond.push(screen)
          const n = ++calls
          const unread = { status: 'unavailable', reason: 'Part of this map could not be read from the ROM.', detail: 'synthetic detail' } // prettier-ignore
          if (mode === 'fail' || ((mode === 'failOnce' || mode === 'failThenHold') && n === 1)) return unread
          if (mode === 'failLate' && n === 1) return (await gate, unread)
          if (mode === 'failThenHold') await gate
          const past = screen - screens + 1
          const old = mode === 'stale' && n === 1
          if (old) await gate
          return {
            ...base(screen),
            planes: {
              ...none,
              l2Low: plane(l2Rows ?? height, (x, y) => [old ? 200 : y & 127, 100 + (x & 127), 40 * past]),
              l3Low: vertical ? null : plane(100, () => [0, 0, 255]),
            },
          }
        },
        mapSprites: async () => {
          if (holdSprites) await spritesGate
          return { status: 'ok', orientation, screenCount: screens, width, height, sprites }
        },
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
    { index: INDEX, screens, vertical, boxes, mode, math, l2Rows, holdSprites },
  )
  await expect
    .poll(() => page.locator(`${root} .hb-map-view-screen`).count(), { timeout: 30000 })
    .toBe(screens)
  if (!holdSprites) await spritesLanded(page)
  await page.locator(`${root} [data-control="zoom-actual"]`).click()
  await page.waitForTimeout(600)
}

/** Waits for the sprites reply to land, so the pad is final. */
const spritesLanded = page =>
  expect
    .poll(
      () =>
        page.evaluate(
          i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.spritesVersion > 0 && !!w.sprites),
          INDEX,
        ),
      { timeout: 30000 },
    )
    .toBe(true) // prettier-ignore

/** Runs `fn(widget)` in the page. */
const onWidget = (page, fn) =>
  page.evaluate(([i, src]) => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => new Function('w', src)(w)), [INDEX, `return (${fn.toString()})(w)`]) // prettier-ignore

const scrollEnd = (page, vertical) =>
  page.evaluate(
    ({ sel, vertical }) => {
      const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
      s[vertical ? 'scrollTop' : 'scrollLeft'] = 1e9
    },
    { sel: root, vertical },
  )

/** RGBA of bitmap pixels `at` ([x, y] in map px on the gutter canvas). */
const pixels = (page, at) =>
  page.evaluate(
    ({ sel, at }) => {
      const c = document.querySelector(sel)
      const ctx = c.getContext('2d')
      return at.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data))
    },
    { sel: gutter, at },
  )

/**
 * Waits until the canvas shows the first real pixel (the data-drawn marker is set by the blank first paint, so
 * it proves nothing) and returns its bitmap and css size. `at` is a pixel Layer 2 covers; `alphaMin` what it must reach.
 */
async function painted(page, at = [0, 300]) {
  await expect
    .poll(async () => (await pixels(page, [at]))[0][3], { timeout: 20000 })
    .toBeGreaterThan(200)
  return page.evaluate(sel => {
    const c = document.querySelector(sel)
    const r = c.getBoundingClientRect()
    return { w: c.width, h: c.height, cssW: r.width, cssH: r.height }
  }, gutter)
}

/** A canvas stores premultiplied 8-bit color, so a faded pixel reads back a few levels off: compare within 3. */
const expectRgb = (p, want, msg) => expect(p.slice(0, 3).map((v, i) => (Math.abs(v - want[i]) <= 3 ? want[i] : v)), msg).toEqual(want) // prettier-ignore
/** Polls until the pixel at [x, y] reads `want` (within 3 per channel). */
const untilRgb = (page, at, want) =>
  expect
    .poll(async () =>
      (await pixels(page, [at]))[0]
        .slice(0, 3)
        .map((v, i) => (Math.abs(v - want[i]) <= 3 ? want[i] : v)),
    )
    .toEqual(want)

const toggle = (page, layer) => page.locator(`${root} [data-control="layer-${layer}"]`).click()

/** The expected Layer 2 pixel of the canned pattern at gutter-canvas position (x, y), `past` = screen position past the end. */
const l2At = (x, y, past) => [y & 127, 100 + (x & 127), 40 * past]

test('the layers run through the gutter, in the right place, and fade to clear as the back color does', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 3 })
  await scrollEnd(page, false)
  const size = await painted(page)
  expect([size.w, size.h]).toEqual([G, 432]) // from the map edge to the canvas far end, a map tall
  expect([size.cssW, size.cssH]).toEqual([G, 432]) // at Actual size one map px is one css px
  // Fade is 1 - (x + 0.5) / G on the far axis; the color under it is the canned pattern at that exact column and row.
  const xs = [0, 64, 128, 192, 255]
  const px = await pixels(
    page,
    xs.map(x => [x, 300]),
  )
  xs.forEach((x, i) => {
    expect(Math.abs(px[i][3] - 255 * (1 - (x + 0.5) / G)), `alpha at ${x}`).toBeLessThanOrEqual(1)
    if (px[i][3] >= 120) expectRgb(px[i], l2At(x, 300, 1), `color at ${x}`) // premultiplied: a near-clear pixel cannot hold its color
  })
  expect(px[4][3]).toBeLessThanOrEqual(2)
  // Layer 3 (pure blue) is over Layer 2 where it has pixels, by the map own stacking.
  const [l3, l2] = (
    await pixels(page, [
      [0, 50],
      [0, 300],
    ])
  ).map(p => p.slice(0, 3))
  expect(l3).toEqual([0, 0, 255])
  expectRgb(l2, l2At(0, 300, 1))
})

test('hiding Layer 3 and then Layer 2 removes each from the gutter', async ({ page }) => {
  await openSynthetic(page, { screens: 3 })
  await scrollEnd(page, false)
  await painted(page)
  const top = [[0, 50]]
  const low = [[0, 300]]
  await toggle(page, 'l3')
  await untilRgb(page, [0, 50], l2At(0, 50, 1)) // L2 shows through
  expectRgb((await pixels(page, low))[0], l2At(0, 300, 1))
  await toggle(page, 'l2')
  await expect.poll(async () => (await pixels(page, top))[0][3]).toBe(0)
  expect((await pixels(page, low))[0][3]).toBe(0)
  await toggle(page, 'l3')
  await expect.poll(async () => (await pixels(page, top))[0].slice(0, 3)).toEqual([0, 0, 255]) // L3 alone
  expect((await pixels(page, low))[0][3]).toBe(0)
  await toggle(page, 'l2')
  await untilRgb(page, [0, 300], l2At(0, 300, 1))
})

test('the map color math reaches the gutter, and a pixel no layer covered stays clear', async ({
  page,
}) => {
  // Layer 2 covers only the top 200 rows; CGADSUB adds the fixed color (80, 0, 0) to it. Below row 200 nothing draws.
  await openSynthetic(page, { screens: 3, math: { cgadsub: 0x02, fixed: [80, 0, 0] }, l2Rows: 200 })
  await scrollEnd(page, false)
  await expect
    .poll(async () => (await pixels(page, [[0, 150]]))[0][3], { timeout: 20000 })
    .toBeGreaterThan(200)
  const [covered, bare] = await pixels(page, [
    [0, 150],
    [0, 300],
  ])
  expect(covered[0]).toBeGreaterThan(l2At(0, 150, 1)[0] + 40) // red = (y & 127) + fixed red, in 5-bit steps
  expect(bare[3]).toBe(0) // not the fixed color or the black backdrop: clear, so the back area is not faded twice
})

test('the gutter layers are fetched once the last screen is in view, not on open', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 12 })
  expect(await page.evaluate(() => window.__beyond)).toEqual([])
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([12]) // the first screen past screen 11
})

test('screens past the end land end to end in order, and a content band stays solid', async ({
  page,
}) => {
  // A sprite 100 px past the edge: the band is 128 px (whole tiles), solid, then the 256 px gutter: two screens.
  await openSynthetic(page, { screens: 2, boxes: [[2 * 256 + 100, 50]] })
  await scrollEnd(page, false)
  const size = await painted(page)
  expect(size.w).toBe(128 + G)
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([2, 3])
  const at = [
    [108, 300],
    [255, 300],
    [256, 300],
    [128 + 128, 300],
    [size.w - 1, 300],
  ]
  const px = await pixels(page, at)
  expect(px[0][3]).toBe(255) // in the band: solid
  expectRgb(px[0], l2At(108, 300, 1))
  expectRgb(px[1], l2At(255, 300, 1)) // last column of the first screen past the end
  expectRgb(px[2], l2At(0, 300, 2)) // first column of the second one, blue 80
  expect(Math.abs(px[3][3] - 127.5)).toBeLessThanOrEqual(1) // half way down the gutter fade
  expect(px[4][3]).toBeLessThanOrEqual(2)
})

test('sprites that land late widen the far pad, and the screen that now fits is fetched with no scroll', async ({
  page,
}) => {
  // One screen, so the last screen is in view at scroll 0 and nothing ever scrolls. The sprite is 100 px past the edge:
  // once it lands the far pad grows from 256 to 128 + 256, a second screen. The reply is held until the test lets it go.
  await openSynthetic(page, { screens: 1, boxes: [[256 + 100, 50]], holdSprites: true })
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([1])
  await page.evaluate(() => window.__openSprites())
  await spritesLanded(page)
  await expect.poll(() => page.evaluate(() => window.__beyond), { timeout: 15000 }).toEqual([1, 2])
  const size = await painted(page)
  expect(size.w).toBe(128 + G)
})

test('an off-map sprite draws at full strength over the layers', async ({ page }) => {
  await openSynthetic(page, { screens: 2, boxes: [[2 * 256 + 100, 50]] })
  await scrollEnd(page, false)
  await painted(page)
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
  expect(sprite).toEqual([255, 255, 255, 255]) // opaque white, over a layer pixel that is not
  // Under the sprite the layers are NOT white: Layer 3 (blue, rows 0 to 99) on top there, Layer 2 below row 99.
  const [under, below] = await pixels(page, [
    [108, 58],
    [108, 150],
  ])
  expect(under).toEqual([0, 0, 255, 255])
  expectRgb(below, l2At(108, 150, 1))
})

test('a vertical map continues Layer 2 down through its bottom gutter and fades it', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, vertical: true })
  await scrollEnd(page, true)
  const size = await painted(page, [300, 0])
  expect([size.w, size.h]).toEqual([512, G])
  const ys = [0, 128, 255]
  const px = await pixels(
    page,
    ys.map(y => [300, y]),
  )
  ys.forEach((y, i) => {
    expect(Math.abs(px[i][3] - 255 * (1 - (y + 0.5) / G)), `alpha at ${y}`).toBeLessThanOrEqual(1)
    if (px[i][3] >= 120) expectRgb(px[i], l2At(300, y, 1), `color at ${y}`)
  })
  // No Layer 3 on a vertical map; hiding Layer 2 clears the gutter.
  await toggle(page, 'l2')
  await expect.poll(async () => (await pixels(page, [[300, 10]]))[0][3]).toBe(0)
})

test('a vertical map with an off-map sprite below it keeps the band solid and the sprite on top', async ({
  page,
}) => {
  // A sprite 100 px below the map edge (2 screens of 256): the band is 128 px, then the gutter; two screens of layers.
  await openSynthetic(page, { screens: 2, vertical: true, boxes: [[100, 2 * 256 + 100]] })
  await scrollEnd(page, true)
  const size = await painted(page, [300, 0])
  expect([size.w, size.h]).toEqual([512, 128 + G])
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([2, 3])
  const px = await pixels(page, [
    [108, 108],
    [300, 255],
    [300, 256],
    [300, size.h - 1],
  ])
  expect(px[0][3]).toBe(255)
  expectRgb(px[1], l2At(300, 255, 1))
  expectRgb(px[2], l2At(300, 0, 2))
  expect(px[3][3]).toBeLessThanOrEqual(2)
  const sprite = await page.evaluate(sel => {
    const c = document.querySelector(`${sel} [data-layer="off-map-sprites"]`)
    return Array.from(c.getContext('2d').getImageData(108, 2 * 256 + 108, 1, 1).data)
  }, root)
  expect(sprite).toEqual([255, 255, 255, 255])
})

test('a reply that lands after the map was refreshed is dropped, not painted over the new one', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, mode: 'stale' })
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond.length)).toBe(1) // the late (red 200) reply is in flight
  await page.evaluate(i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.refresh()), INDEX) // prettier-ignore
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond.length)).toBe(2)
  await painted(page)
  await page.evaluate(() => window.__openGate()) // the old reply lands now, after the refresh
  await page.waitForTimeout(300)
  await toggle(page, 'l3') // any repaint reads whatever the screens hold
  await toggle(page, 'l3')
  await untilRgb(page, [0, 300], l2At(0, 300, 1)) // not red 200
})

test('a failed gutter read says so as a map note, draws nothing there, and is not asked again until a refresh', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, mode: 'fail' })
  await scrollEnd(page, false)
  const note = page.locator(`${root} [data-note="gutter-layers"]`)
  await expect(note).toHaveText('The graphics layers past the end of the map could not be drawn.')
  await expect(note).toHaveAttribute('title', 'synthetic detail')
  for (let i = 0; i < 3; i++) {
    await scrollEnd(page, false)
    await page.evaluate(sel => { const s = document.querySelector(`${sel} [data-control="map-scroller"]`); s.scrollLeft = 0 }, root) // prettier-ignore
    await scrollEnd(page, false)
  }
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__beyond)).toEqual([2]) // once, not once per scroll
  expect((await pixels(page, [[0, 300]]))[0][3]).toBe(0)
  await page.evaluate(i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.refresh()), INDEX) // prettier-ignore
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond)).toEqual([2, 2]) // a refresh asks again
})

test('a gutter note is cleared by a refresh at once, before the new reads land', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, mode: 'failThenHold' })
  await scrollEnd(page, false)
  const note = page.locator(`${root} [data-note="gutter-layers"]`)
  await expect(note).toHaveCount(1)
  await onWidget(page, w => w.refresh())
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond.length)).toBe(2) // the new read is out and held
  await expect(note).toHaveCount(0)
  await page.evaluate(() => window.__openGate())
  await painted(page)
  await expect(note).toHaveCount(0)
})

test('the gutter note follows the key in view: gone while another switch state is fine, back on the failed one', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, mode: 'failOnce' })
  await scrollEnd(page, false)
  const note = page.locator(`${root} [data-note="gutter-layers"]`)
  await expect(note).toHaveCount(1)
  await onWidget(page, w => w.view.dispatch({ type: 'toggleSwitch', key: 'blue' }))
  await scrollEnd(page, false)
  await painted(page)
  await expect(note).toHaveCount(0) // the blue-on reads all landed
  await onWidget(page, w => w.view.dispatch({ type: 'toggleSwitch', key: 'blue' }))
  await expect(note).toHaveCount(1) // the failed blue-off key is current again: its note returns, nothing re-asks it
  await expect.poll(async () => (await pixels(page, [[0, 300]]))[0][3]).toBe(0) // and the blue-on picture is not left under it
  await scrollEnd(page, false)
  await page.waitForTimeout(500)
  expect(await page.evaluate(() => window.__beyond.length)).toBe(2) // the failed key and the blue-on one, once each
})

test('a read that fails late for a key no longer in view raises no note over a complete gutter', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, mode: 'failLate' })
  await scrollEnd(page, false)
  await expect.poll(() => page.evaluate(() => window.__beyond.length)).toBe(1) // the blue-off read is out, held
  await onWidget(page, w => w.view.dispatch({ type: 'toggleSwitch', key: 'blue' }))
  await scrollEnd(page, false)
  await painted(page) // the blue-on key landed
  await page.evaluate(() => window.__openGate()) // now the old key fails
  await page.waitForTimeout(500)
  await expect(page.locator(`${root} [data-note="gutter-layers"]`)).toHaveCount(0)
  expect((await pixels(page, [[0, 300]]))[0][3]).toBe(255)
})

test('an edit keeps the old gutter picture up until the new replies land', async ({ page }) => {
  await openSynthetic(page, { screens: 2 })
  await scrollEnd(page, false)
  await painted(page)
  // Hold the next gutter replies, then refresh (what an edit does): the canvas must not blank while they are out.
  await page.evaluate(i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => {
    const real = w.projects
    w.projects = new Proxy({}, { get: (_t, k) => k === 'mapBeyond' ? () => new Promise(() => undefined) : real[k] }) // prettier-ignore
    w.refresh()
  }), INDEX) // prettier-ignore
  await scrollEnd(page, false)
  await page.waitForTimeout(1500)
  expect((await pixels(page, [[0, 300]]))[0][3]).toBe(255)
})

test('a 32-screen map has no gutter and no gutter-layers canvas', async ({ page }) => {
  await openSynthetic(page, { screens: 32 })
  await scrollEnd(page, false)
  await page.waitForTimeout(800)
  await expect(page.locator(gutter)).toHaveCount(0)
  expect(await page.evaluate(() => window.__beyond)).toEqual([])
})
