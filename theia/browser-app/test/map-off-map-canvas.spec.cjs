/**
 * The map view's fixed gutter, en-gen/hackbench#1004 (owner ruling D48 part 2: "half a screen width of
 * gutter on each end ... The background should fade in a gradient to the edges"). A HORIZONTAL map has
 * 128 px of canvas on its left and right, always, and none above or below; a VERTICAL map has none and
 * must look exactly as on develop (the rest is pending D145).
 *
 * Asserted from the DOM: the strip is the map plus the gutters, the back area fades to transparent over
 * each gutter, real sprite pixels land in the gutter at the data's position (ghost house $C4, $DD),
 * injected marks inside the gutter draw at their raw tile, the grid runs across the gutter, hover inside
 * the map is offset by the gutter, and a vertical map is untouched. Clamping beyond the gutter is
 * node-side and is covered by RefusedCells.synthetic.test.ts: an injected reply bypasses it.
 *
 * Injection uses the RPC intercept pattern (docs/testing.md "Playwright and RPC"; the widget's own
 * `projects` swapped for a Proxy before the map opens, as map-refused-cells.spec.cjs does).
 *
 * The fingerprint test is the pixel-identical check against develop for the vertical map $109: run it
 * once on develop with HB_WRITE_BASELINE=1 (writes <HB_BASELINE_DIR>/off-map-109.json), then on the branch
 * without it. Planted-offset sanity for the verifier: drop `- pad.left` in updateHover, make
 * offMapSpritePixels write `(y + pad.top) * w + x` without `+ pad.left`, or set the back area to a solid
 * color; the hover, canvas-pixel and fade assertions below must go red.
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

const GUTTER = 128
const WHY = 'HackBench cannot draw this object type yet.'
const root = index => `[id="hackbench.map-view:${index}"]`
let tmp
let openIndex
let pageErrors

test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gutter-'))
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

/**
 * Opens the map and returns its project's manifest path. `cells` replaces every mapScreen reply's
 * refusedCells (undefined leaves the real reply); `block` ({x, y}, map px) replaces mapBlockContents with
 * one l1High indicator there.
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
  return project.manifestPath
}

/** Waits until the widget has taken its sprites reply, so a late gutter canvas cannot race an assertion. */
const spritesLanded = (page, index) =>
  expect
    .poll(
      () =>
        page.evaluate(async i => {
          const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }) // prettier-ignore
          return w.spritesVersion > 0 && !!w.sprites
        }, index),
      { timeout: 30000 },
    )
    .toBe(true)

/** Rects in client px: the strip, the scroller, the map's edge element (null when absent), the back area, one screen. */
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
      edge: r(document.querySelector(`${sel} [data-control="map-edge"]`)),
      backArea: r(document.querySelector(`${sel} [data-layer="back-area"]`)),
      screen: r(document.querySelector(`${sel} .hb-map-view-screen`)),
      screens: document.querySelectorAll(`${sel} .hb-map-view-screen`).length,
      marks: [...document.querySelectorAll(`${sel} [data-control="refused-cell"] rect`)].map(r),
    }
  }, root(index))

const click = (page, index, control) =>
  page.locator(`${root(index)} [data-control="${control}"]`).click()

const gridToggle = index => `${root(index)} [data-control="grid-toggle"]`

/**
 * The off-map canvas's opaque pixels by region, in MAP pixels: how many fall in the left gutter, in the map and
 * in the right gutter, and the x range of the left-gutter ones.
 */
const gutterPixels = (page, index) =>
  page.evaluate(
    ({ sel, gutter }) => {
      const c = document.querySelector(`${sel} canvas[data-layer="off-map-sprites"]`)
      if (!c) return null
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const out = { left: 0, map: 0, right: 0, minX: 1e9, maxX: -1e9, cw: c.width, ch: c.height }
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++) {
          if (data[(y * c.width + x) * 4 + 3] === 0) continue
          const mx = x - gutter
          const side = mx < 0 ? 'left' : mx < c.width - 2 * gutter ? 'map' : 'right'
          out[side]++
          if (side === 'left') {
            out.minX = Math.min(out.minX, mx)
            out.maxX = Math.max(out.maxX, mx)
          }
        }
      return out
    },
    { sel: root(index), gutter: GUTTER },
  )

// $105 is horizontal (256 x 432 px screens), $109 vertical (512 x 256): map-refused-cells.spec.cjs.
test('$105: a horizontal map always has 128 px each side and none above or below, at two zooms', async ({
  page,
}) => {
  await openMap(page, 0x105)
  for (const step of ['zoom-actual', 'zoom-in']) {
    await click(page, 0x105, step)
    await page.waitForTimeout(400)
    const r = await rects(page, 0x105)
    const zoom = r.screen.w / 256
    expect(r.edge).not.toBeNull()
    // Strip width = (W + 256) * zoom, height the map's alone.
    expect(r.strip.w).toBeCloseTo((r.screens * 256 + 2 * GUTTER) * zoom, 0)
    expect(r.strip.h).toBeCloseTo(432 * zoom, 0)
    expect(r.edge.left - r.strip.left).toBeCloseTo(GUTTER * zoom, 0)
    expect(r.strip.right - r.edge.right).toBeCloseTo(GUTTER * zoom, 0)
    expect(r.edge.top - r.strip.top).toBeCloseTo(0, 0)
    expect(r.strip.bottom - r.edge.bottom).toBeCloseTo(0, 0)
    // Screens sit on the map, not the strip.
    expect(r.screen.left - r.edge.left).toBeCloseTo(0, 0)
  }
})

test('$105: the back color is solid across the map and fades to transparent over each gutter', async ({
  page,
}) => {
  await openMap(page, 0x105)
  await click(page, 0x105, 'zoom-actual')
  await page.waitForTimeout(400)
  const r = await rects(page, 0x105)
  // The back area spans the whole strip, so the gradient's outer stops are the gutters' outer edges.
  expect(r.backArea.w).toBeCloseTo(r.strip.w, 0)
  expect(r.backArea.h).toBeCloseTo(r.strip.h, 0)
  const image = await page.evaluate(
    sel =>
      getComputedStyle(document.querySelector(`${sel} [data-layer="back-area"]`)).backgroundImage,
    root(0x105),
  )
  expect(image).toMatch(
    /^linear-gradient\(to right, rgba\(0, 0, 0, 0\)(?: 0%)?, rgb\(\d+, \d+, \d+\)/,
  )
  expect(image).toMatch(/rgba\(0, 0, 0, 0\)(?: 100%)?\)$/)
  // Solid at the map edge on both sides: the two opaque stops sit at the gutter widths.
  expect(image).toContain('128px')
})

test('$109: a vertical map is untouched: no gutter, no edge line, no off-map canvas, no style, a solid back', async ({
  page,
}) => {
  await openMap(page, 0x109)
  await spritesLanded(page, 0x109)
  await click(page, 0x109, 'zoom-actual')
  await page.waitForTimeout(400)
  const r = await rects(page, 0x109)
  const zoom = r.screen.w / 512
  expect(r.strip.w).toBeCloseTo(512 * zoom, 0)
  expect(r.strip.h).toBeCloseTo(r.screens * 256 * zoom, 0)
  await expect(page.locator(`${root(0x109)} [data-control="map-edge"]`)).toHaveCount(0)
  await expect(page.locator(`${root(0x109)} [data-layer="off-map-sprites"]`)).toHaveCount(0)
  await expect(page.locator(`${root(0x109)} .hb-map-view-strip`)).not.toHaveAttribute('style', /./)
  const image = await page.evaluate(
    sel =>
      getComputedStyle(document.querySelector(`${sel} [data-layer="back-area"]`)).backgroundImage,
    root(0x109),
  )
  expect(image).toBe('none')
})

test('$C4 (ghost house): door pixels sit in the left gutter at x -8..-1; the EXIT sign is inside the map near y 287', async ({
  page,
}) => {
  const mp = await openMap(page, 0xc4)
  await spritesLanded(page, 0xc4)
  await expect(page.locator(`${root(0xc4)} canvas[data-layer="off-map-sprites"]`)).toHaveCount(1)
  const px = await gutterPixels(page, 0xc4)
  expect(px.left).toBeGreaterThan(0)
  expect(px.minX).toBeGreaterThanOrEqual(-8)
  expect(px.maxX).toBeLessThan(0)
  // The off-map canvas never holds a map pixel (the screens draw those): nothing in the map region.
  expect(px.map).toBe(0)
  // The sign: a sprite whose box starts inside the map and covers y 287 (the real reply, the same data the view draws).
  const sprites = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp, index: 0xc4 },
  )
  expect(sprites.status).toBe('ok')
  expect(sprites.sprites.some(s => s.box.x0 >= 0 && s.box.y0 <= 287 && s.box.y1 > 287)).toBe(true)
  expect(sprites.sprites.some(s => s.box.x0 < 0 && s.box.y0 >= 280 && s.box.y1 <= 390)).toBe(true)
  // And the canvas box: map plus both gutters wide, the map's height tall, starting 128 px before the edge.
  const r = await rects(page, 0xc4)
  const c = await page.evaluate(sel => {
    const b = document.querySelector(`${sel} canvas[data-layer="off-map-sprites"]`).getBoundingClientRect() // prettier-ignore
    return { left: b.left, top: b.top, w: b.width, h: b.height }
  }, root(0xc4))
  expect(c.w).toBeCloseTo(r.strip.w, 0)
  expect(c.h).toBeCloseTo(r.strip.h, 0)
  expect(r.edge.left - c.left).toBeCloseTo(GUTTER * (c.w / px.cw), 0)
})

test('$DD: platform pixels land in the left gutter', async ({ page }) => {
  await openMap(page, 0xdd)
  await spritesLanded(page, 0xdd)
  await expect(page.locator(`${root(0xdd)} canvas[data-layer="off-map-sprites"]`)).toHaveCount(1)
  const px = await gutterPixels(page, 0xdd)
  expect(px.left).toBeGreaterThan(0)
  expect(px.minX).toBeGreaterThanOrEqual(-GUTTER)
  expect(px.map).toBe(0)
})

test('marks injected in the gutter draw at their raw tile, outside the map rect, with their tooltip', async ({
  page,
}) => {
  const cs = [cell(-8, 5, 1), cell(-1, 6, 2), cell(7, 9, 3)]
  await openMap(page, 0x105, { cells: cs })
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(3, { timeout: 30000 }) // prettier-ignore
  const n = (await rects(page, 0x105)).screens
  // Two more past the end, read once the screen count is known: the first and last gutter tiles.
  const more = [cell(n * 16, 5, 4), cell(n * 16 + 7, 6, 5)]
  await page.evaluate(
    async ({ cells }) => {
      window.__hbRefused = cells
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: 0x105 }) // prettier-ignore
      w.refresh()
    },
    { cells: [...cs, ...more] },
  )
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(5, { timeout: 30000 }) // prettier-ignore
  for (const step of ['zoom-actual', 'zoom-in']) {
    await click(page, 0x105, step)
    await page.waitForTimeout(400)
    const r = await rects(page, 0x105)
    const zoom = r.screen.w / 256
    for (const [i, c] of [...cs, ...more].entries()) {
      expect(r.marks[i].left - r.edge.left).toBeCloseTo(c.x * 16 * zoom, 0)
      expect(r.marks[i].top - r.edge.top).toBeCloseTo(c.y * 16 * zoom, 0)
    }
    // The first two are left of the map, the next two right of it, the last inside.
    expect(r.marks[0].right).toBeLessThanOrEqual(r.edge.left + 1)
    expect(r.marks[1].right).toBeLessThanOrEqual(r.edge.left + 1)
    expect(r.marks[3].left).toBeGreaterThanOrEqual(r.edge.right - 1)
    expect(r.marks[4].left).toBeGreaterThanOrEqual(r.edge.right - 1)
    expect(r.marks[2].left).toBeGreaterThanOrEqual(r.edge.left)
    // And inside the strip: the outermost gutter tile does not poke past the canvas.
    expect(r.marks[0].left).toBeGreaterThanOrEqual(r.strip.left - 1)
    expect(r.marks[4].right).toBeLessThanOrEqual(r.strip.right + 1)
  }
  await expect(
    page.locator(`${root(0x105)} [data-control="refused-cell"][data-object="1"] title`),
  ).toHaveText(`Object 1 (type 9): ${WHY}`)
  expect(pageErrors).toEqual([])
})

test('hover inside the map is offset by the gutter, and the gutter and the strip ends do not throw', async ({
  page,
}) => {
  // The item block is at map px (32, 48); the strip starts 128 px before the map.
  await openMap(page, 0x105, { block: { x: 32, y: 48 } })
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
  // The same offset from the STRIP's origin is 128 px short of it (in the gutter): nothing there.
  await page.mouse.move(r.strip.left + 40 * zoom, r.strip.top + 56 * zoom)
  await expect.poll(hover, { timeout: 10000 }).toBeNull()
  await page.mouse.move(r.strip.left + 2, r.strip.top + 2)
  await page.mouse.move(r.strip.right - 2, r.strip.bottom - 2)
  expect(await hover()).toBeNull()
  expect(pageErrors).toEqual([])
})

test('the grid runs across the gutters of a horizontal map', async ({ page }) => {
  await openMap(page, 0x102)
  await click(page, 0x102, 'zoom-actual')
  await page.locator(gridToggle(0x102)).click()
  // The map view's own grid canvas (scoped to this view: another view's grid canvas also carries the class).
  const grid = page.locator(`${root(0x102)} canvas.hb-grid-overlay`)
  await expect(grid).toHaveCount(1, { timeout: 15000 })
  await page.waitForTimeout(500)
  const lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  const xs = lines.x.map(l => l.pos)
  // Scrolled to 0 the left gutter is in view: tile lines at 0, 16 ... 112, then the map's screen line at 128.
  expect(xs.filter(p => p < GUTTER).length).toBeGreaterThanOrEqual(GUTTER / 16 - 1)
  expect(lines.x.find(l => l.pos === GUTTER).weight).toBe(5)
})

/**
 * Pixel-identical check against develop for the vertical map: a fingerprint of the strip's DOM shape and
 * every screen's composite pixels at Fit. Written on develop, compared on the branch.
 */
test('$109: vertical strip fingerprint matches the recorded develop baseline', async ({ page }) => {
  test.skip(!process.env.HB_BASELINE_DIR, 'HB_BASELINE_DIR not set')
  const index = 0x109
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
