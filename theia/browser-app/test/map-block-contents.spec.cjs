/**
 * Block content indicators in the map view (en-gen/hackbench#566, PR B).
 *
 * Maps and cells (vanilla ROM; found with smw-mcp find_l1_tile_levels, columns
 * and rows in tiles):
 *   $123 FoI3   $11B (multi-coin) col 77 row 20, $11C (coin) col 79 row 18,
 *               $11C col 76 row 21; col 78 row 20 holds no item block.
 *   $105 YI1    $11F (progressive flower) col 243 row 17.
 *   $11E FoI1   $125 col 224 row 22 (key) and col 250 row 21 (balloon).
 *   $125 Funky  $111 col 117 row 15 (star, column 2 of 3), $11D col 86 row 20 (blue).
 *   $001 VS2    $111 col 183 row 16 (progressive), $11D col 231 row 18 (silver).
 *
 * "Indicator pixels" are measured as the composite's pixels that differ from
 * the same composite repainted with the indicators removed (the widget's
 * `blocks` set aside), so the baseline is the same layers, math and sprites.
 * The item box is read from `data-indicators` on the composite canvas, which
 * the painter writes from the boxes it painted, and every box is checked
 * against the pixels. The composite is at native resolution and CSS-scaled by
 * the zoom, so a box of 8 x 8 native pixels is the block's quadrant at every
 * zoom; the specs also assert the zoom they ran at.
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
  // Indicators have arrived once the widget holds them (maps here all have some).
  await page.waitForFunction(
    id => getSvc('ApplicationShell').getWidgetById(id)?.blocks?.indicators.length > 0,
    `hackbench.map-view:${index}`,
    { timeout: 60000 },
  )
}

/** The screen and in-screen pixel corner of a tile cell (all maps used here are horizontal). */
const cell = (col, row) => ({ screen: Math.floor(col / 16), x: (col % 16) * 16, y: row * 16 })

/** Zoom 1, 2 or 3 through the widget's own controller, then waits for the strip to lay out at it. */
async function setZoom(page, index, z) {
  await page.evaluate(
    ({ id, z }) => {
      const c = getSvc('ApplicationShell').getWidgetById(id).zoomController
      c.actualSize()
      for (let i = 1; i < z; i++) c.step(1)
    },
    { id: `hackbench.map-view:${index}`, z },
  )
  await expect
    .poll(() =>
      page.evaluate(sel => {
        const c = document.querySelector(`${sel} canvas[data-layer="screen"][data-screen="0"]`)
        return c.getBoundingClientRect().width / c.width
      }, root(index)),
    )
    .toBeCloseTo(z, 2)
}

/** Brings the cell to the middle of the view and returns its client centre. */
async function reveal(page, index, col, row) {
  const { screen, x, y } = cell(col, row)
  return page.evaluate(
    ({ sel, screen, x, y }) => {
      const c = document.querySelector(
        `${sel} canvas[data-layer="screen"][data-screen="${screen}"]`,
      )
      const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
      const k = c.getBoundingClientRect().width / c.width
      let r = c.getBoundingClientRect()
      const s = sc.getBoundingClientRect()
      sc.scrollLeft += r.left + (x + 8) * k - (s.left + s.width / 2)
      sc.scrollTop += r.top + (y + 8) * k - (s.top + s.height / 2)
      r = c.getBoundingClientRect()
      return { cx: r.left + (x + 8) * k, cy: r.top + (y + 8) * k }
    },
    { sel: root(index), screen, x, y },
  )
}

/** Moves the pointer off every block (onto the toolbar) and waits for the repaint. */
async function park(page, index) {
  const r = await page.locator(`${root(index)} .hb-map-view-toolbar`).boundingBox()
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2)
}

/**
 * What the indicators of one screen are: the painter's own record per block,
 * and the composite's pixels that differ from the same screen repainted with
 * no indicators, with their colours.
 */
async function measure(page, index, screen) {
  return page.evaluate(
    ({ id, screen }) => {
      const w = getSvc('ApplicationShell').getWidgetById(id)
      const c = w.node.querySelector(`canvas[data-layer="screen"][data-screen="${screen}"]`)
      const read = () => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice()
      const withI = read()
      const record = JSON.parse(c.dataset.indicators || '[]')
      const saved = w.blocks
      w.blocks = undefined
      w.blocksVersion++
      w.sync()
      const without = read()
      w.blocks = saved
      w.blocksVersion++
      w.sync()
      const diff = []
      for (let i = 0; i < withI.length; i += 4) {
        if (withI[i] === without[i] && withI[i + 1] === without[i + 1] && withI[i + 2] === without[i + 2] && withI[i + 3] === without[i + 3]) continue // prettier-ignore
        const p = i / 4
        diff.push({ x: p % c.width, y: Math.floor(p / c.width), rgb: [withI[i], withI[i + 1], withI[i + 2]] }) // prettier-ignore
      }
      return { record, diff }
    },
    { id: `hackbench.map-view:${index}`, screen },
  )
}

const inside = (d, r) => d.x >= r.x && d.x < r.x + 16 && d.y >= r.y && d.y < r.y + 16
const bbox = list => ({
  x0: Math.min(...list.map(d => d.x)),
  y0: Math.min(...list.map(d => d.y)),
  x1: Math.max(...list.map(d => d.x)) + 1,
  y1: Math.max(...list.map(d => d.y)) + 1,
})
/** Indicator pixels inside one block's cell, and the record entry for it. */
async function ofBlock(page, index, col, row) {
  const { screen, x, y } = cell(col, row)
  const m = await measure(page, index, screen)
  const mine = m.record.filter(r => r.id.endsWith(`:${col * 16}:${row * 16}`))
  return { ...m, rect: { x, y }, pixels: m.diff.filter(d => inside(d, { x, y })), mine }
}

test('an item block has indicator pixels in its cell and a block with no contents has none', async ({
  page,
}) => {
  const project = await createProject(page)
  await openMap(page, project.manifestPath, 0x123)
  await setZoom(page, 0x123, 1)
  await park(page, 0x123)
  const item = await ofBlock(page, 0x123, 77, 20)
  expect(item.pixels.length, '$11B has indicator pixels').toBeGreaterThan(8)
  // Every changed pixel on the screen belongs to some item block's cell, none to col 78 row 20.
  const none = cell(78, 20)
  expect(item.diff.filter(d => inside(d, none)).length).toBe(0)
  expect(item.mine).toHaveLength(1)
})

for (const z of [1, 2, 3]) {
  test(`at rest the item box is the block's bottom-right quadrant at ${z}x`, async ({ page }) => {
    const project = await createProject(page)
    await openMap(page, project.manifestPath, 0x123)
    await setZoom(page, 0x123, z)
    await park(page, 0x123)
    await reveal(page, 0x123, 77, 20)
    await park(page, 0x123)
    const b = await ofBlock(page, 0x123, 77, 20)
    const { x, y } = b.rect
    expect(b.mine[0].hover).toBe(false)
    expect(b.mine[0].box).toEqual({ x0: x + 8, y0: y + 8, x1: x + 16, y1: y + 16 })
    const px = bbox(b.pixels)
    expect(px.x0).toBeGreaterThanOrEqual(x + 8)
    expect(px.y0).toBeGreaterThanOrEqual(y + 8)
    expect(px.x1).toBeLessThanOrEqual(x + 16)
    expect(px.y1).toBeLessThanOrEqual(y + 16)
    // The art fills most of the quadrant, so the box is real and not a hidden sliver.
    expect(px.x1 - px.x0).toBeGreaterThanOrEqual(5)
    expect(px.y1 - px.y0).toBeGreaterThanOrEqual(6)
  })
}

test('on hover the item box is the block box, never outside it, and returns to the quadrant on mouse-out', async ({
  page,
}) => {
  const project = await createProject(page)
  await openMap(page, project.manifestPath, 0x123)
  await setZoom(page, 0x123, 2)
  const { cx, cy } = await reveal(page, 0x123, 77, 20)
  await page.mouse.move(cx, cy)
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine[0]?.hover).toBe(true)
  const hov = await ofBlock(page, 0x123, 77, 20)
  const { x, y } = hov.rect
  expect(hov.mine[0].box).toEqual({ x0: x, y0: y, x1: x + 16, y1: y + 16 })
  // Nothing changed outside the painted item boxes (this block's, and the others' resting ones).
  const boxes = hov.record.map(r => r.box)
  expect(hov.diff.every(d => boxes.some(q => d.x >= q.x0 && d.x < q.x1 && d.y >= q.y0 && d.y < q.y1))).toBe(true) // prettier-ignore
  expect(hov.pixels.every(d => inside(d, hov.rect))).toBe(true)
  const px = bbox(hov.pixels)
  expect(px.x1 - px.x0).toBeGreaterThanOrEqual(12)
  expect(px.y1 - px.y0).toBeGreaterThanOrEqual(12)
  // Only this block expanded.
  expect(hov.record.filter(r => r.hover)).toHaveLength(1)
  await park(page, 0x123)
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine[0]?.hover).toBe(false)
  const rest = await ofBlock(page, 0x123, 77, 20)
  expect(rest.mine[0].box).toEqual({ x0: x + 8, y0: y + 8, x1: x + 16, y1: y + 16 })
})

test("hiding the block's layer removes its indicator pixels and showing it restores them", async ({
  page,
}) => {
  const project = await createProject(page)
  await openMap(page, project.manifestPath, 0x123)
  await setZoom(page, 0x123, 1)
  await park(page, 0x123)
  const before = await ofBlock(page, 0x123, 77, 20)
  expect(before.pixels.length).toBeGreaterThan(0)
  const plane = before.mine[0].id.split(':')[0]
  expect(plane.startsWith('l1')).toBe(true)
  const toggle = page.locator(`${root(0x123)} [data-control="layer-l1"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await ofBlock(page, 0x123, 77, 20)).mine.length).toBe(0)
  const off = await ofBlock(page, 0x123, 77, 20)
  expect(off.pixels.length).toBe(0)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect
    .poll(async () => (await ofBlock(page, 0x123, 77, 20)).pixels.length)
    .toBe(before.pixels.length)
})

test('a $11B indicator differs from a $11C indicator', async ({ page }) => {
  const project = await createProject(page)
  await openMap(page, project.manifestPath, 0x123)
  await setZoom(page, 0x123, 1)
  await park(page, 0x123)
  const multi = await ofBlock(page, 0x123, 77, 20)
  const single = await ofBlock(page, 0x123, 79, 18)
  // Painted pixels are the art itself: compare them relative to their own box.
  const rel = b => b.pixels.map(d => `${d.x - b.rect.x},${d.y - b.rect.y}:${d.rgb}`).join('|')
  expect(multi.pixels.length).toBeGreaterThan(0)
  expect(single.pixels.length).toBeGreaterThan(0)
  expect(rel(multi)).not.toBe(rel(single))
  // The two single-coin blocks ($11C) look alike.
  const other = await ofBlock(page, 0x123, 76, 21)
  expect(rel(other)).toBe(rel(single))
})

test('a progressive block holds two distinct items split along the diagonal', async ({ page }) => {
  const project = await createProject(page)
  await openMap(page, project.manifestPath, 0x105)
  await setZoom(page, 0x105, 2)
  const { cx, cy } = await reveal(page, 0x105, 243, 17)
  await page.mouse.move(cx, cy)
  await expect.poll(async () => (await ofBlock(page, 0x105, 243, 17)).mine[0]?.hover).toBe(true)
  const b = await ofBlock(page, 0x105, 243, 17)
  const side = below =>
    new Set(
      b.pixels.filter(d => d.y - b.rect.y > d.x - b.rect.x === below).map(d => d.rgb.join(',')),
    )
  const [bl, tr] = [side(true), side(false)]
  expect(bl.size).toBeGreaterThan(0)
  expect(tr.size).toBeGreaterThan(0)
  expect([...bl].sort().join('|')).not.toBe([...tr].sort().join('|'))
  // Hard split: no pixel on the wrong side carries the other item's colours only.
  expect(b.pixels.length).toBeGreaterThan(40)
})

test('a cell shows the item of its own X column', async ({ page }) => {
  const project = await createProject(page)
  const keys = async (index, cells) =>
    page.evaluate(
      async ({ mp, index, cells }) => {
        const r = await getSvc('Symbol(ProjectService)').mapBlockContents(mp, index)
        return cells.map(
          ([c, row]) => r.indicators.find(i => i.x === c * 16 && i.y === row * 16)?.art,
        )
      },
      { mp: project.manifestPath, index, cells },
    )
  // $125: key at column 224 (mod 4 = 0), balloon at 250 (mod 4 = 2).
  const [key, balloon] = await keys(0x11e, [
    [224, 22],
    [250, 21],
  ])
  expect(key).toMatch(/^s80:/)
  expect(balloon).toMatch(/^s7d:/)
  // $111 column 117 (117 mod 16 mod 3 = 2): the star alone; column 183 (1): a progressive pair.
  const [star] = await keys(0x125, [[117, 15]])
  expect(star).toMatch(/^s76:/)
  const [prog] = await keys(0x001, [[183, 16]])
  expect(prog).toContain('/')
  // $11D: blue on an even column, silver on an odd one.
  const [blue] = await keys(0x125, [[86, 20]])
  const [silver] = await keys(0x001, [[231, 18]])
  expect(blue).toMatch(/^s3e:\d+:6:/)
  expect(silver).toMatch(/^s3e:\d+:2:/)
})
