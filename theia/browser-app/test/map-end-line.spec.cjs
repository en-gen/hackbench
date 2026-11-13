/**
 * The map view's end line and "Add screen" outline, en-gen/hackbench#1296 (owner D194, option D: "I choose D, but
 * I don't want the line to shift if there is a sprite past the end"). SYNTHETIC maps, no ROM (the widget's
 * `projects` is swapped for canned replies, docs/testing.md "Playwright and RPC"); one case drives the vanilla
 * $1B with a sprite injected past its end and skips without the ROM. The expected far edge is the rect of the
 * LAST rendered `.hb-map-view-screen` (the data end), never the `map-edge` element or the line under test.
 *
 * Bands: every position case runs with no band, with a band BEFORE position 0 (a sprite placed at (-32, -16):
 * the canvas leads the map by 32 px and 16 px, so a line or outline that forgets the leading pad lands off), and
 * with a band past the far end.
 *
 * Planted defects (each turns the named cases red), as source mutations for the verifier:
 *   E1 `farEdge` returns the strip's far end (`pad.left + mapW + pad.right`): the sits-on-the-edge and the
 *      sprite-past-the-end cases (the line follows the content band).
 *   E2 `farEdge` adds `TILE` (16 px) to its far-axis coordinate: the sits-on-the-edge cases.
 *   E3 `farEdge` or `addScreenRect` drops `pad.left` or `pad.top`: the near-band cases (unit sweep too).
 *   E4 the `.hb-map-end-line` z-index drops below 200 (collision overlay): the stacking case.
 *   E5 the `.hb-map-add-screen` outline takes `--theia-foreground` out (white): the light-theme contrast case.
 * The "planted defects" case also moves the LIVE element (one tile, the content band's end, the canvas end) and
 * requires the SAME `onFarEdge` predicate to fail, so the oracle is proven able to fail without editing source.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const INDEX = 0x7f1
const root = `[id="hackbench.map-view:${INDEX}"]`
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const AMBER = [0xff, 0xc2, 0x3d]
const L2_GREEN = [30, 160, 60]

let pageErrors
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
// Returns nothing: closeWidget's result is a widget object graph Playwright cannot serialize.
const closeMap = page =>
  page.evaluate(async i => {
    await getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + i)
  }, INDEX)

test.afterEach(async ({ page }) => {
  await closeMap(page).catch(() => undefined)
  expect(pageErrors).toEqual([])
})

/** Sprite placements ([x, y] map px) for a band: before position 0, past the far end, both, or none. */
const bandBoxes = (vertical, band) => [
  ...(band.includes('near') ? [[-32, -16]] : []),
  ...(band.includes('far') ? [vertical ? [0, 600] : [600, 0]] : []),
]
const BANDS = [[], ['near'], ['far'], ['near', 'far']]
const bandName = band => (band.length ? band.join('+') + ' band' : 'no band')

/**
 * Opens a synthetic map of `screens` screens. `boxes` are opaque 16 x 16 sprites at [x, y] map px (index 900 up);
 * `back` is the back color. `layers` makes Layers 2 and 3 draw (green and blue) in the gutter through `mapBeyond`.
 * `window.__calls` logs every RPC the widget makes, so a click that wrote shows.
 */
async function openSynthetic(
  page,
  {
    screens = 2,
    vertical = false,
    boxes = [],
    back = [200, 0, 0],
    zoomStep = 'zoom-actual',
    layers = false,
  } = {},
) {
  await page.evaluate(
    async ({ index, screens, vertical, boxes, back, layers }) => {
      const [width, height] = vertical ? [512, 256] : [256, 432]
      const orientation = vertical ? 'vertical' : 'horizontal'
      const sprites = boxes.map(([x0, y0], i) => {
        const box = { x0, y0, x1: x0 + 16, y1: y0 + 16 }
        const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
        return { index: 900 + i, id: 1, name: 'Test sprite', x: x0, y: y0, box, rgba, status: 'drawn' } // prettier-ignore
      })
      window.__calls = []
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
        layer3: { priority: false, reason: null },
        screens: { main: layers ? ['l2Low', 'l3Low'] : ['l1Low'], sub: [] },
        math: null, layer2Interactive: false, layerNotes: [], backdrop: back,
      }) // prettier-ignore
      // Opaque green Layer 2 over the whole screen and blue Layer 3 over its first 100 rows (chunked btoa).
      const plane = (rows, rgb) => {
        const b = new Uint8Array(width * height * 4)
        for (let i = 0; i < rows * width; i++) b.set([...rgb, 255], i * 4)
        let s = ''
        for (let i = 0; i < b.length; i += 0x8000)
          s += String.fromCharCode(...b.subarray(i, i + 0x8000))
        return btoa(s)
      }
      const canned = {
        mapStart: () => ({ status: 'ok', x: 0, y: 0 }),
        mapScreen: (_m, _i, screen) => base(screen),
        mapBeyond: (_m, _i, screen) => ({
          ...base(screen),
          planes: { ...none, l2Low: plane(height, [30, 160, 60]), l3Low: vertical ? null : plane(100, [0, 0, 255]) }, // prettier-ignore
        }),
        mapSprites: () => ({ status: 'ok', orientation, screenCount: screens, width, height, sprites }), // prettier-ignore
      }
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      w.projects = new Proxy({}, {
        get: (_t, k) => async (...a) => {
          window.__calls.push(String(k))
          return canned[k]?.(...a) ?? { status: 'unavailable', reason: 'synthetic map' }
        },
      }) // prettier-ignore
      await w.open({ manifestPath: 'synthetic.hbproj', index, label: 'synthetic', iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { index: INDEX, screens, vertical, boxes, back, layers },
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
  await page.locator(`${root} [data-control="${zoomStep}"]`).click()
  await page.waitForTimeout(600)
}

const inWidget = (page, fn, arg) =>
  page.evaluate(
    async ({ i, src, arg }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
      return new Function('w', 'arg', `return (${src})(w, arg)`)(w, arg)
    },
    { i: INDEX, src: fn.toString(), arg },
  )

const scrollEnd = async (page, vertical, sel = root) => {
  await page.evaluate(
    ({ sel, vertical }) => {
      const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
      s[vertical ? 'scrollTop' : 'scrollLeft'] = 1e9
      s[vertical ? 'scrollLeft' : 'scrollTop'] = 0
    },
    { sel, vertical },
  )
  await page.waitForTimeout(300)
}

/**
 * Live rects in client px, and the zoom. `edge` is the map's own rectangle from the first and last rendered
 * `.hb-map-view-screen`, the data's end, independent of the pad and of every element of this feature.
 */
const measure = (page, sel = root) =>
  page.evaluate(sel => {
    const q = s => document.querySelector(`${sel} ${s}`)
    const r = s => q(s)?.getBoundingClientRect().toJSON()
    const screens = [...document.querySelectorAll(`${sel} .hb-map-view-screen`)].map(e => e.getBoundingClientRect()) // prettier-ignore
    const [first, last] = [screens[0], screens[screens.length - 1]]
    const edge = { left: first.left, top: first.top, right: last.right, bottom: last.bottom }
    const sc = q('[data-control="map-scroller"]')
    const vertical = sc.classList.contains('hb-vertical')
    const line = q('[data-control="map-end-line"]')
    const cs = line && getComputedStyle(line)
    const gut = q('[data-layer="gutter-layers"]')
    // The collision overlay's z-index from its own rule: a probe element carries the class, in the strip.
    const probe = document.createElement('div')
    probe.className = 'hb-map-collision'
    q('.hb-map-view-strip').append(probe)
    const collisionZ = getComputedStyle(probe).zIndex
    probe.remove()
    return {
      vertical, zoom: first.width / (vertical ? 512 : 256), edge, line: r('[data-control="map-end-line"]'),
      strip: r('.hb-map-view-strip'), scroller: sc.getBoundingClientRect().toJSON(),
      view: { w: sc.clientWidth, h: sc.clientHeight },
      add: r('[data-control="add-screen"]'), addBox: r('.hb-map-add-screen-box'),
      lineStyle: cs && { size: cs.backgroundSize, zIndex: cs.zIndex, display: cs.display, visibility: cs.visibility, opacity: cs.opacity }, // prettier-ignore
      gutterZ: gut ? getComputedStyle(gut).zIndex : null, collisionZ,
    }
  }, sel) // prettier-ignore

/** The ONE predicate: the line is 5 px thick and centered on the map's far edge, within half a pixel. */
const onFarEdge = m => {
  const [c, e, t] = m.vertical
    ? [(m.line.top + m.line.bottom) / 2, m.edge.bottom, m.line.height]
    : [(m.line.left + m.line.right) / 2, m.edge.right, m.line.width]
  return Math.abs(c - e) <= 0.5 && Math.abs(t - 5) <= 0.01
}

/** RGB of `n` screenshot pixels in a row (a column when `vertical`) from client (x, y). */
async function pixels(page, x, y, n, vertical) {
  const png = await page.screenshot({
    clip: { x: Math.floor(x), y: Math.floor(y), width: vertical ? 1 : n, height: vertical ? n : 1 },
  })
  return page.evaluate(async b64 => {
    const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob())
    const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
    g.drawImage(bmp, 0, 0)
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data
    return Array.from({ length: d.length / 4 }, (_, i) => Array.from(d.subarray(i * 4, i * 4 + 3)))
  }, png.toString('base64'))
}
/** 13 pixels across the line (4 px of map before it, its 5 px, 4 px after), at the middle of its length. */
const acrossLine = (page, m, along = 0.5) => {
  const l = m.line
  return m.vertical
    ? pixels(page, l.left + l.width * along, l.top - 4, 13, true)
    : pixels(page, l.left - 4, l.top + l.height * along, 13, false)
}
const lin = c => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const contrast = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const rgbOf = s =>
  s
    .match(/\d+(\.\d+)?/g)
    .slice(0, 3)
    .map(Number)
const darkest = ps => ps.reduce((a, b) => (lum(b) < lum(a) ? b : a))
const brightest = ps => ps.reduce((a, b) => (lum(b) > lum(a) ? b : a))

for (const vertical of [false, true]) {
  for (const zoomStep of ['zoom-actual', 'zoom-fit']) {
    for (const band of BANDS) {
      const shape = `${vertical ? 'vertical' : 'horizontal'}, ${zoomStep}, ${bandName(band)}`
      test(`1+2: the end line is 5 px thick and centered on the map's far edge, whatever bands the canvas has (${shape})`, async ({
        page,
      }) => {
        await openSynthetic(page, { vertical, zoomStep, boxes: bandBoxes(vertical, band) })
        await scrollEnd(page, vertical)
        const m = await measure(page)
        expect(onFarEdge(m)).toBe(true)
        // Across, the line starts at the map's own near edge, so a dropped leading pad (a band before 0) goes red.
        if (vertical) expect(Math.abs(m.line.left - m.edge.left)).toBeLessThanOrEqual(0.5)
        else expect(Math.abs(m.line.top - m.edge.top)).toBeLessThanOrEqual(0.5)
        // 3 px amber over the 5 px dark edge, in screen px whatever the zoom.
        expect(m.lineStyle.size).toBe(vertical ? '100% 3px' : '3px 100%')
        // It spans the map's other axis, not the canvas.
        if (vertical)
          expect(Math.abs(m.line.width - (m.edge.right - m.edge.left))).toBeLessThanOrEqual(0.5)
        else expect(Math.abs(m.line.height - (m.edge.bottom - m.edge.top))).toBeLessThanOrEqual(0.5)
        if (zoomStep === 'zoom-fit')
          expect(Number.isInteger(m.zoom), `fit zoom ${m.zoom} is fractional`).toBe(false)
        if (band.includes('far')) {
          // The canvas reaches well past the line (content band plus gutter): a line at the canvas end would differ.
          const gap =
            (vertical ? m.strip.bottom - m.edge.bottom : m.strip.right - m.edge.right) / m.zoom
          expect(gap).toBeGreaterThan(256 + 100)
        }
      })
    }
  }
}

test('2: on the vanilla $1B a sprite injected past the end leaves the line on the map edge', async ({
  page,
}) => {
  const ROM = process.env.HB_ROM || romPath(VANILLA)
  test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-endline-'))
  const index = 0x1b
  const id = `[id="hackbench.map-view:${index}"]`
  try {
    const project = await page.evaluate(
      async ({ romPath, directory }) =>
        getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
      { romPath: ROM, directory: path.join(tmp, 'MyHack') },
    )
    await page.evaluate(
      async ({ mp, index }) => {
        const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
        const real = w.projects
        w.projects = new Proxy(real, {
          get: (t, k) => {
            if (k !== 'mapSprites') return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
            return async (...a) => {
              const r = await t.mapSprites(...a)
              if (r.status !== 'ok') return r
              // Placed 64 px past the map's right end ($1B is horizontal): the pad grows, the line must not.
              const x0 = r.width * r.screenCount + 64
              const box = { x0, y0: 0, x1: x0 + 16, y1: 16 }
              const rgba = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))
              return {
                ...r,
                sprites: [
                  ...r.sprites,
                  {
                    index: 900,
                    id: 1,
                    name: 'Test sprite',
                    x: x0,
                    y: 0,
                    box,
                    rgba,
                    status: 'drawn',
                  },
                ],
              }
            }
          },
        })
        await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
        const shell = getSvc('ApplicationShell')
        await shell.addWidget(w, { area: 'main' })
        await shell.activateWidget(w.id)
      },
      { mp: project.manifestPath, index },
    )
    await expect
      .poll(
        () => page.evaluate(i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.spritesVersion > 0 && !!w.sprites && w.sprites.sprites.some(s => s.index === 900)), index),
        { timeout: 30000 },
      )
      .toBe(true) // prettier-ignore
    await page.locator(`${id} [data-control="zoom-actual"]`).click()
    await page.waitForTimeout(500)
    await scrollEnd(page, false, id)
    const m = await measure(page, id)
    expect(onFarEdge(m)).toBe(true)
    expect(m.strip.right - m.edge.right).toBeGreaterThan(256)
  } finally {
    await page.evaluate(i => getSvc('ApplicationShell').closeWidget('hackbench.map-view:' + i), index).catch(() => undefined) // prettier-ignore
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('3: the line shows with the grid on and off and every toolbar toggle off, above the collision overlay and the gutter layers', async ({
  page,
}) => {
  await openSynthetic(page, { screens: 2, boxes: [[40, 40]] })
  await scrollEnd(page, false)
  const grid = page.locator(`${root} [data-control="grid-toggle"]`)
  // The real toolbar buttons; each is clicked until its pressed state is the wanted one. Collision is
  // refused on a synthetic map (disabled), so its stacking is asserted from its own rule below.
  const toggles = ['layer-l1', 'layer-l2', 'layer-l3', 'layer-sprites']
  const setPressed = async (control, on) => {
    const b = page.locator(`${root} [data-control="${control}"]`)
    await expect(b).toBeEnabled()
    if (((await b.getAttribute('aria-pressed')) === 'true') !== on) await b.click()
    await expect(b).toHaveAttribute('aria-pressed', String(on))
  }
  let last
  for (const gridOn of [false, true]) {
    if (((await grid.getAttribute('aria-pressed')) === 'true') !== gridOn) await grid.click()
    for (const off of [[], ['layer-l1'], ['layer-l2'], ['layer-l3'], ['layer-sprites'], toggles]) {
      for (const t of toggles) await setPressed(t, !off.includes(t))
      await page.waitForTimeout(250)
      const m = await measure(page)
      expect(onFarEdge(m), JSON.stringify({ gridOn, off })).toBe(true)
      expect(m.lineStyle).toMatchObject({ display: 'block', visibility: 'visible', opacity: '1' })
      // The line's 3 amber pixels are all amber, grid on or off: the grid canvas draws a 5 px screen-boundary
      // line on the far edge (SCREEN_GRID_WEIGHT), and the end line stands above it, so none may be dimmed.
      const px = await acrossLine(page, m)
      expect(
        px.slice(5, 8).every(p => dist(p, AMBER) < 30),
        JSON.stringify({ gridOn, off, px }),
      ).toBe(true)
      last = m
    }
  }
  const z = Number(last.lineStyle.zIndex)
  expect(z).toBeGreaterThan(Number(last.gutterZ))
  expect(z, 'above the collision overlay').toBeGreaterThan(Number(last.collisionZ))
  expect(z, 'above the grid canvas (1000)').toBeGreaterThan(1000)
})

for (const vertical of [false, true]) {
  test(`3: the end line is drawn over Layers 2 and 3 in the gutter, by pixels (${vertical ? 'vertical' : 'horizontal'})`, async ({
    page,
  }) => {
    await openSynthetic(page, { vertical, layers: true })
    await scrollEnd(page, vertical)
    const grid = page.locator(`${root} [data-control="grid-toggle"]`)
    if ((await grid.getAttribute('aria-pressed')) === 'true') await grid.click()
    await expect
      .poll(() => page.evaluate(sel => !!document.querySelector(`${sel} [data-layer="gutter-layers"]`), root), { timeout: 15000 })
      .toBe(true) // prettier-ignore
    // Sample where Layer 2 shows (below the 100 Layer 3 rows of a horizontal map): along 0.8 of the line's length.
    const m = await measure(page)
    await expect // settle: the gutter canvas paints after its reply
      .poll(async () => dist((await acrossLine(page, m, 0.8))[11], L2_GREEN) < 40, { timeout: 15000 })
      .toBe(true) // prettier-ignore
    const px = await acrossLine(page, m, 0.8)
    // Past the line's 5 px the gutter shows Layer 2 green (not faded: the first px of the gutter).
    expect(dist(px[11], L2_GREEN), JSON.stringify(px)).toBeLessThan(40)
    // The gutter-side half of the line is on top of that canvas: the pixel whose center is just past the
    // edge (E + 0.5 to E + 1.5) is amber, so a gutter-layers canvas stacked above the line goes red here.
    const edgeAt =
      (vertical ? m.edge.bottom : m.edge.right) -
      Math.floor((vertical ? m.line.top : m.line.left) - 4)
    const gutterSide = px[Math.ceil(edgeAt)]
    expect(
      dist(gutterSide, AMBER),
      `gutter-side pixel ${Math.ceil(edgeAt)} of ${JSON.stringify(px)}`,
    ).toBeLessThan(30)
    expect(
      px.slice(5, 8).some(p => dist(p, AMBER) < 30),
      JSON.stringify(px),
    ).toBe(true)
    if (!vertical) {
      // And over Layer 3's blue rows at the top of the line.
      const top = await acrossLine(page, m, 0.1)
      expect(
        top.slice(5, 8).some(p => dist(p, AMBER) < 30),
        JSON.stringify(top),
      ).toBe(true)
    }
  })
}

/** Sets the Theia color theme by id for this session only (persist false, as map16-view.spec.cjs does) and waits for it to apply. */
const setTheme = async (page, id) => {
  await page.evaluate(i => getSvc('ThemeService').setCurrentTheme(i, false), id)
  await expect.poll(() => page.evaluate(() => getSvc('ThemeService').getCurrentTheme().id)).toBe(id)
  await page.waitForTimeout(400)
}

for (const theme of ['light', 'dark']) {
  test(`4: the amber differs from the selection, warning and error colors, and the line and the Add screen outline read against a light and a dark back (${theme} theme)`, async ({
    page,
  }) => {
    const was = await page.evaluate(() => getSvc('ThemeService').getCurrentTheme().id)
    try {
      await setTheme(page, theme)
      const colors = await page.evaluate(() => {
        const probe = v => {
          const e = document.createElement('div')
          e.style.color = `var(${v}, #000)`
          document.body.append(e)
          const c = getComputedStyle(e).color
          e.remove()
          return [v, c]
        }
        return [
          '--theia-focusBorder',
          '--theia-editorWarning-foreground',
          '--theia-editorError-foreground',
          '--theia-list-activeSelectionBackground',
          '--theia-editor-selectionBackground',
        ].map(probe)
      })
      for (const [v, c] of colors)
        expect(dist(AMBER, rgbOf(c)), `amber vs ${v} ${c}`).toBeGreaterThan(60)
      for (const back of [
        [255, 255, 255],
        [0, 0, 0],
      ]) {
        await openSynthetic(page, { back })
        await scrollEnd(page, false)
        const m = await measure(page)
        const line = await acrossLine(page, m)
        const [edge, amber] = [darkest(line.slice(3, 10)), brightest(line.slice(4, 9))]
        expect(dist(amber, AMBER), 'amber pixel').toBeLessThan(30)
        // On a light back the dark edge carries the line; on a dark back the amber does.
        const read = Math.max(contrast(edge, line[0]), contrast(amber, line[0]))
        expect(read, `line vs back ${back}`).toBeGreaterThanOrEqual(3)
        expect(contrast(amber, edge), 'amber vs its dark edge').toBeGreaterThanOrEqual(3)
        // The Add screen outline: its left border at the box's middle height, with 4 px of gutter before it.
        const b = m.addBox
        const o = await pixels(page, b.left - 4, b.top + b.height / 2, 9, false)
        const reads = Math.max(...o.slice(3, 8).map(p => contrast(p, o[0])))
        expect(
          reads,
          `outline vs back ${back} in the ${theme} theme: ${JSON.stringify(o)}`,
        ).toBeGreaterThanOrEqual(3)
        await closeMap(page)
      }
    } finally {
      await setTheme(page, was).catch(() => undefined)
    }
  })
}

for (const vertical of [false, true]) {
  for (const band of BANDS) {
    test(`5: the Add screen outline fills one gutter screen, is labeled, explains itself, and clicking changes nothing (${vertical ? 'vertical' : 'horizontal'}, ${bandName(band)})`, async ({
      page,
    }) => {
      const boxes = [...bandBoxes(vertical, band), vertical ? [0, 40] : [40, 40]] // a sprite on the map to select
      await openSynthetic(page, { vertical, boxes })
      await scrollEnd(page, vertical)
      let m = await measure(page)
      const z = m.zoom
      // One gutter screen: 256 map px along the scroll axis, ending at the strip's end (after any band), the map's extent across.
      const [len, cross, stripEnd, addEnd] = vertical
        ? [m.add.height, m.add.width, m.strip.bottom, m.add.bottom]
        : [m.add.width, m.add.height, m.strip.right, m.add.right]
      expect(len / z).toBeCloseTo(256, 0)
      expect(Math.abs(addEnd - stripEnd)).toBeLessThanOrEqual(0.5)
      expect(cross / z).toBeCloseTo(vertical ? 512 : 432, 0)
      // Across, it spans the map: its start is the map's first screen edge (the leading pad is not under it).
      expect(
        Math.abs(vertical ? m.add.left - m.edge.left : m.add.top - m.edge.top),
      ).toBeLessThanOrEqual(0.5)
      // Along, it begins no earlier than the map's far edge plus any band, and no band hides under it.
      expect((vertical ? m.add.top - m.edge.bottom : m.add.left - m.edge.right) / z).toBeCloseTo(
        band.includes('far') ? 112 : 0,
        0,
      )
      expect(m.addBox.left - m.add.left).toBeCloseTo(6, 0) // inset 6 px
      const look = () =>
        page.evaluate(sel => {
          const e = document.querySelector(`${sel} .hb-map-add-screen-box`)
          const c = getComputedStyle(e)
          return { text: e.textContent, border: c.borderTopStyle + ' ' + c.borderTopColor, opacity: c.opacity, cursor: getComputedStyle(e.parentElement).cursor, bg: c.backgroundColor, title: e.parentElement.title } // prettier-ignore
        }, root)
      const before = await look()
      expect(before).toMatchObject({ text: 'Add screen', cursor: 'default', opacity: '0.75', title: 'Add screen is not available yet' }) // prettier-ignore
      expect(before.border).toMatch(/^dashed /)
      expect(before.bg).toBe('rgba(0, 0, 0, 0)') // no fill: not a button
      // A sprite is selected first, so a stray map click (which would clear it) shows.
      const placed = boxes.length - 1
      await inWidget(page, (w, i) => w.selectSprite(w.sprites.sprites[i]), placed)
      const sel0 = await inWidget(page, w => w.selectedSprite?.index ?? null)
      expect(sel0).toBe(900 + placed)
      const calls0 = await page.evaluate(() => window.__calls.length)
      const scrollOf = () => page.evaluate(sel => { const s = document.querySelector(`${sel} [data-control="map-scroller"]`); return [s.scrollLeft, s.scrollTop] }, root) // prettier-ignore
      const scroll0 = await scrollOf()
      m = await measure(page)
      const [cx, cy] = [m.addBox.left + m.addBox.width / 2, m.addBox.top + m.addBox.height / 2]
      await page.mouse.move(cx, cy)
      await page.waitForTimeout(200)
      expect(await look()).toEqual(before) // hover adds no highlight
      await page.mouse.click(cx, cy)
      await page.mouse.dblclick(cx, cy)
      await page.waitForTimeout(400)
      expect(await look()).toEqual(before)
      expect(await inWidget(page, w => w.selectedSprite?.index ?? null)).toBe(sel0)
      expect(await page.evaluate(() => window.__calls.length)).toBe(calls0)
      expect(await scrollOf()).toEqual(scroll0)
    })
  }
}

for (const vertical of [false, true]) {
  test(`5: a 31-screen map still has the one-screen Add screen outline (${vertical ? 'vertical' : 'horizontal'})`, async ({
    page,
  }) => {
    await openSynthetic(page, { screens: 31, vertical })
    await scrollEnd(page, vertical)
    const m = await measure(page)
    expect(onFarEdge(m)).toBe(true)
    expect(m.add).toBeDefined()
    expect((vertical ? m.add.height : m.add.width) / m.zoom).toBeCloseTo(256, 0)
    await closeMap(page)
  })
}

test('6: a 32-screen map has no outline and its 5 px end line sits wholly inside the strip and the scroller', async ({
  page,
}) => {
  for (const vertical of [false, true]) {
    await openSynthetic(page, { screens: 32, vertical })
    await scrollEnd(page, vertical)
    const m = await measure(page)
    expect(m.add).toBeUndefined()
    // Drawn inset: its outer side is the map edge, so the whole 5 px box is inside the strip and the visible scroller.
    const [lo, hi, sLo, sHi, vLo, vHi, edge] = vertical
      ? [
          m.line.top,
          m.line.bottom,
          m.strip.top,
          m.strip.bottom,
          m.scroller.top,
          m.scroller.top + m.view.h,
          m.edge.bottom,
        ]
      : [
          m.line.left,
          m.line.right,
          m.strip.left,
          m.strip.right,
          m.scroller.left,
          m.scroller.left + m.view.w,
          m.edge.right,
        ]
    expect(hi - lo).toBeCloseTo(5, 1)
    expect(Math.abs(hi - edge)).toBeLessThanOrEqual(0.5)
    expect(lo).toBeGreaterThanOrEqual(sLo - 0.5)
    expect(hi).toBeLessThanOrEqual(sHi + 0.5)
    expect(lo).toBeGreaterThanOrEqual(vLo - 0.5)
    expect(hi).toBeLessThanOrEqual(vHi + 0.5)
    const px = await acrossLine(page, m)
    expect(px.filter(p => dist(p, AMBER) < 30).length).toBeGreaterThanOrEqual(2)
    await closeMap(page)
  }
})

test('planted defects: a line one tile off, at the content end or at the canvas end fails the same predicate', async ({
  page,
}) => {
  await openSynthetic(page, { boxes: [[600, 0]] })
  await scrollEnd(page, false)
  const m = await measure(page)
  expect(onFarEdge(m)).toBe(true) // the real line passes
  const nudge = async dx => {
    await page.evaluate(
      ({ sel, dx }) => {
        const e = document.querySelector(`${sel} [data-control="map-end-line"]`)
        e.style.left = parseFloat(e.style.left) + dx + 'px'
      },
      { sel: root, dx },
    )
    return measure(page)
  }
  const z = m.zoom
  // One tile (16 px) off; then to the content band's end (112 px past the edge); then to the canvas end (368 px).
  expect(onFarEdge(await nudge(16 * z))).toBe(false)
  expect(onFarEdge(await nudge((112 - 16) * z))).toBe(false)
  expect(onFarEdge(await nudge((368 - 112) * z))).toBe(false)
})
