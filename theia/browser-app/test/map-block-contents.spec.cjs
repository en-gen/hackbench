/**
 * Block content indicators in the map view (en-gen/hackbench#566, PR B).
 *
 * Maps and cells (vanilla ROM; smw-mcp find_l1_tile_levels; column, row in tiles):
 *   $123 FoI3   $11B (multi-coin) 77,20; $11C (coin) 79,18 and 76,21; 78,20 holds no item block.
 *   $105 YI1    $11F (progressive flower) 243,17.
 *   $11A VD1    $118 (progressive feather) 69,14.
 *   $11E FoI1   $125 key 224,22 and balloon 250,21.   $125 Funky $111 117,15, $11D 86,20.
 *   $001 VS2    $111 183,16 (progressive), $11D 231,18.
 *
 * Indicators are painted in SCREEN pixels on a per-screen overlay canvas
 * (`canvas[data-layer="indicators"]`: one canvas pixel is one CSS pixel), so every
 * measurement here is in screen pixels, read from the overlay's own alpha and never
 * from a native composite pixel. `data-indicators` is the painter's record of the
 * boxes it drew; each spec checks it against the pixels. The zoom is READ from the
 * canvas (width / 256), not assumed.
 */
const { test, expect } = require('@playwright/test')
const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
const opened = []
const root = index => `[id="hackbench.map-view:${index}"]`
const OVERLAY = screen => `canvas[data-layer="indicators"][data-screen="${screen}"]`

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-blocks-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    const shell = getSvc('ApplicationShell')
    for (const id of ids) {
      try {
        await shell.closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page) {
  return page.evaluate(
    async ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
}

/** Opens a map and waits until its indicators have arrived (every map used here has some). */
async function openMap(page, manifestPath, index) {
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index },
  )
  opened.push(`hackbench.map-view:${index}`)
  await page.waitForFunction(
    id => getSvc('ApplicationShell').getWidgetById(id)?.blocks?.indicators.length > 0,
    `hackbench.map-view:${index}`,
    { timeout: 60000 },
  )
}

/** Moves the pointer off every block (onto the toolbar). */
async function park(page, index) {
  const r = await page.locator(`${root(index)} .hb-map-view-toolbar`).boundingBox()
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
}

async function ready(page, project, index) {
  await openMap(page, project.manifestPath, index)
  await park(page, index)
}

/** The screen and in-screen map-pixel corner of a tile cell (all maps used here are horizontal). */
const cell = (col, row) => ({ screen: Math.floor(col / 16), x: (col % 16) * 16, y: row * 16 })

/** Sets the zoom (1, 2, 3 or 'fit') through the widget's own controller and waits for the overlay to follow. */
async function setZoom(page, index, z) {
  await page.evaluate(
    ({ id, z }) => {
      const c = getSvc('ApplicationShell').getWidgetById(id).zoomController
      if (z === 'fit') return c.enterFit()
      c.actualSize()
      for (let i = 1; i < z; i++) c.step(1)
    },
    { id: `hackbench.map-view:${index}`, z },
  )
  // The overlay is repainted at the new zoom when its width is the composite's CSS width.
  await expect
    .poll(() =>
      page.evaluate(
        ({ sel, ov, z }) => {
          const o = document.querySelector(`${sel} ${ov}`)
          const c = document.querySelector(`${sel} canvas[data-layer="screen"][data-screen="0"]`)
          const css = c.getBoundingClientRect().width
          const zoom = css / c.width
          return (
            Math.abs(o.width - Math.round(css)) <= 1 && (z === 'fit' || Math.abs(zoom - z) < 0.01)
          )
        },
        { sel: root(index), ov: OVERLAY(0), z },
      ),
    )
    .toBe(true)
}

/** Brings the cell to the middle of the view and returns its client centre. */
async function reveal(page, index, col, row) {
  const { screen, x, y } = cell(col, row)
  return page.evaluate(
    ({ sel, ov, x, y }) => {
      const c = document.querySelector(`${sel} ${ov}`)
      const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
      const k = c.getBoundingClientRect().width / 256
      let r = c.getBoundingClientRect()
      const s = sc.getBoundingClientRect()
      sc.scrollLeft += r.left + (x + 8) * k - (s.left + s.width / 2)
      sc.scrollTop += r.top + (y + 8) * k - (s.top + s.height / 2)
      r = c.getBoundingClientRect()
      return { cx: r.left + (x + 8) * k, cy: r.top + (y + 8) * k }
    },
    { sel: root(index), ov: OVERLAY(screen), x, y },
  )
}

/** One screen's overlay read back: the zoom, the painter's record and every lit pixel with its colour. */
async function overlay(page, index, screen) {
  return page.evaluate(
    ({ sel, ov }) => {
      const o = document.querySelector(`${sel} ${ov}`)
      const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data
      const lit = []
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3])
          lit.push({
            x: (i / 4) % o.width,
            y: Math.floor(i / 4 / o.width),
            rgb: [d[i], d[i + 1], d[i + 2]],
          })
      }
      return { z: o.width / 256, record: JSON.parse(o.dataset.indicators || '[]'), lit }
    },
    { sel: root(index), ov: OVERLAY(screen) },
  )
}

/** One block: its rect in screen pixels, its record and the lit pixels inside and outside it. */
async function ofBlock(page, index, col, row) {
  const { screen, x, y } = cell(col, row)
  const o = await overlay(page, index, screen)
  const r = n => Math.round(n * o.z)
  const rect = { x0: r(x), y0: r(y), x1: r(x + 16), y1: r(y + 16) }
  const inRect = d => d.x >= rect.x0 && d.x < rect.x1 && d.y >= rect.y0 && d.y < rect.y1
  const mine = o.record.filter(q => q.id.endsWith(`:${col * 16}:${row * 16}`))
  return { ...o, rect, mine, pixels: o.lit.filter(inRect), outside: o.lit.filter(d => !inRect(d)) }
}

const bbox = list => ({
  x0: Math.min(...list.map(d => d.x)),
  y0: Math.min(...list.map(d => d.y)),
  x1: Math.max(...list.map(d => d.x)) + 1,
  y1: Math.max(...list.map(d => d.y)) + 1,
})
const quadrant = (rect, z, x, y) => ({
  x0: Math.round((x + 8) * z),
  y0: Math.round((y + 8) * z),
  x1: rect.x1,
  y1: rect.y1,
})

test('an item block has indicator pixels in its cell and a block with no contents has none', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x123)
  await setZoom(page, 0x123, 1)
  const item = await ofBlock(page, 0x123, 77, 20)
  expect(item.pixels.length, '$11B has indicator pixels').toBeGreaterThan(8)
  expect(item.mine).toHaveLength(1)
  const none = await ofBlock(page, 0x123, 78, 20)
  expect(none.pixels.length, 'column 78 row 20 holds no item block').toBe(0)
  expect(none.mine).toHaveLength(0)
})

for (const z of [1, 2, 3, 'fit']) {
  test(`at rest the item box is the block's bottom-right quadrant, in screen pixels, at ${z === 'fit' ? 'fit' : z + 'x'}`, async ({
    page,
  }) => {
    const project = await createProject(page)
    await ready(page, project, 0x123)
    await setZoom(page, 0x123, z)
    await reveal(page, 0x123, 77, 20)
    await park(page, 0x123)
    const b = await ofBlock(page, 0x123, 77, 20)
    const { x, y } = cell(77, 20)
    const want = quadrant(b.rect, b.z, x, y)
    expect(b.mine[0].hover).toBe(false)
    expect(b.mine[0].box).toEqual(want)
    // About 8 x zoom CSS pixels wide, with the zoom read from the layout and not from the record.
    expect(want.x1 - want.x0).toBeGreaterThanOrEqual(Math.floor(8 * b.z))
    expect(want.x1 - want.x0).toBeLessThanOrEqual(Math.ceil(8 * b.z))
    const px = bbox(b.pixels)
    expect(px.x0).toBeGreaterThanOrEqual(want.x0)
    expect(px.y0).toBeGreaterThanOrEqual(want.y0)
    expect(px.x1).toBeLessThanOrEqual(want.x1)
    expect(px.y1).toBeLessThanOrEqual(want.y1)
    // The art fills most of the quadrant, so the box is real and not a hidden sliver.
    expect(px.x1 - px.x0).toBeGreaterThanOrEqual(0.6 * (want.x1 - want.x0))
    expect(px.y1 - px.y0).toBeGreaterThanOrEqual(0.6 * (want.y1 - want.y0))
  })
}

test('on hover the item box is the block box, never outside it, and returns to the quadrant on mouse-out', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x123)
  await setZoom(page, 0x123, 2)
  const { cx, cy } = await reveal(page, 0x123, 77, 20)
  await page.mouse.move(cx, cy)
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine[0]?.hover).toBe(true)
  const hov = await ofBlock(page, 0x123, 77, 20)
  expect(hov.mine[0].box).toEqual(hov.rect)
  const px = bbox(hov.pixels)
  expect(px.x1 - px.x0).toBeGreaterThanOrEqual(0.6 * (hov.rect.x1 - hov.rect.x0))
  expect(px.y1 - px.y0).toBeGreaterThanOrEqual(0.6 * (hov.rect.y1 - hov.rect.y0))
  expect(px.x0).toBeGreaterThanOrEqual(hov.rect.x0)
  expect(px.x1).toBeLessThanOrEqual(hov.rect.x1)
  expect(hov.record.filter(r => r.hover)).toHaveLength(1)
  // Scrolling away without moving the mouse re-finds the block under it: the old one is no longer hovered.
  await page.evaluate(sel => {
    document.querySelector(`${sel} [data-control="map-scroller"]`).scrollLeft += 400
  }, root(0x123))
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine[0]?.hover).not.toBe(true)
  await reveal(page, 0x123, 77, 20)
  await park(page, 0x123)
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine[0]?.hover).toBe(false)
  const { x, y } = cell(77, 20)
  const rest = await ofBlock(page, 0x123, 77, 20)
  expect(rest.mine[0].box).toEqual(quadrant(rest.rect, rest.z, x, y))
})

// Layer 2 placement has no vanilla case (no vanilla map holds a layer 2 item block, measured over all
// 512 slots), so it is covered by the synthetic unit tests in test/suite/unit/BlockIndicatorMap.test.ts.
test("hiding layer 1 removes the item block's drawn pixels and showing it restores them", async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x123)
  await setZoom(page, 0x123, 1)
  const before = await ofBlock(page, 0x123, 77, 20)
  expect(before.pixels.length).toBeGreaterThan(0)
  const toggle = page.locator(`${root(0x123)} [data-control="layer-l1"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).pixels.length).toBe(0)
  expect(
    (await overlay(page, 0x123, 4)).lit.length,
    'no indicator pixel is left on the screen',
  ).toBe(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await ofBlock(page, 0x123, 77, 20)).pixels.length)
    .toBe(before.pixels.length)
})

test('a $11B indicator differs from a $11C indicator', async ({ page }) => {
  const project = await createProject(page)
  await ready(page, project, 0x123)
  await setZoom(page, 0x123, 2)
  const multi = await ofBlock(page, 0x123, 77, 20)
  const single = await ofBlock(page, 0x123, 79, 18)
  const rel = b => b.pixels.map(d => `${d.x - b.rect.x0},${d.y - b.rect.y0}:${d.rgb}`).join('|')
  expect(multi.pixels.length).toBeGreaterThan(0)
  expect(single.pixels.length).toBeGreaterThan(0)
  expect(rel(multi)).not.toBe(rel(single))
  // The two single-coin blocks ($11C) look alike, and the "+" is white pixels the plain coin lacks.
  expect(rel(await ofBlock(page, 0x123, 76, 21))).toBe(rel(single))
  const white = b => b.pixels.filter(d => d.rgb.join() === '255,255,255').length
  expect(white(multi)).toBeGreaterThan(white(single))
})

/** Pixels of a hovered progressive block by region of its 16 x 16 art: below, above and on the diagonal. */
async function hoveredSplit(page, index, col, row) {
  await setZoom(page, index, 3)
  const { cx, cy } = await reveal(page, index, col, row)
  await page.mouse.move(cx, cy)
  await expect.poll(async () => (await ofBlock(page, index, col, row)).mine[0]?.hover).toBe(true)
  const b = await ofBlock(page, index, col, row)
  const [w, h] = [b.rect.x1 - b.rect.x0, b.rect.y1 - b.rect.y0]
  const regions = { below: [], above: [], diag: [] }
  for (const d of b.pixels) {
    const [ax, ay] = [
      Math.floor(((d.x - b.rect.x0) * 16) / w),
      Math.floor(((d.y - b.rect.y0) * 16) / h),
    ]
    regions[ay > ax ? 'below' : ay < ax ? 'above' : 'diag'].push({ ...d, ax, ay })
  }
  return { b, regions }
}
const colours = list => [...new Set(list.map(d => d.rgb.join()))].sort().join('|')
const byPos = list =>
  [...new Map(list.map(d => [`${d.ax},${d.ay}`, d.rgb.join()]))].sort().join(';')

test('a progressive block holds the mushroom bottom-left and its item top-right, split on the diagonal', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x105)
  const flower = await hoveredSplit(page, 0x105, 243, 17)
  await ready(page, project, 0x11a)
  const feather = await hoveredSplit(page, 0x11a, 69, 14)
  // Both blocks hold the mushroom below the diagonal: the same art pixels, one for one.
  expect(flower.regions.below.length).toBeGreaterThan(10)
  expect(byPos(flower.regions.below)).toBe(byPos(feather.regions.below))
  // Above it the flower and the feather differ, and a block is not one item twice.
  expect(flower.regions.above.length).toBeGreaterThan(10)
  expect(colours(flower.regions.above)).not.toBe(colours(feather.regions.above))
  expect(colours(flower.regions.above)).not.toBe(colours(flower.regions.below))
})

test('a split indicator has a black line on its diagonal, only on opaque pixels and inside the block', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x105)
  const { b, regions } = await hoveredSplit(page, 0x105, 243, 17)
  expect(regions.diag.length, 'the diagonal has pixels').toBeGreaterThan(0)
  expect(
    regions.diag.every(d => d.rgb.join() === '0,0,0'),
    'every diagonal pixel is black',
  ).toBe(true)
  // The line stops at the items' edges: fewer than all 16 diagonal cells.
  const px = bbox(b.pixels)
  expect(px.x0).toBeGreaterThanOrEqual(b.rect.x0)
  expect(px.y1).toBeLessThanOrEqual(b.rect.y1)
  const cells = new Set(regions.diag.map(d => d.ax))
  expect(cells.size).toBeLessThan(16)
  expect(cells.size).toBeGreaterThan(3)
})

/** A block's drawn pixels relative to its own corner, as a comparable string (colour included). */
const look = b => b.pixels.map(d => `${d.x - b.rect.x0},${d.y - b.rect.y0}:${d.rgb}`).join('|')
const colourSet = b => [...new Set(b.pixels.map(d => d.rgb.join()))].sort().join('|')

test('a cell shows the item of its own X column, in drawn pixels', async ({ page }) => {
  const project = await createProject(page)
  // $125 on FoI1: column 224 (mod 4 = 0) is the key, column 250 (mod 4 = 2) the balloon.
  await ready(page, project, 0x11e)
  await setZoom(page, 0x11e, 2)
  const key = await ofBlock(page, 0x11e, 224, 22)
  const balloon = await ofBlock(page, 0x11e, 250, 21)
  expect(key.pixels.length).toBeGreaterThan(8)
  expect(balloon.pixels.length).toBeGreaterThan(8)
  expect(look(key)).not.toBe(look(balloon))
  // $111 on Funky, column 117 (117 mod 16 mod 3 = 2): the star alone, so no diagonal split line.
  await ready(page, project, 0x125)
  await setZoom(page, 0x125, 2)
  const star = await ofBlock(page, 0x125, 117, 15)
  expect(star.pixels.length).toBeGreaterThan(8)
  // $11D on Funky, column 86 (even): the blue P-switch.
  const blue = await ofBlock(page, 0x125, 86, 20)
  expect(blue.pixels.length).toBeGreaterThan(8)
  // $111 on VS2, column 183 (183 mod 16 mod 3 = 1): the progressive pair, which is not the star.
  await ready(page, project, 0x001)
  await setZoom(page, 0x001, 2)
  const pair = await ofBlock(page, 0x001, 183, 16)
  expect(pair.pixels.length).toBeGreaterThan(8)
  expect(look(pair)).not.toBe(look(star))
  // $11D on VS2, column 231 (odd): the silver P-switch, the same shape as the blue one in another colour.
  const silver = await ofBlock(page, 0x001, 231, 18)
  expect(silver.pixels.length).toBe(blue.pixels.length)
  expect(colourSet(silver)).not.toBe(colourSet(blue))
})
