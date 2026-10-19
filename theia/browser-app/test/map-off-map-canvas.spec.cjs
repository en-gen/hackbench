/**
 * The map view's canvas around the map, en-gen/hackbench#1004. Owner rulings: D76 call 2 ("draw it off the
 * map where the game indicates it is drawn. the canvas can and should extend beyond the map bounds"), D48
 * part 2 ("half a screen width of gutter on each end with ui to add a screen. The background should fade in
 * a gradient to the edges") and D145 ("no matter what. the user needs ways to extend the size of the map").
 *
 * Every map has a 128 px gutter at each LONG end (left and right of a horizontal map, top and bottom of a
 * vertical one), none on the short sides. Content the data places off the map (a sprite, a refused-object
 * mark) is never clamped: the canvas grows to hold it, rounded up to whole 16 px tiles, and on a long end the
 * gutter sits BEYOND it. The back color is solid across the map and fades to transparent over the gutter only.
 *
 * Injection uses the RPC intercept pattern (docs/testing.md "Playwright and RPC"; the widget's own
 * `projects` swapped for a Proxy, as map-refused-cells.spec.cjs does).
 *
 * Planted-offset sanity for the verifier: drop `- pad.left` in updateHover, drop `+ pad.top` from the sprite
 * anchor, write `(y + pad.top) * w + x` without `+ pad.left` in offMapSpritePixels, or make the back area a
 * solid color; the hover, canvas-pixel, click and fade assertions below must go red.
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

const G = 128
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
 * one l1High indicator there. Every mapSprites reply gets the boxes in `window.__hbExtra` appended as opaque
 * 16 px-wide sprites (index 900 up), so a test can add off-map or in-map sprites, before or after opening.
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
      window.__hbExtra = window.__hbExtra ?? []
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
          if (k === 'mapSprites')
            return async (...a) => {
              const r = await t.mapSprites(...a)
              if (r.status !== 'ok' || !window.__hbExtra.length) return r
              const extra = window.__hbExtra.map((box, i) => {
                const n = (box.x1 - box.x0) * (box.y1 - box.y0) * 4
                const rgba = btoa(String.fromCharCode(...new Uint8Array(n).fill(255)))
                return { index: 900 + i, id: 1, x: box.x0, y: box.y0, box, rgba, status: 'drawn' }
              })
              return { ...r, sprites: [...r.sprites, ...extra] }
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

/** Runs `fn(widget)` in the page against the open map's widget. */
const inWidget = (page, index, fn, arg) =>
  page.evaluate(
    async ({ i, src, arg }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i })
      return new Function('w', 'arg', `return (${src})(w, arg)`)(w, arg)
    },
    { i: index, src: fn.toString(), arg },
  )

/** Waits until the widget has taken its sprites reply, so a late pad cannot race an assertion. */
const spritesLanded = (page, index) =>
  expect.poll(() => inWidget(page, index, w => w.spritesVersion > 0 && !!w.sprites), { timeout: 30000 }).toBe(true) // prettier-ignore

/** Rects in client px: the strip, the scroller, the map's edge element, the back area, one screen, the marks. */
const rects = (page, index) =>
  page.evaluate(sel => {
    const r = e => {
      if (!e) return null
      const b = e.getBoundingClientRect()
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }
    }
    return {
      strip: r(document.querySelector(`${sel} .hb-map-view-strip`)),
      scroller: r(document.querySelector(`${sel} [data-control="map-scroller"]`)),
      edge: r(document.querySelector(`${sel} [data-control="map-edge"]`)),
      backArea: r(document.querySelector(`${sel} [data-layer="back-area"]`)),
      screen: r(document.querySelector(`${sel} .hb-map-view-screen`)),
      screens: document.querySelectorAll(`${sel} .hb-map-view-screen`).length,
      marks: [...document.querySelectorAll(`${sel} [data-control="refused-cell"] rect`)].map(r),
      collision: r(document.querySelector(`${sel} [data-control="collision-overlay"]`)),
    }
  }, root(index))

const click = (page, index, control) =>
  page.locator(`${root(index)} [data-control="${control}"]`).click()

/** Zoom, then scroll to the start so the leading pad is in view (Actual keeps the view centre). */
const zoomAt = async (page, index, control) => {
  await click(page, index, control)
  await page.waitForTimeout(400)
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollLeft = 0
    s.scrollTop = 0
  }, root(index))
  await page.waitForTimeout(300)
}

/** The strip's pad on each side in map px, given the zoom. */
const pads = (r, zoom) => ({
  left: (r.edge.left - r.strip.left) / zoom,
  top: (r.edge.top - r.strip.top) / zoom,
  right: (r.strip.right - r.edge.right) / zoom,
  bottom: (r.strip.bottom - r.edge.bottom) / zoom,
})

const expectPad = (got, want) => {
  for (const k of ['left', 'top', 'right', 'bottom']) expect(got[k], k).toBeCloseTo(want[k], 0)
}

/**
 * The off-map canvas's opaque pixels, in MAP pixels: counts by region (left of the map, over it, right of it,
 * above, below) and the x and y range of those left of the map.
 */
const canvasPixels = (page, index) =>
  page.evaluate(sel => {
    const c = document.querySelector(`${sel} canvas[data-layer="off-map-sprites"]`)
    if (!c) return null
    const edge = document.querySelector(`${sel} [data-control="map-edge"]`).getBoundingClientRect()
    const box = c.getBoundingClientRect()
    const zoom = box.width / c.width
    const [padL, padT] = [
      Math.round((edge.left - box.left) / zoom),
      Math.round((edge.top - box.top) / zoom),
    ]
    const [mapW, mapH] = [Math.round(edge.width / zoom), Math.round(edge.height / zoom)]
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const out = { left: 0, right: 0, above: 0, below: 0, map: 0, minX: 1e9, maxX: -1e9, padL, padT, cw: c.width, ch: c.height } // prettier-ignore
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] === 0) continue
        const [mx, my] = [x - padL, y - padT]
        if (mx >= 0 && mx < mapW && my >= 0 && my < mapH) out.map++
        else if (mx < 0) {
          out.left++
          out.minX = Math.min(out.minX, mx)
          out.maxX = Math.max(out.maxX, mx)
        } else if (mx >= mapW) out.right++
        else if (my < 0) out.above++
        else out.below++
      }
    return out
  }, root(index))

// $105 is horizontal (256 x 432 px screens), $109 vertical (512 x 256): map-refused-cells.spec.cjs.
test('$105: a horizontal map has a 128 px gutter left and right and none above or below, at two zooms', async ({
  page,
}) => {
  await openMap(page, 0x105)
  await spritesLanded(page, 0x105)
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x105, step)
    const r = await rects(page, 0x105)
    const zoom = r.screen.w / 256
    expectPad(pads(r, zoom), { left: G, top: 0, right: G, bottom: 0 })
    expect(r.strip.w).toBeCloseTo((r.screens * 256 + 2 * G) * zoom, 0)
    expect(r.strip.h).toBeCloseTo(432 * zoom, 0)
    expect(r.screen.left - r.edge.left).toBeCloseTo(0, 0)
  }
})

test('$109: a vertical map has a 128 px gutter above and below and none at the sides', async ({
  page,
}) => {
  await openMap(page, 0x109)
  await spritesLanded(page, 0x109)
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x109, step)
    const r = await rects(page, 0x109)
    const zoom = r.screen.w / 512
    expectPad(pads(r, zoom), { left: 0, top: G, right: 0, bottom: G })
    expect(r.strip.w).toBeCloseTo(512 * zoom, 0)
    expect(r.strip.h).toBeCloseTo((r.screens * 256 + 2 * G) * zoom, 0)
  }
})

for (const { index, screenW, vertical } of [
  { index: 0x105, screenW: 256, vertical: false },
  { index: 0x109, screenW: 512, vertical: true },
]) {
  test(`$${index.toString(16)}: the back color is solid across the map and fades to transparent over the gutter only, at two zooms`, async ({
    page,
  }) => {
    await openMap(page, index)
    await spritesLanded(page, index)
    const back = await inWidget(page, index, w => `rgb(${w.mapLayout.backdrop.join(', ')})`)
    for (const step of ['zoom-actual', 'zoom-in']) {
      await zoomAt(page, index, step)
      const r = await rects(page, index)
      const zoom = r.screen.w / screenW
      // The back area spans the whole strip, so the gradient's outer stops are the gutters' outer edges.
      expect(r.backArea.w).toBeCloseTo(r.strip.w, 0)
      expect(r.backArea.h).toBeCloseTo(r.strip.h, 0)
      const image = await page.evaluate(
        sel =>
          getComputedStyle(document.querySelector(`${sel} [data-layer="back-area"]`))
            .backgroundImage,
        root(index),
      )
      expect(image.startsWith(`linear-gradient(${vertical ? 'to bottom' : 'to right'}, rgba(0, 0, 0, 0)`)).toBe(true) // prettier-ignore
      // Both opaque stops are the back color, one gutter in from each end (the computed value rounds the zoom).
      expect(image.split(back).length - 1).toBe(2)
      expect(image).toMatch(new RegExp(`${back.replace(/[()]/g, '\\$&')} ${(G * zoom).toFixed(0)}(\\.\\d+)?px`)) // prettier-ignore
      expect(image).toMatch(/calc\(100% - \d+(\.\d+)?px\)/)
      expect(image).toMatch(/rgba\(0, 0, 0, 0\)\)$/)
    }
  })
}

test('$C4 (ghost house): the left pad is the door (8 px, one tile) plus the gutter; $8D is the only sprite and sits at its door', async ({
  page,
}) => {
  const mp = await openMap(page, 0xc4)
  await spritesLanded(page, 0xc4)
  const sprites = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp, index: 0xc4 },
  )
  expect(sprites.status).toBe('ok')
  expect(sprites.sprites).toHaveLength(1)
  expect(sprites.sprites[0].id).toBe(0x8d)
  expect(sprites.sprites[0].box).toEqual({ x0: -8, y0: 287, x1: 56, y1: 383 })
  await zoomAt(page, 0xc4, 'zoom-actual')
  const r = await rects(page, 0xc4)
  const zoom = r.screen.w / 256
  expectPad(pads(r, zoom), { left: 16 + G, top: 0, right: G, bottom: 0 })
  const px = await canvasPixels(page, 0xc4)
  expect(px.left).toBeGreaterThan(0)
  expect(px.minX).toBeGreaterThanOrEqual(-8)
  expect(px.maxX).toBeLessThan(0)
  // Nothing above, below or over the map: the screens draw the map's own pixels.
  expect([px.above, px.below, px.right, px.map]).toEqual([0, 0, 0, 0])
  expect(px.padL).toBe(16 + G)
})

test('$DD: platform pixels land in the left pad, which is 8 px (one tile) plus the gutter', async ({
  page,
}) => {
  await openMap(page, 0xdd)
  await spritesLanded(page, 0xdd)
  await zoomAt(page, 0xdd, 'zoom-actual')
  const r = await rects(page, 0xdd)
  const zoom = r.screen.w / 256
  expectPad(pads(r, zoom), { left: 16 + G, top: 0, right: G, bottom: 0 })
  const px = await canvasPixels(page, 0xdd)
  expect(px.left).toBeGreaterThan(0)
  expect(px.minX).toBeGreaterThanOrEqual(-8)
  expect(px.map).toBe(0)
})

test('$102: sprites below the map grow the bottom by 48 px and there is no gutter below', async ({
  page,
}) => {
  await openMap(page, 0x102)
  await spritesLanded(page, 0x102)
  await zoomAt(page, 0x102, 'zoom-actual')
  const r = await rects(page, 0x102)
  const zoom = r.screen.w / 256
  expectPad(pads(r, zoom), { left: G, top: 0, right: G, bottom: 48 })
  const px = await canvasPixels(page, 0x102)
  expect(px.below).toBeGreaterThan(0)
  expect(px.above).toBe(0)
})

test('marks far past the end draw raw, in a canvas grown to hold them with the gutter beyond', async ({
  page,
}) => {
  await openMap(page, 0x105, { cells: [cell(1, 1, 1)] })
  const n = (await rects(page, 0x105)).screens
  // 30 tiles left of the map, 40 tiles past its end, and one inside as the control.
  const cs = [cell(-30, 5, 1), cell(n * 16 + 40, 6, 2), cell(7, 9, 3)]
  await page.evaluate(async cells => {
    window.__hbRefused = cells
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', {
      index: 0x105,
    })
    w.refresh()
  }, cs)
  await expect(page.locator(`${root(0x105)} [data-control="refused-cell"]`)).toHaveCount(3, { timeout: 30000 }) // prettier-ignore
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x105, step)
    const r = await rects(page, 0x105)
    const zoom = r.screen.w / 256
    for (const [i, c] of cs.entries()) {
      expect(r.marks[i].left - r.edge.left).toBeCloseTo(c.x * 16 * zoom, 0)
      expect(r.marks[i].top - r.edge.top).toBeCloseTo(c.y * 16 * zoom, 0)
    }
    // 30 tiles of overflow left (480) and 41 tiles right (656), each with the gutter beyond.
    expectPad(pads(r, zoom), { left: 480 + G, top: 0, right: 656 + G, bottom: 0 })
    expect(r.marks[0].left).toBeGreaterThanOrEqual(r.strip.left + G * zoom - 1)
    expect(r.marks[1].right).toBeLessThanOrEqual(r.strip.right - G * zoom + 1)
  }
  await expect(
    page.locator(`${root(0x105)} [data-control="refused-cell"][data-object="1"] title`),
  ).toHaveText(`Object 1 (type 9): ${WHY}`)
  expect(pageErrors).toEqual([])
})

test('the collision overlay starts at the map edge, not the strip corner, at two zooms', async ({
  page,
}) => {
  await openMap(page, 0x105)
  await spritesLanded(page, 0x105)
  await click(page, 0x105, 'collision-toggle')
  await expect(page.locator(`${root(0x105)} [data-control="collision-overlay"]`)).toHaveCount(1, { timeout: 90000 }) // prettier-ignore
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x105, step)
    const r = await rects(page, 0x105)
    expect(r.collision.left - r.edge.left).toBeCloseTo(0, 0)
    expect(r.collision.top - r.edge.top).toBeCloseTo(0, 0)
  }
})

test('hover and click at the pad offset hit the right tile and sprite, and the margin does not throw', async ({
  page,
}) => {
  // An item block at map px (32, 48) and an opaque 16 x 16 sprite at (64, 100).
  await page.evaluate(() => (window.__hbExtra = [{ x0: 64, y0: 100, x1: 80, y1: 116 }]))
  await openMap(page, 0x105, { block: { x: 32, y: 48 } })
  await spritesLanded(page, 0x105)
  await zoomAt(page, 0x105, 'zoom-actual')
  const r = await rects(page, 0x105)
  const zoom = r.screen.w / 256
  const hoverBlock = () => inWidget(page, 0x105, w => (w.hover ? [w.hover.x, w.hover.y] : null))
  const hoverSprite = () => inWidget(page, 0x105, w => w.hoverSprite?.index ?? null)
  // Over the block, measured from the MAP's origin: found. From the STRIP's origin it is 128 px short.
  await page.mouse.move(r.edge.left + 40 * zoom, r.edge.top + 56 * zoom)
  await expect.poll(hoverBlock, { timeout: 10000 }).toEqual([32, 48])
  await page.mouse.move(r.strip.left + 40 * zoom, r.strip.top + 56 * zoom)
  await expect.poll(hoverBlock, { timeout: 10000 }).toBeNull()
  // Over the sprite: hovered, then clicked and selected; the strip-origin point selects nothing.
  await page.mouse.move(r.edge.left + 72 * zoom, r.edge.top + 108 * zoom)
  await expect.poll(hoverSprite, { timeout: 10000 }).toBe(900)
  await page.mouse.click(r.edge.left + 72 * zoom, r.edge.top + 108 * zoom)
  await expect.poll(() => inWidget(page, 0x105, w => w.selectedSprite?.index ?? null)).toBe(900)
  await page.mouse.click(r.strip.left + 72 * zoom, r.strip.top + 108 * zoom)
  await expect.poll(() => inWidget(page, 0x105, w => w.selectedSprite?.index ?? null)).toBeNull()
  // The ends of the strip and the gutter: no throw, no hit.
  await page.mouse.move(r.strip.left + 2, r.strip.top + 2)
  await page.mouse.move(r.strip.right - 2, r.strip.bottom - 2)
  expect(await hoverSprite()).toBeNull()
  expect(await hoverBlock()).toBeNull()
  expect(pageErrors).toEqual([])
})

test('the grid runs across the gutters and the growth band', async ({ page }) => {
  await openMap(page, 0x102)
  await spritesLanded(page, 0x102)
  await zoomAt(page, 0x102, 'zoom-actual')
  await page.locator(`${root(0x102)} [data-control="grid-toggle"]`).click()
  // The map view's own grid canvas (scoped to this view: another view's grid canvas also carries the class).
  const grid = page.locator(`${root(0x102)} canvas.hb-grid-overlay`)
  await expect(grid).toHaveCount(1, { timeout: 15000 })
  await page.waitForTimeout(500)
  let lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  // Scrolled to 0 the left gutter is in view: tile lines at 0, 16 ... 112, then the map's screen line at 128.
  expect(lines.x.filter(l => l.pos < G).length).toBeGreaterThanOrEqual(G / 16 - 1)
  expect(lines.x.find(l => l.pos === G).weight).toBe(5)
  // The bottom growth band (48 px below the map) has lines too, once scrolled to it.
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollTop = s.scrollHeight
  }, root(0x102))
  await page.waitForTimeout(500)
  lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  expect(Math.max(...lines.y.map(l => l.pos))).toBeGreaterThan(432)
})

test('in Fit, a sprites reply that adds a top and left pad refits and holds the map pixel under the view center', async ({
  page,
}) => {
  // Stays in Fit, so the refit changes the zoom: only an absolute restore (not a relative nudge) holds the pixel.
  await openMap(page, 0x105)
  await spritesLanded(page, 0x105)
  await click(page, 0x105, 'zoom-fit')
  await page.waitForTimeout(500)
  const point = () =>
    page.evaluate(sel => {
      const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
      const cx = s.getBoundingClientRect().left + s.clientWidth / 2
      const origin = document.querySelector(`${sel} [data-control="map-edge"]`).getBoundingClientRect() // prettier-ignore
      const zoom = document.querySelector(`${sel} .hb-map-view-screen`).getBoundingClientRect().width / 256 // prettier-ignore
      return { mapX: (cx - origin.left) / zoom, zoom, left: s.scrollLeft, wide: s.scrollWidth - s.clientWidth } // prettier-ignore
    }, root(0x105))
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollLeft = Math.floor((s.scrollWidth - s.clientWidth) / 2)
  }, root(0x105))
  await page.waitForTimeout(400)
  const before = await point()
  expect(before.wide).toBeGreaterThan(100)
  expect(before.left).toBeGreaterThan(0)
  // 40 px above and left of the map: the left pad goes from 128 to 176 and a 48 px top pad appears.
  await page.evaluate(async () => {
    window.__hbExtra = [{ x0: -40, y0: -40, x1: -24, y1: -24 }]
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', {
      index: 0x105,
    })
    await w.loadSprites()
  })
  await expect.poll(async () => (await rects(page, 0x105)).strip.h > 0).toBe(true)
  await page.waitForTimeout(1000)
  const after = await point()
  await expect(page.locator(`${root(0x105)} [data-control="zoom-fit"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
  // The 48 px top pad shrinks the fit zoom; the pixel still sits under the center.
  expect(after.zoom).toBeLessThan(before.zoom * 0.95)
  expect(Math.abs(after.mapX - before.mapX) * after.zoom).toBeLessThanOrEqual(1)
})
