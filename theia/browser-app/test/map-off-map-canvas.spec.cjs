/**
 * The map view's canvas around the map, en-gen/hackbench#1004. Owner rulings: D76 call 2 ("draw it off the
 * map where the game indicates it is drawn. the canvas can and should extend beyond the map bounds"), D48
 * part 2 ("half a screen width of gutter on each end with ui to add a screen. The background should fade in
 * a gradient to the edges", replaced since #1228) and D145 ("no matter what. the user needs ways to extend the size of the map").
 *
 * #1228 (owner, 2026-11-04) replaced the left half of D48 part 2 and R24: every map has ONE 256 px gutter (a
 * screen) at its FAR end only (right of a horizontal map, bottom of a vertical one), none before position 0 and
 * none on the short sides, and none at all on a 32-screen map (map-far-end-gutter.spec.cjs, synthetic maps).
 * Content the data places off the map (a sprite, a refused-object mark) is never clamped: the canvas grows to
 * hold it, rounded up to whole 16 px tiles, and at the far end the gutter sits BEYOND it. The back color is
 * solid from the near edge and fades to transparent over the far-end gutter only.
 *
 * Injection uses the RPC intercept pattern (docs/testing.md "Playwright and RPC"; the widget's own
 * `projects` swapped for a Proxy, as map-refused-cells.spec.cjs does).
 *
 * #1325 (owner, 2026-11-07) narrowed the content rule: only what the data PLACES off the map grows the canvas
 * (a refused-object cell, a sprite's placement cell). Art that spills past an edge from a placement on the map
 * is cut there and grows nothing; map-sprite-art-past-edge.spec.cjs holds the behaviour, and the cases below that
 * grow the canvas use sprites and cells placed off the map.
 *
 * Planted-offset sanity for the verifier (each should turn the named cases red): drop `- pad.left` or
 * `- pad.top` in updateHover (hover, on $105 and $109), drop `+ pad.top` from the sprite anchor (the anchor
 * case on $109), write `(y + pad.top) * w + x` without `+ pad.left` in offMapSpritePixels (no case here:
 * since #1325 no vanilla map has a left pad, so only OffMapExtent.test.ts, "placed off each of the 4 sides",
 * reads a left-pad pixel), make the back area a solid color (the fade case), or request screens outside the
 * map in visibleScreens (any case would then show a screen error).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const nodeCrypto = require('crypto')
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

const G = 256
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

const cell = (x, y, n) => ({ x, y, objectIndex: n, objectType: 'type 9', handler: 0x0dfff0, reasons: [WHY] }) // prettier-ignore

/**
 * Opens the map and returns its project's manifest path. `cells` replaces every mapScreen reply's
 * refusedCells (undefined leaves the real reply); `block` ({x, y}, map px) replaces mapBlockContents with
 * one l1High indicator there. Every mapSprites reply gets the boxes in `window.__hbExtra` appended as opaque
 * sprites the size of the box (index 900 up), so a test can add off-map or in-map sprites, before or after opening.
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
                return { index: 900 + i, id: 1, name: 'Test sprite', x: box.x0, y: box.y0, box, rgba, status: 'drawn' } // prettier-ignore
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
      checker: r(document.querySelector(`${sel} [data-layer="checkerboard"]`)),
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
 * above, below), the x and y range of those left of the map, and the lowest opaque y (`maxY`, anywhere).
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
    // A pixel whose 8 neighbors are all opaque: a pointer rounded to a whole pixel still lands on the sprite.
    const solid = (d, w, x, y) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (d[((y + dy) * w + x + dx) * 4 + 3] === 0) return false
      return true
    }
    const out = { left: 0, right: 0, above: 0, below: 0, map: 0, minX: 1e9, maxX: -1e9, maxY: -1e9, first: null, inner: null, padL, padT, cw: c.width, ch: c.height } // prettier-ignore
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        if (data[(y * c.width + x) * 4 + 3] === 0) continue
        const [mx, my] = [x - padL, y - padT]
        out.maxY = Math.max(out.maxY, my)
        if (mx >= 0 && mx < mapW && my >= 0 && my < mapH) out.map++
        else if (mx < 0) {
          out.left++
          out.first ??= { x: mx, y: my }
          out.inner ??= solid(data, c.width, x, y) && mx >= out.minX + 2 ? { x: mx, y: my } : null
          out.minX = Math.min(out.minX, mx)
          out.maxX = Math.max(out.maxX, mx)
        } else if (mx >= mapW) out.right++
        else if (my < 0) out.above++
        else out.below++
      }
    return out
  }, root(index))

// $105 is horizontal (256 x 432 px screens), $109 vertical (512 x 256): map-refused-cells.spec.cjs.
test('$105: a horizontal map has a 256 px gutter on the right only and none left, above or below, at two zooms', async ({
  page,
}) => {
  await openMap(page, 0x105)
  await spritesLanded(page, 0x105)
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x105, step)
    const r = await rects(page, 0x105)
    const zoom = r.screen.w / 256
    expectPad(pads(r, zoom), { left: 0, top: 0, right: G, bottom: 0 })
    expect(r.strip.w).toBeCloseTo((r.screens * 256 + G) * zoom, 0)
    expect(r.strip.h).toBeCloseTo(432 * zoom, 0)
    expect(r.screen.left - r.edge.left).toBeCloseTo(0, 0)
    // The checkerboard reaches the left edge and stops at the gutter, so the fade runs over the panel behind the strip.
    expect(r.checker.left - r.strip.left).toBeCloseTo(0, 0)
    expect(r.strip.right - r.checker.right).toBeCloseTo(G * zoom, 0)
  }
})

test('$109: a vertical map has a 256 px gutter below only and none above or at the sides', async ({
  page,
}) => {
  await openMap(page, 0x109)
  await spritesLanded(page, 0x109)
  for (const step of ['zoom-actual', 'zoom-in']) {
    await zoomAt(page, 0x109, step)
    const r = await rects(page, 0x109)
    const zoom = r.screen.w / 512
    expectPad(pads(r, zoom), { left: 0, top: 0, right: 0, bottom: G })
    expect(r.strip.w).toBeCloseTo(512 * zoom, 0)
    expect(r.strip.h).toBeCloseTo((r.screens * 256 + G) * zoom, 0)
  }
})

for (const { index, screenW, vertical } of [
  { index: 0x105, screenW: 256, vertical: false },
  { index: 0x109, screenW: 512, vertical: true },
]) {
  test(`$${index.toString(16)}: the back color is solid from the near edge and fades to transparent over the far-end gutter only, at two zooms`, async ({
    page,
  }) => {
    await openMap(page, index)
    await spritesLanded(page, index)
    const back = await inWidget(page, index, w => `rgb(${w.mapLayout.backdrop.join(', ')})`)
    for (const step of ['zoom-actual', 'zoom-in']) {
      await zoomAt(page, index, step)
      const r = await rects(page, index)
      const zoom = r.screen.w / screenW
      // The back area spans the whole strip, so the gradient's far stop is the gutter's outer edge.
      expect(r.backArea.w).toBeCloseTo(r.strip.w, 0)
      expect(r.backArea.h).toBeCloseTo(r.strip.h, 0)
      // The back area's own background-color is the map's back color (what tests and tools read); the fade is a
      // mask, opaque from the near edge and fading over the far-end gutter only. Polled: the style lands with the render.
      const style = () =>
        page.evaluate(sel => {
          const cs = getComputedStyle(document.querySelector(`${sel} [data-layer="back-area"]`))
          return { color: cs.backgroundColor, mask: cs.maskImage || cs.webkitMaskImage || '' }
        }, root(index))
      await expect.poll(async () => (await style()).color, { timeout: 10000 }).toBe(back)
      const { mask } = await style()
      // Chromium drops the default direction ("to bottom") when it serializes the vertical gradient.
      const dir = vertical ? '(?:to bottom, )?' : 'to right, '
      expect(mask).toMatch(new RegExp(`^linear-gradient\\(${dir}rgb\\(0, 0, 0\\)`))
      // The one transparent stop is the far end; the opaque stop sits one gutter in from it (the computed value keeps the zoom's fraction).
      const g = String(Math.round(G * zoom))
      expect(mask).toMatch(new RegExp(`rgb\\(0, 0, 0\\) calc\\(100% - ${g}(\\.\\d+)?px\\)`))
      expect(mask.match(/rgba\(0, 0, 0, 0\)/g)).toHaveLength(1)
      expect(mask).toMatch(/rgba\(0, 0, 0, 0\)(?: 100%)?\)$/)
    }
  })
}

// The ghost houses (sweep of the 488 vanilla maps, one machine): each has sprite $8D with its door 8 px left of
// the map. Its art is cut at the map's edge since #1325: no left pad. $C4 has a second sprite ($7B) inside the map.
for (const index of [0xc4, 0xeb, 0xf0, 0xfb, 0x1da, 0x1e6, 0x1e7, 0x1f9]) {
  test(`$${index.toString(16)} (ghost house): the door's art past the left edge adds no left pad (#1325); $8D is still the sprite there`, async ({
    page,
  }) => {
    const mp = await openMap(page, index)
    await spritesLanded(page, index)
    const sprites = await page.evaluate(
      ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
      { mp, index },
    )
    expect(sprites.status).toBe('ok')
    const door = sprites.sprites.filter(sp => sp.id === 0x8d)
    expect(door).toHaveLength(1)
    expect(door[0].box).toEqual({ x0: -8, y0: 287, x1: 56, y1: 383 })
    await zoomAt(page, index, 'zoom-actual')
    const r = await rects(page, index)
    const zoom = r.screen.w / 256
    expectPad(pads(r, zoom), { left: 0, top: 0, right: G, bottom: 0 })
    // Nothing outside the map on the sprite canvas: the screens draw the map's own pixels.
    const px = await canvasPixels(page, index)
    expect(px === null ? 0 : px.left + px.above + px.below + px.map).toBe(0)
  })
}

test('$C4: the door cut at the left edge still hovers and selects from the part left on the map', async ({
  page,
}) => {
  await openMap(page, 0xc4)
  await spritesLanded(page, 0xc4)
  await zoomAt(page, 0xc4, 'zoom-actual')
  // The door is 287 px down: scroll it to the middle of the view first, or the pointer lands off the page.
  await page.evaluate(sel => {
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    sc.scrollTop = Math.max(0, 335 - sc.clientHeight / 2)
    sc.scrollLeft = 0
  }, root(0xc4))
  await page.waitForTimeout(400)
  const r = await rects(page, 0xc4)
  const zoom = r.screen.w / 256
  const hovered = () => inWidget(page, 0xc4, w => w.hoverSprite?.id ?? null)
  // Any opaque door pixel on the map: scan its box (x 0-56, y 287-383) until the hover names the door.
  let found = null
  for (let y = 300; y < 380 && !found; y += 6)
    for (let x = 2; x < 54 && !found; x += 6) {
      await page.mouse.move(r.edge.left + (x + 0.5) * zoom, r.edge.top + (y + 0.5) * zoom)
      await page.waitForTimeout(40)
      if ((await hovered()) === 0x8d) found = { x, y }
    }
  expect(found, 'the hover finds the door on the map').not.toBeNull()
  await page.mouse.click(r.edge.left + (found.x + 0.5) * zoom, r.edge.top + (found.y + 0.5) * zoom)
  await expect.poll(() => inWidget(page, 0xc4, w => w.selectedSprite?.id ?? null)).toBe(0x8d)
})

test('$DD: platform art 8 px past the left edge is cut there: no left pad, no gutter', async ({
  page,
}) => {
  await openMap(page, 0xdd)
  await spritesLanded(page, 0xdd)
  await zoomAt(page, 0xdd, 'zoom-actual')
  const r = await rects(page, 0xdd)
  const zoom = r.screen.w / 256
  expectPad(pads(r, zoom), { left: 0, top: 0, right: G, bottom: 0 })
  const px = await canvasPixels(page, 0xdd)
  expect(px === null ? 0 : px.left + px.map).toBe(0)
})

// Map $102's old 24 px below the map was a sprite sinking in a retry loop (#842, #1119). Since #1325 the real Wooden
// Spike art ($1B, 16 px below the map: docs/sprites/sprite-ad-wooden-spike.md) is cut at the map's edge, so the band
// rests on a synthetic sprite PLACED on the first row below the map, its 24 px art cut at the one row's end.
const PLACED_BELOW = { x0: 64, y0: 432, x1: 96, y1: 456 }
const addPlacedBelow = page => page.evaluate(b => (window.__hbExtra = [b]), PLACED_BELOW)

test('$1B: the Wooden Spikes drawn 16 px below the map grow nothing (#1325): the canvas ends at the map', async ({
  page,
}) => {
  await openMap(page, 0x1b)
  await spritesLanded(page, 0x1b)
  await zoomAt(page, 0x1b, 'zoom-actual')
  const r = await rects(page, 0x1b)
  const zoom = r.screen.w / 256
  expect(r.edge.h / zoom).toBeCloseTo(432, 0)
  expectPad(pads(r, zoom), { left: 0, top: 0, right: G, bottom: 0 })
  const px = await canvasPixels(page, 0x1b)
  expect(px === null ? 0 : px.below).toBe(0)
})

test('$1B: a sprite PLACED below the map grows the bottom by its one cell (16, art cut there) and there is no gutter below', async ({
  page,
}) => {
  await addPlacedBelow(page)
  await openMap(page, 0x1b)
  await spritesLanded(page, 0x1b)
  await zoomAt(page, 0x1b, 'zoom-actual')
  const r = await rects(page, 0x1b)
  const zoom = r.screen.w / 256
  expect(r.edge.h / zoom).toBeCloseTo(432, 0)
  expectPad(pads(r, zoom), { left: 0, top: 0, right: G, bottom: 16 })
  const px = await canvasPixels(page, 0x1b)
  expect(px.below).toBeGreaterThan(0)
  // The art runs to y 455; the pad ends at 447.
  expect(px.maxY).toBeLessThan(448)
  expect(px.above).toBe(0)
})

test('$1B: Fit frames the map and the placed sprite row: the whole strip fits the view with no vertical scroll', async ({
  page,
}) => {
  await addPlacedBelow(page)
  await openMap(page, 0x1b)
  await spritesLanded(page, 0x1b)
  await click(page, 0x1b, 'zoom-fit')
  await page.waitForTimeout(600)
  const m = await page.evaluate(sel => {
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const strip = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
    return { clientH: sc.clientHeight, scrollH: sc.scrollHeight, stripH: strip.height }
  }, root(0x1b))
  expect(m.stripH).toBeLessThanOrEqual(m.clientH + 1)
  expect(m.scrollH).toBeLessThanOrEqual(m.clientH + 1)
  // Fit used the bottom row: 432 map px + 16 px, not 432 alone.
  const r = await rects(page, 0x1b)
  const zoom = r.screen.w / 256
  expect(r.strip.h / zoom).toBeCloseTo(432 + 16, 0)
})

test('marks far past the end draw raw, in a canvas grown to hold them with the far-end gutter beyond', async ({
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
    // 30 tiles of overflow left (480, no gutter) and 41 tiles right (656, the gutter beyond).
    expectPad(pads(r, zoom), { left: 480, top: 0, right: 656 + G, bottom: 0 })
    expect(r.marks[0].left).toBeGreaterThanOrEqual(r.strip.left - 1)
    expect(r.marks[1].right).toBeLessThanOrEqual(r.strip.right - G * zoom + 1)
  }
  await expect(
    page.locator(`${root(0x105)} [data-control="refused-cell"][data-object="1"] title`),
  ).toHaveText(`Object 1 (type 9)\n${WHY}`)
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

for (const { index, screenW, vertical } of [
  { index: 0x105, screenW: 256, vertical: false },
  { index: 0x109, screenW: 512, vertical: true },
]) {
  test(`$${index.toString(16)}: hover, click and the sprite anchor use the pad offset (32 px of content before the map)`, async ({
    page,
  }) => {
    // An item block at map px (32, 48), an opaque 16 x 16 sprite at (64, 100), and a second sprite 32 px before
    // the map (no gutter there since #1228, so this content is what makes the strip origin differ from the map's).
    const before = vertical
      ? { x0: 60, y0: -32, x1: 76, y1: -16 }
      : { x0: -32, y0: 60, x1: -16, y1: 76 }
    await page.evaluate(b => (window.__hbExtra = [{ x0: 64, y0: 100, x1: 80, y1: 116 }, b]), before)
    await openMap(page, index, { block: { x: 32, y: 48 } })
    await spritesLanded(page, index)
    await zoomAt(page, index, 'zoom-actual')
    const r = await rects(page, index)
    const zoom = r.screen.w / screenW
    const hoverBlock = () => inWidget(page, index, w => (w.hover ? [w.hover.x, w.hover.y] : null))
    const hoverSprite = () => inWidget(page, index, w => w.hoverSprite?.index ?? null)
    const selected = () => inWidget(page, index, w => w.selectedSprite?.index ?? null)
    // Over the block, measured from the MAP's origin: found. From the STRIP's origin it is the 32 px of content short.
    await page.mouse.move(r.edge.left + 40 * zoom, r.edge.top + 56 * zoom)
    await expect.poll(hoverBlock, { timeout: 10000 }).toEqual([32, 48])
    await page.mouse.move(r.strip.left + 40 * zoom, r.strip.top + 56 * zoom)
    await expect.poll(hoverBlock, { timeout: 10000 }).toBeNull()
    // Over the sprite: hovered, with its anchor box at the pad offset, then clicked and selected;
    // the strip-origin point selects nothing.
    await page.mouse.move(r.edge.left + 72 * zoom, r.edge.top + 108 * zoom)
    await expect.poll(hoverSprite, { timeout: 10000 }).toBe(900)
    const anchor = await page.evaluate(() => {
      const b = document.querySelector('.hb-map-sprite-anchor')?.getBoundingClientRect()
      return b && { left: b.left, top: b.top, w: b.width, h: b.height }
    })
    expect(anchor).not.toBeNull()
    expect(anchor.left - r.edge.left).toBeCloseTo(64 * zoom, 0)
    expect(anchor.top - r.edge.top).toBeCloseTo(100 * zoom, 0)
    expect(anchor.w).toBeCloseTo(16 * zoom, 0)
    await page.mouse.click(r.edge.left + 72 * zoom, r.edge.top + 108 * zoom)
    await expect.poll(selected).toBe(900)
    await page.mouse.click(r.strip.left + 72 * zoom, r.strip.top + 108 * zoom)
    await expect.poll(selected).toBeNull()
    // The ends of the strip and the pad: no throw, no hit.
    await page.mouse.move(r.strip.left + 2, r.strip.top + 2)
    await page.mouse.move(r.strip.right - 2, r.strip.bottom - 2)
    expect(await hoverSprite()).toBeNull()
    expect(await hoverBlock()).toBeNull()
    expect(pageErrors).toEqual([])
  })
}

test('the grid runs across the far-end gutter and the growth band', async ({ page }) => {
  await addPlacedBelow(page)
  await openMap(page, 0x1b)
  await spritesLanded(page, 0x1b)
  await zoomAt(page, 0x1b, 'zoom-actual')
  // The grid is on by default (#920): a click here would turn it off. Make sure of it, as map-view.spec.cjs does.
  const toggle = page.locator(`${root(0x1b)} [data-control="grid-toggle"]`)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  // The map view's own grid canvas (scoped to this view: another view's grid canvas also carries the class).
  const grid = page.locator(`${root(0x1b)} canvas.hb-grid-overlay`)
  await expect(grid).toHaveCount(1, { timeout: 15000 })
  await page.waitForTimeout(500)
  let lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  // Scrolled to 0 the map starts at the canvas edge: the map's first screen line is at 0, with no gutter before it.
  expect(lines.x.find(l => l.pos === 0).weight).toBe(5)
  // Scrolled to the end, tile lines run on across the far-end gutter, well past the map's last screen line.
  const screens = (await rects(page, 0x1b)).screens
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollLeft = s.scrollWidth
  }, root(0x1b))
  await page.waitForTimeout(500)
  lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  expect(Math.max(...lines.x.map(l => l.pos))).toBeGreaterThan(screens * 256 + G / 2)
  // The bottom growth band (16 px below the map) has lines too, once scrolled to it.
  await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    s.scrollTop = s.scrollHeight
  }, root(0x1b))
  await page.waitForTimeout(500)
  lines = JSON.parse(await grid.getAttribute('data-grid-lines'))
  expect(Math.max(...lines.y.map(l => l.pos))).toBeGreaterThan(432)
})

// A sprites reply that grows the pad under a scrolled view must keep the map pixel under the view center.
// Horizontal: the box adds a left pad (the scroll axis) and a top pad, so the fit zoom drops. Vertical: the box
// adds a top pad (the scroll axis) only, so the zoom stays and only the absolute restore can hold the pixel.
for (const { index, screenW, vertical, box } of [
  { index: 0x105, screenW: 256, vertical: false, box: { x0: -40, y0: -40, x1: -24, y1: -24 } },
  { index: 0x109, screenW: 512, vertical: true, box: { x0: 100, y0: -40, x1: 116, y1: -24 } },
]) {
  test(`$${index.toString(16)}: in Fit, a sprites reply that grows the leading pad holds the map pixel under the view center`, async ({
    page,
  }) => {
    await openMap(page, index)
    await spritesLanded(page, index)
    await click(page, index, 'zoom-fit')
    await page.waitForTimeout(500)
    const point = () =>
      page.evaluate(
        ({ sel, vertical, screenW }) => {
          const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
          const sr = s.getBoundingClientRect()
          const edge = document.querySelector(`${sel} [data-control="map-edge"]`).getBoundingClientRect() // prettier-ignore
          const zoom = document.querySelector(`${sel} .hb-map-view-screen`).getBoundingClientRect().width / screenW // prettier-ignore
          const at = vertical ? sr.top + s.clientHeight / 2 - edge.top : sr.left + s.clientWidth / 2 - edge.left // prettier-ignore
          return { map: at / zoom, zoom, scroll: vertical ? s.scrollTop : s.scrollLeft, range: vertical ? s.scrollHeight - s.clientHeight : s.scrollWidth - s.clientWidth } // prettier-ignore
        },
        { sel: root(index), vertical, screenW },
      )
    await page.evaluate(
      ({ sel, vertical }) => {
        const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
        const range = vertical ? s.scrollHeight - s.clientHeight : s.scrollWidth - s.clientWidth
        if (vertical) s.scrollTop = Math.floor(range / 2)
        else s.scrollLeft = Math.floor(range / 2)
      },
      { sel: root(index), vertical },
    )
    await page.waitForTimeout(400)
    const before = await point()
    expect(before.range).toBeGreaterThan(100)
    expect(before.scroll).toBeGreaterThan(0)
    await page.evaluate(
      async ({ index, box }) => {
        window.__hbExtra = [box]
        const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
        await w.loadSprites()
      },
      { index, box },
    )
    await expect.poll(() => inWidget(page, index, w => w.offMapPixels() !== null)).toBe(true)
    await page.waitForTimeout(1000)
    const after = await point()
    await expect(page.locator(`${root(index)} [data-control="zoom-fit"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
    if (!vertical) expect(after.zoom).toBeLessThan(before.zoom * 0.95)
    else expect(after.zoom).toBeCloseTo(before.zoom, 2)
    expect(Math.abs(after.map - before.map) * after.zoom).toBeLessThanOrEqual(1)
  })
}

/**
 * #1004 criterion 3: with nothing off the map, the map's own area is pixel-identical to before and the gutter
 * shows at the far end (since #1228 only there). $105 and $109 have nothing off the map (the vanilla sweep in theia-shell.md).
 *
 * Two tests per map. The gutter half runs unconditionally. The pixel half compares a real screenshot of the map's
 * own rect (the edge element on the branch, the strip on develop, scrolled to the map origin at Actual size, grid
 * off) with a develop baseline, so CSS, z-order and overlay changes are seen, not just the composite bitmaps.
 * Recipe: on develop run with HB_BASELINE_DIR=<dir> HB_WRITE_BASELINE=1 (writes <dir>/off-map-<map>.sha), then on
 * the branch with HB_BASELINE_DIR=<dir>.
 */
for (const { index, screenW, vertical } of [
  { index: 0x105, screenW: 256, vertical: false },
  { index: 0x109, screenW: 512, vertical: true },
]) {
  const name = `$${index.toString(16)}: with nothing off the map`
  test(`${name}, the gutter shows at the far end only and nothing before the map or on the short sides`, async ({
    page,
  }) => {
    await openMap(page, index)
    await spritesLanded(page, index)
    await zoomAt(page, index, 'zoom-actual')
    const r = await rects(page, index)
    const zoom = r.screen.w / screenW
    expectPad(pads(r, zoom), vertical ? { left: 0, top: 0, right: 0, bottom: G } : { left: 0, top: 0, right: G, bottom: 0 }) // prettier-ignore
  })

  test(`${name}, the map's own area is pixel-identical to the develop baseline (criterion 3)`, async ({
    page,
  }) => {
    test.skip(
      !process.env.HB_BASELINE_DIR,
      '#1004 criterion 3: set HB_BASELINE_DIR; record the baseline on develop with HB_WRITE_BASELINE=1, then run on the branch',
    )
    await openMap(page, index)
    await spritesLanded(page, index)
    await click(page, index, 'zoom-actual')
    // Grid off, so its canvas cannot differ between the two builds.
    const toggle = page.locator(`${root(index)} [data-control="grid-toggle"]`)
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click()
    await page.waitForTimeout(500)
    // Scroll to the map origin (past the leading pad, content only since #1228, on the branch; the strip start on develop, which has no mapOrigin()).
    const clip = await page.evaluate(
      async ({ i, sel }) => {
        const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', {
          index: i,
        })
        const o = typeof w.mapOrigin === 'function' ? w.mapOrigin() : { x: 0, y: 0 }
        const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
        sc.scrollLeft = o.x * w.zoom
        sc.scrollTop = o.y * w.zoom
        await new Promise(res => setTimeout(res, 1500))
        const map = (document.querySelector(`${sel} [data-control="map-edge"]`) ?? document.querySelector(`${sel} .hb-map-view-strip`)).getBoundingClientRect() // prettier-ignore
        const view = sc.getBoundingClientRect()
        const [x0, y0] = [Math.max(map.left, view.left) + 1, Math.max(map.top, view.top) + 1]
        const [x1, y1] = [Math.min(map.right, view.right - 20) - 1, Math.min(map.bottom, view.bottom - 20) - 1] // prettier-ignore
        return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
      },
      { i: index, sel: root(index) },
    )
    expect(clip.width).toBeGreaterThan(100)
    const sha = nodeCrypto
      .createHash('sha256')
      .update(await page.screenshot({ clip }))
      .digest('hex')
    const file = path.join(process.env.HB_BASELINE_DIR, `off-map-${index.toString(16)}.sha`)
    if (process.env.HB_WRITE_BASELINE) {
      fs.mkdirSync(process.env.HB_BASELINE_DIR, { recursive: true })
      fs.writeFileSync(file, sha)
      return
    }
    expect(fs.existsSync(file), `baseline ${file}: run on develop with HB_WRITE_BASELINE=1 first`).toBe(true) // prettier-ignore
    expect(sha).toBe(fs.readFileSync(file, 'utf8'))
  })
}

/**
 * #1016: the ghost house EXIT sign ($8D) is drawn at its doorway, asserted on PIXELS in the map's own coordinates.
 * The sprite canvas of screen 0 is at native resolution (one canvas pixel per map pixel, screen 0 starting at map x 0),
 * so a fractional strip offset or zoom cannot move a pixel. GhostExitMain draws screen-fixed (SMWDisX bank_02.asm:
 * 15663-15692 tables, 15670-15708 routine): the sign at x 8-40, y 287-303, the door frame at y 335-383, with the
 * loader's camera Y of 192 added. Before the fix the sign was drawn 192 px too high and the frame 448 px too high.
 * No hardware capture exists; the expected rows come from the ROM tables and the loader camera.
 */
test('$FB (ghost house): the EXIT sign pixels sit at the doorway, not at the old wrong height', async ({
  page,
}) => {
  await openMap(page, 0xfb)
  await spritesLanded(page, 0xfb)
  await zoomAt(page, 0xfb, 'zoom-actual')
  const canvas = `${root(0xfb)} canvas[data-plane="sprites"][data-screen="0"]`
  await expect(page.locator(canvas)).toHaveAttribute('data-drawn', /./, { timeout: 30000 })
  // Opaque pixels by map row, over a column range of screen 0.
  const rows = x0 =>
    page.evaluate(
      ({ sel, x0, x1 }) => {
        const c = document.querySelector(sel)
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        const out = []
        for (let y = 0; y < c.height; y++) {
          let n = 0
          for (let x = x0; x < Math.min(x1, c.width); x++) if (d[(y * c.width + x) * 4 + 3] > 0) n++
          out.push(n)
        }
        return out
      },
      { sel: canvas, x0, x1: 64 },
    )
  await expect.poll(async () => (await rows(0)).some(n => n > 0), { timeout: 30000 }).toBe(true)
  const all = await rows(0)
  const sign = await rows(8)
  const sum = (a, y0, y1) => a.slice(y0, y1 + 1).reduce((s, n) => s + n, 0)
  // The canvas holds every sprite of screen 0: other sprites near the doorway (from the real reply) are excluded
  // from the "nothing here" checks, so a Boo or a coin cannot fail them.
  const others = (await inWidget(page, 0xfb, w => w.sprites.sprites)).filter(sp => sp.id !== 0x8d)
  const clear = (y0, y1) => others.every(sp => sp.box.x0 >= 64 || sp.box.y1 <= y0 || sp.box.y0 > y1)
  // The sign: opaque pixels in x 8-40, y 287-303 (the columns here start at 8; the sign ends at 40).
  expect(sum(sign, 287, 303)).toBeGreaterThan(0)
  // None at the old wrong height, 192 px higher (the sign) or 448 px higher (the frame).
  if (clear(0, 280)) expect(sum(all, 0, 280)).toBe(0)
  if (clear(95, 111)) expect(sum(all, 95, 111)).toBe(0)
  // The doorway frame below it: opaque rows within 335-383, and none past 383.
  expect(sum(all, 335, 383)).toBeGreaterThan(0)
  if (clear(384, all.length - 1)) expect(sum(all, 384, all.length - 1)).toBe(0)
  // Relative to the frame: the sign's last row is above the frame's first row, the two within one doorway height.
  if (clear(280, 400)) {
    const rowsOf = (a, y0, y1) =>
      a.map((n, y) => (n > 0 && y >= y0 && y <= y1 ? y : -1)).filter(y => y >= 0)
    const signRows = rowsOf(all, 280, 330)
    const frameRows = rowsOf(all, 335, 400)
    expect(signRows.length).toBeGreaterThan(0)
    expect(frameRows.length).toBeGreaterThan(0)
    expect(Math.max(...signRows)).toBeLessThan(Math.min(...frameRows))
    expect(Math.min(...frameRows) - Math.min(...signRows)).toBeLessThanOrEqual(96)
  }
})
