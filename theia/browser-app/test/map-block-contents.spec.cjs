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
 * Indicators are composed INTO their block's plane at SCREEN resolution (#566, owner ruling 2026-10-06): a
 * screen that holds one has a DISPLAY canvas (`canvas[data-layer="display"]`, `round(256 x zoom)` wide) over its
 * composite, which stays native and untouched. A nearer plane or a sprite covers an indicator exactly as it
 * covers its block. "Indicator pixels" are the display's pixels that differ from the native composite scaled up
 * the way the view scales it, so the baseline is the same layers, math and sprites. `data-indicators` is the
 * painter's record of the boxes it drew; each spec checks it against the pixels. The zoom is READ from the
 * canvas, not assumed.
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
const SCREEN = screen => `canvas[data-layer="screen"][data-screen="${screen}"]`
const DISPLAY = screen => `canvas[data-layer="display"][data-screen="${screen}"]`

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
  await expect
    .poll(() =>
      page.evaluate(
        ({ id, z }) => {
          const w = getSvc('ApplicationShell').getWidgetById(id)
          return (
            w.renderedZoom === w.zoomController.value &&
            (z === 'fit' || Math.abs(w.zoomController.value - z) < 0.01)
          )
        },
        { id: `hackbench.map-view:${index}`, z },
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
    { sel: root(index), ov: SCREEN(screen), x, y },
  )
}

/**
 * One screen read back from its display canvas (the screen at the zoom, indicators drawn in their layers):
 * the zoom, the painter's record and the indicator pixels with their colour, which are the display's pixels that
 * differ from the native composite scaled up the way the view scales it. The composite itself is never touched.
 * With `settle` it first waits for a display built at the widget's current zoom (not wanted for a hidden layer).
 */
async function overlay(page, index, screen, settle = true) {
  if (settle) {
    await page.waitForFunction(
      ({ id, ov }) => {
        const w = getSvc('ApplicationShell').getWidgetById(id)
        const c = w.node.querySelector(ov)
        return !!c?.dataset.drawn && c.dataset.drawn.endsWith(`:${w.zoomController.value}`)
      },
      { id: `hackbench.map-view:${index}`, ov: DISPLAY(screen) },
      { timeout: 15000 },
    )
  }
  return page.evaluate(
    ({ id, ov, sc }) => {
      const w = getSvc('ApplicationShell').getWidgetById(id)
      const d = w.node.querySelector(ov)
      const c = w.node.querySelector(sc)
      if (!d.width) return { z: 0, record: [], lit: [] }
      const [shown, nat] = [d.getContext('2d').getImageData(0, 0, d.width, d.height).data, c.getContext('2d').getImageData(0, 0, c.width, c.height).data] // prettier-ignore
      const lit = []
      for (let y = 0; y < d.height; y++) {
        const ny = Math.min(c.height - 1, Math.floor((y * c.height) / d.height))
        for (let x = 0; x < d.width; x++) {
          const i = (y * d.width + x) * 4
          const j = (ny * c.width + Math.min(c.width - 1, Math.floor((x * c.width) / d.width))) * 4
          if (shown[i] === nat[j] && shown[i + 1] === nat[j + 1] && shown[i + 2] === nat[j + 2] && shown[i + 3] === nat[j + 3]) continue // prettier-ignore
          lit.push({ x, y, rgb: [shown[i], shown[i + 1], shown[i + 2]] })
        }
      }
      return { z: d.width / 256, record: JSON.parse(d.dataset.indicators || '[]'), lit }
    },
    { id: `hackbench.map-view:${index}`, ov: DISPLAY(screen), sc: SCREEN(screen) },
  )
}

/** One block: its rect in screen pixels, its record and the lit pixels inside and outside it. */
async function ofBlock(page, index, col, row, settle = true, scroll = true) {
  const { screen, x, y } = cell(col, row)
  if (scroll) await reveal(page, index, col, row) // a screen that is not in view is not fetched or painted
  const o = await overlay(page, index, screen, settle)
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
  await expect
    .poll(async () => (await ofBlock(page, 0x123, 77, 20, true, false)).mine[0]?.hover)
    .not.toBe(true)
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
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20, false)).pixels.length).toBe(0)
  expect(
    (await overlay(page, 0x123, 4, false)).lit.length,
    'no indicator pixel is left on the screen',
  ).toBe(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await ofBlock(page, 0x123, 77, 20)).pixels.length)
    .toBe(before.pixels.length)
})

/** The native pixels (x, y in the screen) the sprite layer paints opaque, from the sprite plane canvas. */
async function spritePixels(page, index, screen) {
  return page.evaluate(
    ({ sel, screen }) => {
      const c = document.querySelector(
        `${sel} canvas[data-plane="sprites"][data-screen="${screen}"]`,
      )
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const out = []
      for (let i = 3; i < d.length; i += 4)
        if (d[i]) out.push(`${((i - 3) / 4) % c.width},${Math.floor((i - 3) / 4 / c.width)}`)
      return out
    },
    { sel: root(index), screen },
  )
}

// A sprite that overlaps an item block covers its indicator exactly as it covers the block: the sprite's
// pixels win. Spots measured on the vanilla ROM: $101 at 43,15 and $107 at 117,21.
for (const [map, col, row] of [
  [0x101, 43, 15],
  [0x107, 117, 21],
]) {
  test(`a sprite over the item block at ${col},${row} on $${map.toString(16)} covers its indicator`, async ({
    page,
  }) => {
    const project = await createProject(page)
    await ready(page, project, map)
    await setZoom(page, map, 3)
    const { cx, cy } = await reveal(page, map, col, row)
    await page.mouse.move(cx, cy) // hover: the indicator fills the whole block, so every overlap is exposed
    await expect.poll(async () => (await ofBlock(page, map, col, row)).mine[0]?.hover).toBe(true)
    const b = await ofBlock(page, map, col, row)
    const { screen, x, y } = cell(col, row)
    const sprites = new Set(await spritePixels(page, map, screen))
    const under = []
    for (let ny = y; ny < y + 16; ny++)
      for (let nx = x; nx < x + 16; nx++) if (sprites.has(`${nx},${ny}`)) under.push([nx, ny])
    expect(under.length, 'a sprite paints pixels of the block cell').toBeGreaterThan(0)
    expect(b.pixels.length, 'the indicator still shows where no sprite is').toBeGreaterThan(0)
    const hidden = b.pixels.filter(d =>
      sprites.has(`${Math.floor(d.x / b.z)},${Math.floor(d.y / b.z)}`),
    )
    expect(hidden, 'no indicator pixel is drawn over a sprite pixel').toHaveLength(0)
  })
}

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

/** Pixels of a hovered progressive block by region of its 16 x 16 art: the base item (bottom-right of the anti-diagonal, x + y > 15), the upgrade (top-left, x + y < 15) and the line itself (x + y = 15). */
async function hoveredSplit(page, index, col, row) {
  await setZoom(page, index, 3)
  const { cx, cy } = await reveal(page, index, col, row)
  await page.mouse.move(cx, cy)
  await expect.poll(async () => (await ofBlock(page, index, col, row)).mine[0]?.hover).toBe(true)
  const b = await ofBlock(page, index, col, row)
  const [w, h] = [b.rect.x1 - b.rect.x0, b.rect.y1 - b.rect.y0]
  const regions = { base: [], upgrade: [], line: [] }
  for (const d of b.pixels) {
    const [ax, ay] = [
      Math.floor(((d.x - b.rect.x0) * 16) / w),
      Math.floor(((d.y - b.rect.y0) * 16) / h),
    ]
    regions[ax + ay > 15 ? 'base' : ax + ay < 15 ? 'upgrade' : 'line'].push({ ...d, ax, ay })
  }
  return { b, regions }
}
const colours = list => [...new Set(list.map(d => d.rgb.join()))].sort().join('|')
const shape = list => new Set(list.map(d => `${d.ax},${d.ay}`))
/** How different two pixel sets are, 0 to 1. A pixel whose colour equals the background under it is not lit (the
 * measure is a diff), and the two maps have different backgrounds, so a few edge pixels may differ. */
const unlike = (a, b) => [...a].filter(k => !b.has(k)).length / Math.max(1, new Set([...a, ...b]).size) + [...b].filter(k => !a.has(k)).length / Math.max(1, new Set([...a, ...b]).size) // prettier-ignore

test('a progressive block holds the mushroom bottom-right and its item top-left, split on the anti-diagonal', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x105)
  const flower = await hoveredSplit(page, 0x105, 243, 17)
  await ready(page, project, 0x11a)
  const feather = await hoveredSplit(page, 0x11a, 69, 14)
  // Both blocks hold the mushroom as the base, bottom-right of the anti-diagonal: the same art pixels, one for one.
  expect(flower.regions.base.length).toBeGreaterThan(10)
  // The same mushroom: the same art pixels (the level's palette may colour it differently), none on the line.
  expect(unlike(shape(flower.regions.base), shape(feather.regions.base))).toBeLessThan(0.06)
  // It is the mushroom in its own palette (red, not the 1-up's green): the unit test checks the exact row
  // against the ROM and the level's CGRAM; here the drawn pixels must be red-dominant and none green-dominant.
  for (const half of [flower.regions.base, feather.regions.base]) {
    expect(
      half.some(d => d.rgb[0] > 150 && d.rgb[1] < 90 && d.rgb[2] < 90),
      'a red mushroom pixel',
    ).toBe(true)
    expect(
      half.some(d => d.rgb[1] > d.rgb[0] + 50 && d.rgb[1] > d.rgb[2] + 50),
      'no green pixel',
    ).toBe(false)
  }
  // Above it the flower and the feather differ, and a block is not one item twice.
  expect(flower.regions.upgrade.length).toBeGreaterThan(10)
  expect(colours(flower.regions.upgrade)).not.toBe(colours(feather.regions.upgrade))
  expect(colours(flower.regions.upgrade)).not.toBe(colours(flower.regions.base))
})

test('a split indicator has a black line on its anti-diagonal, only on opaque pixels and inside the block', async ({
  page,
}) => {
  const project = await createProject(page)
  await ready(page, project, 0x105)
  const { b, regions } = await hoveredSplit(page, 0x105, 243, 17)
  expect(regions.line.length, 'the line has pixels').toBeGreaterThan(0)
  expect(
    regions.line.every(d => d.rgb.join() === '0,0,0'),
    'every line pixel is black',
  ).toBe(true)
  // The line stops at the items' edges: fewer than all 16 line cells.
  const px = bbox(b.pixels)
  expect(px.x0).toBeGreaterThanOrEqual(b.rect.x0)
  expect(px.y1).toBeLessThanOrEqual(b.rect.y1)
  const cells = new Set(regions.line.map(d => d.ax))
  expect(cells.size).toBeLessThan(16)
  expect(cells.size).toBeGreaterThan(3)
})

/** A block's drawn pixels relative to its own corner, as a comparable string (colour included). */
const look = b => b.pixels.map(d => `${d.x - b.rect.x0},${d.y - b.rect.y0}:${d.rgb}`).join('|')

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
  // $111 on Funky, column 117 (117 mod 16 mod 3 = 2): the star alone, so no split line.
  await ready(page, project, 0x125)
  await setZoom(page, 0x125, 2)
  const star = await ofBlock(page, 0x125, 117, 15)
  expect(star.pixels.length).toBeGreaterThan(8)
  // $11D on Funky, column 86 (even): the blue P-switch; on VS2, column 231 (odd): the silver one. Asserted on
  // the drawn colours directly, since the two maps have different backgrounds: blue has a strongly blue pixel,
  // silver only greys.
  const blue = await ofBlock(page, 0x125, 86, 20)
  expect(blue.pixels.length).toBeGreaterThan(8)
  expect(
    blue.pixels.some(d => d.rgb[2] > d.rgb[0] + 80 && d.rgb[2] > d.rgb[1] + 80),
    'a blue pixel',
  ).toBe(true)
  await ready(page, project, 0x001)
  await setZoom(page, 0x001, 2)
  const pair = await ofBlock(page, 0x001, 183, 16)
  expect(pair.pixels.length).toBeGreaterThan(8)
  expect(look(pair)).not.toBe(look(star))
  const silver = await ofBlock(page, 0x001, 231, 18)
  expect(silver.pixels.length).toBeGreaterThan(8)
  const grey = d => Math.abs(d.rgb[0] - d.rgb[1]) < 12 && Math.abs(d.rgb[1] - d.rgb[2]) < 12
  expect(
    silver.pixels.some(d => grey(d) && d.rgb[0] > 90 && d.rgb[0] < 160),
    'a silver grey pixel',
  ).toBe(true)
  expect(
    silver.pixels.some(d => d.rgb[2] > d.rgb[0] + 80),
    'no blue pixel',
  ).toBe(false)
})
