/**
 * The map tab draws the L1 (foreground), en-gen/hackbench#205 step 3, and the
 * L2 (background) under it, en-gen/hackbench#459.
 *
 * Every assertion reads PIXELS back, never the mere presence of a canvas: a
 * blank canvas is on screen too, and the first build of this tab passed six
 * presence-flavored checks while the user saw only sky. So the first test
 * reads what is inside the VIEWPORT, not what is somewhere in the canvas.
 *
 * Each screen is its own canvas per plane (`[data-screen=N][data-plane=l1Low]`) at native resolution,
 * carrying `data-drawn="<generation>:<palaces>:<switches>:<screen>"` once the
 * reply for the current state is painted; palaces are yellow, green, red,
 * blue bits, switches blue P-switch, silver P-switch, ON/OFF.
 *
 * Measured on the vanilla ROM by expanding $105 with and without the yellow
 * palace (map-screen's unit test pins the same cells): exactly five cells
 * change, one of them column 156, row 20 (screen 9, local column 12). $106
 * has its own at column 39, row 20 (screen 2, column 7). $0BD is one screen.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords } = require('./rom-words.cjs')
const { expectCheckerboard, PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { readGrid } = require('./grid-probe.cjs')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

/**
 * ForegroundPalettes variant 0, row 2 color 2 (PaletteLoader ADDR_FG_PAIR,
 * bank_00.asm:6141). Found by changing each palette word in turn and keeping
 * one that moves pixels on $105's first screen.
 */
const FG_COLOR_ADDR = 0x00b194
const NEW_HEX = '$03E0'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function checksumOf(data) {
  let sum = 2166136261
  for (let i = 0; i < data.length; i += 4) {
    sum = (sum ^ (i + data[i] * 7 + data[i + 1] * 13 + data[i + 2] * 17 + data[i + 3] * 19)) >>> 0
    sum = Math.imul(sum, 16777619) >>> 0
  }
  return sum
}`

let tmp
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mapview-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
})

test.afterEach(async ({ page }) => {
  // One backend serves every test: close what each opened.
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

async function createProject(page, dir) {
  return page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: 'MyHack', directory })
    },
    { romPath: ROM, directory: dir },
  )
}

/** A tab CSS selector for one map; its id is `hackbench.map-view:<index>`. */
const root = index => `[id="hackbench.map-view:${index}"]`

/** `data-drawn` for a screen painted with the given palaces pressed, any generation. */
const drawn = (screen, yellow = false, blue = false) =>
  new RegExp(`^\\d+:${yellow ? 1 : 0}000:${blue ? 1 : 0}00:${screen}$`)

/** Opens a map in its own tab (one widget per index, as a pin does). */
async function openMap(page, manifestPath, index) {
  await page.evaluate(
    async ({ mp, index }) => {
      const wm = getSvc('WidgetManager')
      const w = await wm.getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index },
  )
  opened.push(`hackbench.map-view:${index}`)
  await expect(
    page.locator(`${root(index)} canvas[data-screen="0"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', drawn(0), { timeout: 30000 })
}

async function activate(page, index) {
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, `hackbench.map-view:${index}`)
  await page.waitForTimeout(300)
}

/** Scrolls a screen into view and waits until it is painted for the given palaces. */
async function showScreen(page, index, screen, yellow = false) {
  const sel = `${root(index)} canvas[data-screen="${screen}"][data-plane="l1Low"]`
  await page.locator(sel).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
  await expect(page.locator(sel)).toHaveAttribute('data-drawn', drawn(screen, yellow), {
    timeout: 15000,
  })
}

/**
 * One screen's pixels as the user sees them: the planes that are shown, over the back area
 * layer (a hidden layer is left out; L1 is clear where no tile draws): a positional checksum, distinct colors,
 * per-cell checksums, raw RGBA.
 */
async function readScreen(page, index, screen) {
  return page.evaluate(
    ({ sel, rootSel }) => {
      const c = document.querySelector(sel)
      const bg = getComputedStyle(document.querySelector(`${rootSel} [data-layer="back-area"]`))
        .backgroundColor.match(/\d+/g)
        .map(Number)
      const data = composeCanvases(planesOf(rootSel, c.dataset.screen), 0, 0, c.width, c.height)
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]
        for (let k = 0; k < 3; k++)
          data[i + k] = Math.round((data[i + k] * a + bg[k] * (255 - a)) / 255)
        data[i + 3] = 255
      }
      const distinct = new Set()
      for (let i = 0; i < data.length; i += 4) distinct.add(data.slice(i, i + 4).join(','))
      const cellOf = (cx, cy) => {
        const out = new Uint8ClampedArray(16 * 16 * 4)
        for (let y = 0; y < 16; y++) {
          const from = ((cy * 16 + y) * c.width + cx * 16) * 4
          out.set(data.subarray(from, from + 64), y * 64)
        }
        return out
      }
      const cells = {}
      for (let cy = 0; cy < c.height / 16; cy++)
        for (let cx = 0; cx < c.width / 16; cx++) cells[`${cx},${cy}`] = checksumOf(cellOf(cx, cy))
      return { checksum: checksumOf(data), distinct: distinct.size, cells, rgba: Array.from(data) }
    },
    {
      sel: `${root(index)} canvas[data-screen="${screen}"][data-plane="l1Low"]`,
      rootSel: root(index),
    },
  )
}

/** The planes of a screen, L1's by default: low, then high. */
const MAP_PLANES = ['l2Low', 'l2High', 'l3Low', 'l3High', 'l1Low', 'l1High']
const planeLocators = (page, index, screen, planes = ['l1Low', 'l1High']) =>
  planes.map(p => page.locator(`${root(index)} canvas[data-screen="${screen}"][data-plane="${p}"]`))

const changedCells = (a, b) => Object.keys(a.cells).filter(k => a.cells[k] !== b.cells[k])

/**
 * The pixels the user can actually SEE: every screen canvas clipped to the
 * scroller's visible box, read at native resolution. Also whether the whole
 * height (horizontal map) of the map is inside that box.
 */
async function readViewport(page, index) {
  return page.evaluate(sel => {
    const scroller = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const view = scroller.getBoundingClientRect()
    const visH = scroller.clientHeight
    const visW = scroller.clientWidth
    const distinct = new Set()
    const screens = []
    let fullHeight = true
    for (const c of scroller.querySelectorAll('canvas[data-plane="l1Low"]')) {
      const r = c.getBoundingClientRect()
      const left = Math.max(r.left, view.left)
      const right = Math.min(r.right, view.left + visW)
      const top = Math.max(r.top, view.top)
      const bottom = Math.min(r.bottom, view.top + visH)
      if (right <= left || bottom <= top) continue
      if (r.bottom > view.top + visH + 1 || r.top < view.top - 1) fullHeight = false
      const sx = c.width / r.width
      const sy = c.height / r.height
      const x0 = Math.floor((left - r.left) * sx)
      const y0 = Math.floor((top - r.top) * sy)
      const w = Math.max(1, Math.floor((right - left) * sx))
      const h = Math.max(1, Math.floor((bottom - top) * sy))
      const data = composeCanvases(planesOf(sel, c.dataset.screen), x0, y0, w, h)
      const own = new Set()
      for (let i = 0; i < data.length; i += 4) {
        const px = data.slice(i, i + 4).join(',')
        distinct.add(px)
        own.add(px)
      }
      screens.push({ screen: Number(c.dataset.screen), drawn: c.dataset.drawn ?? null, distinct: own.size }) // prettier-ignore
    }
    return { distinct: distinct.size, fullHeight, screens }
  }, root(index))
}

test('at open, the map fills the view and visible terrain is drawn', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.waitForTimeout(500) // the fit runs on the next frame
  const view = await readViewport(page, 0x105)
  // $105's top 120 rows are one sky color: a view showing only them is the
  // defect this guards, and it reads 1 or 2 colors here.
  expect(view.fullHeight).toBe(true)
  expect(view.distinct).toBeGreaterThan(4)
  // Per screen, not in total: the total passed while screen 0 was blank,
  // because screen 1's terrain was in view too.
  await expectEveryVisibleScreenDrawn(page, 0x105)
})

/**
 * Every screen in view is painted: `data-drawn` set and more than one color
 * (a blank canvas is one color, all clear).
 */
async function expectEveryVisibleScreenDrawn(page, index) {
  // Screens past the first arrive after the strip is laid out: wait for them.
  await expect
    .poll(async () => (await readViewport(page, index)).screens.every(s => s.drawn !== null), {
      timeout: 15000,
    }) // prettier-ignore
    .toBe(true)
  const view = await readViewport(page, index)
  expect(view.screens.length).toBeGreaterThan(0)
  for (const s of view.screens) {
    expect(s.drawn, `screen ${s.screen} painted`).not.toBeNull()
    expect(s.distinct, `screen ${s.screen} colors`).toBeGreaterThan(1)
  }
}

/**
 * The screen the first (sizing) reply draws. Its canvas does not exist yet
 * when that reply lands, and a repaint timed before React's commit left it
 * blank on every map (owner: $009, $013, $12C on build c6e39a15). Screen 1
 * is checked too.
 */
// A spread, not the reported maps only: the defect was in the widget, so it
// hit every map. $109 is vertical.
for (const index of [0x009, 0x013, 0x105, 0x106, 0x12c, 0x109]) {
  test(`at open, screen 0 of $${index.toString(16).padStart(3, '0')} is painted, not blank`, async ({
    page,
  }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    await page.waitForTimeout(500)
    for (const screen of [0, 1]) {
      const px = await readScreen(page, index, screen)
      expect(px.distinct, `screen ${screen} colors`).toBeGreaterThan(1)
    }
    await expectEveryVisibleScreenDrawn(page, index)
  })
}

/**
 * A preview tab is ONE widget reused for the next single-clicked map. Two
 * horizontal maps fit alike, so no later render follows the sizing reply:
 * screen 0 must be painted by that reply itself (review of 4e932c3c; the
 * owner saw $106's screen 0 blank this way on d8500dd0).
 */
/**
 * The composite is what the user sees, so opening another map in a reused preview tab must blank it
 * at once: no screen of the new map has landed (its fetch is stubbed out), and the old map's pixels
 * must not stay up as a plausible picture of it.
 */
test('a reused tab blanks the composite when it opens another map', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const comp = page.locator(`${root(0x105)} canvas[data-layer="screen"][data-screen="0"]`)
  await expect(comp).toHaveAttribute('data-drawn', /./, { timeout: 15000 })
  const count = () => comp.evaluate(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n }) // prettier-ignore
  expect(await count(), 'map A is on screen').toBeGreaterThan(0)
  const after = await page.evaluate(async mp => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:261')
    w.fetchScreen = async () => {} // map B's screens never arrive
    await w.open({ manifestPath: mp, index: 0x106, label: '106', iconClass: '' })
    // The tab's id follows the map it shows, so find the composite from the widget.
    const c = w.node.querySelector('canvas[data-layer="screen"][data-screen="0"]')
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let n = 0
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++
    return { n, drawn: c.dataset.drawn ?? null }
  }, project.manifestPath)
  expect(after).toEqual({ n: 0, drawn: null })
})

test('a reused tab paints screen 0 of the next map', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.evaluate(async mp => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:261')
    await w.open({ manifestPath: mp, index: 0x106, label: '106', iconClass: '' })
  }, project.manifestPath)
  opened.push('hackbench.map-view:262')
  await expect(
    page.locator(`${root(0x106)} canvas[data-screen="0"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', drawn(0), { timeout: 15000 })
  const px = await readScreen(page, 0x106, 0)
  expect(px.distinct).toBeGreaterThan(1)
  await expectEveryVisibleScreenDrawn(page, 0x106)
})

/** A reused tab starts the next map at its first screen, not where the last one was scrolled. */
test('a reused tab resets the scroll for the next map', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showScreen(page, 0x105, 9)
  const scroller = id => page.locator(`${root(id)} [data-control="map-scroller"]`)
  const screenWidth = await page.locator(`${root(0x105)} canvas[data-screen="0"][data-plane="l1Low"]`).evaluate(c => c.getBoundingClientRect().width) // prettier-ignore
  expect(await scroller(0x105).evaluate(el => el.scrollLeft)).toBeGreaterThan(2 * screenWidth)
  await page.evaluate(async mp => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:261')
    await w.open({ manifestPath: mp, index: 0x106, label: '106', iconClass: '' })
  }, project.manifestPath)
  opened.push('hackbench.map-view:262')
  await expect(
    page.locator(`${root(0x106)} canvas[data-screen="0"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', drawn(0), { timeout: 15000 })
  expect(await scroller(0x106).evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual([0, 0])
  await expectEveryVisibleScreenDrawn(page, 0x106)
})

/**
 * The pixels actually on screen inside `locator`'s content box, read from a
 * screenshot: its scrollbar track and border are the theme's, not the map's,
 * so they are left out (inset 1px for the widget's focus outline).
 */
async function shownPixels(page, locator) {
  const box = await locator.evaluate(el => {
    const r = el.getBoundingClientRect()
    return { x: r.left + el.clientLeft + 1, y: r.top + el.clientTop + 1, width: el.clientWidth - 2, height: el.clientHeight - 2 } // prettier-ignore
  })
  const png = (await page.screenshot({ clip: box })).toString('base64')
  return page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    const colors = new Set()
    for (let i = 0; i < data.length; i += 4) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
    return { checksum: checksumOf(data), colors: colors.size, color: [...colors][0] }
  }, png)
}

/**
 * Every click paints the state it asks for, including a return to one
 * already seen (a cached screen): on a003f6c5 only the first change of
 * each toggle showed. Checked on the cell each toggle changes.
 */
for (const [index, control, screen, cell] of [
  [0x105, 'palace-yellow', 9, '12,20'],
  [0x014, 'palace-yellow', 0, null],
  [0x014, 'switch-blue', 0, '1,13'],
  [0x105, 'switch-blue', 0, null],
]) {
  test(`$${index.toString(16).padStart(3, '0')} ${control} paints every click, back and forth`, async ({
    page,
  }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    await showScreen(page, index, screen)
    const button = page.locator(`${root(index)} [data-control="${control}"]`)
    const canvas = page.locator(
      `${root(index)} canvas[data-screen="${screen}"][data-plane="l1Low"]`,
    )
    const want = on => {
      const palace = control === 'palace-yellow' && on ? 1 : 0
      const blue = control === 'switch-blue' && on ? 1 : 0
      return new RegExp(`^\\d+:${palace}000:${blue}00:${screen}$`)
    }
    const seen = {}
    let on = false
    for (let click = 0; click < 5; click++) {
      if (click > 0) {
        await button.click()
        on = !on
      }
      await expect(button).toHaveAttribute('aria-pressed', String(on))
      await expect(canvas).toHaveAttribute('data-drawn', want(on))
      const px = await readScreen(page, index, screen)
      if (seen[on] === undefined) seen[on] = px
      // A return to a state shows that state's picture exactly.
      else expect(px.checksum).toBe(seen[on].checksum)
    }
    if (cell) expect(seen[true].cells[cell]).not.toBe(seen[false].cells[cell])
  })
}

/** A reused tab changing orientation ($105 horizontal to $109 vertical) draws screen 0, never the old map. */
test('a reused tab going from a horizontal to a vertical map draws screen 0', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.evaluate(async mp => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:261')
    await w.open({ manifestPath: mp, index: 0x109, label: '109', iconClass: '' })
  }, project.manifestPath)
  opened.push('hackbench.map-view:265')
  await expect(
    page.locator(`${root(0x109)} canvas[data-screen="0"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', drawn(0), { timeout: 15000 })
  // Every canvas is blank or this map's: none holds a $105 picture.
  const marks = await page.locator(`${root(0x109)} canvas[data-screen]`).evaluateAll(cs => cs.map(c => c.dataset.drawn ?? null)) // prettier-ignore
  const current = await page.locator(`${root(0x109)} canvas[data-screen="0"][data-plane="l1Low"]`).getAttribute('data-drawn') // prettier-ignore
  const generation = current.split(':')[0]
  for (const m of marks) if (m !== null) expect(m.split(':')[0]).toBe(generation)
  const px = await readScreen(page, 0x109, 0)
  expect(px.distinct).toBeGreaterThan(1)
})

/**
 * The L1 (foreground) toggle: off shows only the level's backdrop (no L1
 * pixel on screen, and not the theme), on shows exactly the picture again.
 */
/**
 * A layer toggle is pressed, labelled with its layer and role, and drawn as a 16x16
 * frame with its glyph inside, both in the button's color (stroke, no fill).
 */
async function expectLayerToggle(page, index, control, label, glyph) {
  const button = page.locator(`${root(index)} [data-control="${control}"]`)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-label', label)
  await expect(button).toHaveAttribute('title', label)
  const art = await button.locator('svg').evaluate(svg => {
    const rect = svg.querySelector('rect')
    const path = svg.querySelector('path[data-part="glyph"]')
    const stroke = el => getComputedStyle(el).stroke
    const color = getComputedStyle(svg.closest('button')).color
    return {
      size: [svg.getAttribute('width'), svg.getAttribute('height')],
      frame: ['x', 'y', 'width', 'height', 'rx'].map(a => rect.getAttribute(a)),
      glyph: path.dataset.glyph,
      glyphDrawn: path.getAttribute('d').length > 10,
      strokes: [stroke(rect) === color, stroke(path) === color],
      fills: [getComputedStyle(rect).fill, getComputedStyle(path).fill],
      rects: svg.querySelectorAll('rect').length,
    }
  })
  expect(art.size).toEqual(['16', '16'])
  expect(art.frame).toEqual(['1.5', '1.5', '13', '13', '1.5'])
  expect(art.glyph).toBe(glyph)
  expect(art.glyphDrawn).toBe(true)
  expect(art.strokes).toEqual([true, true])
  expect(art.fills).toEqual(['none', 'none'])
  expect(art.rects, 'one frame, no bars').toBe(1)
  return button
}

test('the L1 toggle hides and restores the foreground, per tab', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await expectEveryVisibleScreenDrawn(page, 0x105)
  const l1 = await expectLayerToggle(page, 0x105, 'layer-l1', 'Layer 1 · Foreground', '1')
  const strip = page.locator(`${root(0x105)} [data-control="map-scroller"]`)

  const shown = await shownPixels(page, strip)
  expect(shown.colors).toBeGreaterThan(4)
  const backdrop = await backdropOf(page, 0x105)
  await l1.click()
  await expect(l1).toHaveAttribute('aria-pressed', 'false')
  // Both L1 planes hide, not just the low one; the background's stay.
  for (const plane of planeLocators(page, 0x105, 0))
    await expect(plane).toHaveCSS('visibility', 'hidden')
  for (const plane of planeLocators(page, 0x105, 0, ['l2Low', 'l2High']))
    await expect(plane).toHaveCSS('visibility', 'visible')
  // With the background and the sprites off as well, only the back area is left.
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  await page.locator(`${root(0x105)} [data-control="layer-sprites"]`).click()
  const hidden = await shownPixels(page, strip)
  expect(hidden.colors).toBe(1)
  expect(hidden.color).toBe(backdrop)

  await openMap(page, project.manifestPath, 0x106)
  await expect(page.locator(`${root(0x106)} [data-control="layer-l1"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
  await activate(page, 0x105)
  await l1.click()
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  await page.locator(`${root(0x105)} [data-control="layer-sprites"]`).click()
  await expect(l1).toHaveAttribute('aria-pressed', 'true')
  for (const plane of planeLocators(page, 0x105, 0, MAP_PLANES))
    await expect(plane).toHaveCSS('visibility', 'visible')
  // MAP_PLANES has no sprites plane: the restored sprites are checked on their own canvases (#589).
  const spriteCanvases = page.locator(`${root(0x105)} canvas[data-plane="sprites"]`)
  await expect(spriteToggle(page, 0x105)).toHaveAttribute('aria-pressed', 'true')
  await expect(spriteCanvases.first()).toHaveAttribute('data-drawn', SPRITES_DRAWN)
  for (let i = 0; i < (await spriteCanvases.count()); i++)
    await expect(spriteCanvases.nth(i)).toHaveCSS('visibility', 'visible')
  expect((await shownPixels(page, strip)).checksum).toBe(shown.checksum)
})

/**
 * The high plane is painted, not just present: $105 screen 9 has priority
 * tiles ($105 draws screens 9 and 18 in the high plane, measured on vanilla),
 * so the server's l1High has drawn pixels, and the high canvas must carry the
 * same alpha. Alpha only: a canvas readback premultiplies colour.
 */
test('the high canvas shows the served l1High plane on a screen with priority tiles', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showScreen(page, 0x105, 9)
  const flags = { green: false, yellow: false, blue: false, red: false }
  const switches = { blue: false, silver: false, onOff: false }
  const reply = await page.evaluate(
    ({ mp, flags, switches }) =>
      getSvc('Symbol(ProjectService)').mapScreen(mp, 0x105, 9, flags, switches),
    { mp: project.manifestPath, flags, switches },
  )
  expect(reply.status).toBe('ok')
  expect(reply.planes.l1High, 'the server draws a high plane on screen 9').not.toBeNull()
  const sel = `${root(0x105)} canvas[data-screen="9"][data-plane="l1High"]`
  await expect(page.locator(sel)).toHaveAttribute('data-drawn', drawn(9))
  const { served, shown, drawnPx } = await page.evaluate(
    ({ sel, b64 }) => {
      const c = document.querySelector(sel)
      const alpha = d => Array.from({ length: d.length / 4 }, (_, i) => d[i * 4 + 3])
      const shown = alpha(c.getContext('2d').getImageData(0, 0, c.width, c.height).data)
      const served = alpha(Uint8Array.from(atob(b64), ch => ch.charCodeAt(0)))
      return {
        served: served.join(','),
        shown: shown.join(','),
        drawnPx: shown.filter(a => a !== 0).length,
      }
    },
    { sel, b64: reply.planes.l1High },
  )
  expect(drawnPx, 'the high canvas has drawn pixels').toBeGreaterThan(0)
  expect(shown).toBe(served)
})

/**
 * The background (L2) is its own pair of planes, hidden and restored by its
 * own toggle, per tab. $105's background is an image, so its screen 0 has L2
 * pixels the view must show and then stop showing.
 */
test('the Background toggle hides and restores both L2 canvases, per tab', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await expectEveryVisibleScreenDrawn(page, 0x105)
  const l2 = await expectLayerToggle(page, 0x105, 'layer-l2', 'Layer 2 · Background', '2')
  const strip = page.locator(`${root(0x105)} [data-control="map-scroller"]`)
  // Fixed order, whatever the roles: Layer 1, Layer 2, Layer 3, Sprites.
  const order = await page
    .locator(`${root(0x105)} .hb-map-view-toolbar [data-control^="layer-"]`)
    .evaluateAll(bs => bs.map(b => b.dataset.control))
  expect(order).toEqual(['layer-l1', 'layer-l2', 'layer-l3', 'layer-sprites'])
  // The collision toggle (#435) follows the layer group, then a visible separator, then the first switch toggle, by DOM order.
  const sep = await page.evaluate(rootSel => {
    const bar = document.querySelector(`${rootSel} .hb-map-view-toolbar`)
    const kids = [...bar.children]
    const at = c => kids.findIndex(k => k.dataset.control === c)
    const el = kids.find(k => k.dataset.control === 'toolbar-sep')
    const r = el.getBoundingClientRect()
    return { between: at('collision-toggle') === at('layer-sprites') + 1 && at('toolbar-sep') === at('collision-toggle') + 1 && at('toolbar-sep') < at('palace-yellow'), w: r.width, h: r.height } // prettier-ignore
  }, root(0x105))
  expect(sep.between).toBe(true)
  expect(sep.w).toBeGreaterThan(0)
  expect(sep.h).toBeGreaterThan(0)

  const shown = await shownPixels(page, strip)
  await l2.click()
  await expect(l2).toHaveAttribute('aria-pressed', 'false')
  for (const plane of planeLocators(page, 0x105, 0, ['l2Low', 'l2High']))
    await expect(plane).toHaveCSS('visibility', 'hidden')
  for (const plane of planeLocators(page, 0x105, 0, ['l1Low', 'l1High']))
    await expect(plane).toHaveCSS('visibility', 'visible')
  // The picture changed: the background really was on screen.
  expect((await shownPixels(page, strip)).checksum).not.toBe(shown.checksum)

  await openMap(page, project.manifestPath, 0x106)
  await expect(page.locator(`${root(0x106)} [data-control="layer-l2"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
  for (const plane of planeLocators(page, 0x106, 0, ['l2Low', 'l2High']))
    await expect(plane).toHaveCSS('visibility', 'visible')
  await activate(page, 0x105)
  await l2.click()
  await expect(l2).toHaveAttribute('aria-pressed', 'true')
  for (const plane of planeLocators(page, 0x105, 0, ['l2Low', 'l2High']))
    await expect(plane).toHaveCSS('visibility', 'visible')
  expect((await shownPixels(page, strip)).checksum).toBe(shown.checksum)
})

/**
 * The color a pixel shows on screen: a 1 CSS px screenshot at its center,
 * from a spot whose 3x3 native neighborhood is uniform so scaling cannot blend it.
 */
async function colorOnScreen(page, selector, x, y) {
  const clip = await page.evaluate(
    ({ sel, x, y }) => {
      const c = document.querySelector(sel)
      const r = c.getBoundingClientRect()
      return { x: Math.floor(r.left + ((x + 0.5) * r.width) / c.width), y: Math.floor(r.top + ((y + 0.5) * r.height) / c.height), width: 1, height: 1 } // prettier-ignore
    },
    { sel: selector, x, y },
  )
  const png = (await page.screenshot({ clip })).toString('base64')
  return page.evaluate(async b64 => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = c.height = 1
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
  }, png)
}

test('L2 shows above the back area: a clear L1 pixel shows the background, not the back area', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showScreen(page, 0x105, 0)
  const sel = p => `${root(0x105)} canvas[data-screen="0"][data-plane="${p}"]`
  // A pixel where L2 is opaque and both L1 planes are clear, in a uniform 3x3.
  const spot = await page.evaluate(
    ({ l2, l1a, l1b }) => {
      const px = s => {
        const c = document.querySelector(s)
        return { w: c.width, h: c.height, d: c.getContext('2d').getImageData(0, 0, c.width, c.height).data } // prettier-ignore
      }
      const [b, f1, f2] = [px(l2), px(l1a), px(l1b)]
      const at = (g, x, y) => (y * g.w + x) * 4
      for (let y = 40; y < b.h - 40; y += 7)
        for (let x = 40; x < b.w - 40; x += 7) {
          let ok = true
          const first = [...b.d.slice(at(b, x, y), at(b, x, y) + 4)]
          for (let dy = -1; dy <= 1 && ok; dy++)
            for (let dx = -1; dx <= 1 && ok; dx++) {
              const i = at(b, x + dx, y + dy)
              ok = b.d[i + 3] === 255 && f1.d[i + 3] === 0 && f2.d[i + 3] === 0 && b.d[i] === first[0] && b.d[i + 1] === first[1] && b.d[i + 2] === first[2] // prettier-ignore
            }
          if (ok) return { x, y, rgb: first.slice(0, 3) }
        }
      return null
    },
    { l2: sel('l2Low'), l1a: sel('l1Low'), l1b: sel('l1High') },
  )
  expect(spot, '$105 screen 0 has a background pixel with L1 clear over it').not.toBeNull()
  const backdrop = (await backdropOf(page, 0x105)).split(',').map(Number)
  expect(spot.rgb, 'the background differs from the back area, or this proves nothing').not.toEqual(backdrop) // prettier-ignore
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2)
  expect(near(await colorOnScreen(page, sel('l1Low'), spot.x, spot.y), spot.rgb)).toBe(true)
  // With the background off the same pixel is the back area.
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  expect(near(await colorOnScreen(page, sel('l1Low'), spot.x, spot.y), backdrop)).toBe(true)
})

/**
 * A screen-0 plane stack, bottom to top (the sub screen's planes, then the main screen's), with each
 * plane's z-index. A plane in neither list has z-index 0 and is left out; the composite canvas is not a plane.
 */
const zStack = (page, index) =>
  page.locator(`${root(index)} canvas[data-screen="0"][data-plane]`).evaluateAll(cs =>
    cs
      .map(c => ({ plane: c.dataset.plane, z: Number(getComputedStyle(c).zIndex) }))
      .filter(c => c.z > 0)
      .sort((a, b) => a.z - b.z),
  )
const zOrder = async (page, index) => (await zStack(page, index)).map(c => c.plane)

/**
 * The plane order is the payload's `screens` (sub screen, then main screen): layer 2 under everything on a
 * standard layout, BG1 and BG2 together on the Mode 2 and 8 shape. Read from the computed z-index, not the source order. No
 * vanilla or magic-ROM slot draws an l2High pixel (swept: 0 of 488 maps each),
 * so there is no corpus screen to check the order on pixels; the unit tests
 * pin which plane a priority subtile lands in on synthetic data.
 */
test('the canvas stack puts layer 2 under everything on a standard-layout map, bottom to top', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  // $105 is mode 0 (main BG1, BG3, OBJ; sub BG2) with the BG3 priority bit clear.
  const stack = await zStack(page, 0x105)
  // The sprites sit between L1's low plane and its priority plane (#564).
  expect(stack.map(c => c.plane)).toEqual(['l2Low', 'l2High', 'l3Low', 'l3High', 'l1Low', 'sprites', 'l1High']) // prettier-ignore
  expect(new Set(stack.map(c => c.z)).size, 'seven distinct levels').toBe(7)
  expect(stack[0].z).toBeGreaterThan(0)
  // $0E7 is mode 8 (interactive layer 2): BG1, BG2 and BG3 all on the main screen, BG3 behind (bit clear).
  await openMap(page, project.manifestPath, 0xe7)
  expect(await zOrder(page, 0xe7)).toEqual([
    'l3Low',
    'l3High',
    'l2Low',
    'l1Low',
    'l2High',
    'sprites',
    'l1High',
  ])
})

/** The composite of every visible plane over the box that layer 3's own pixels fill on screen 0. */
async function layer3Region(page, index, box) {
  return page.evaluate(
    ({ rootSel, box }) => {
      const planes = planesOf(rootSel, 0)
      if (!box) {
        const l3 = [...document.querySelectorAll(`${rootSel} canvas[data-screen="0"][data-plane^="l3"]`)] // prettier-ignore
        let [x0, y0, x1, y1] = [1e9, 1e9, -1, -1]
        for (const c of l3) {
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) continue
            const [x, y] = [(i / 4) % c.width, Math.floor(i / 4 / c.width)]
            ;[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)]
          }
        }
        box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
      }
      return { box, pixels: Array.from(composeCanvases(planes, box.x, box.y, box.w, box.h)) }
    },
    { rootSel: root(index), box },
  )
}

const l3Toggle = (page, index) => page.locator(`${root(index)} [data-control="layer-l3"]`)

/**
 * Layer 3 (#561), on vanilla maps measured from the ROM: $002 is a tide with the header's BG3
 * priority bit set (an overlay: its band is in l3High, drawn over layer 1, at the foot of every
 * screen), $01F is a cage with the bit clear (a background: l3High under l1Low), $105 has no
 * layer 3 ($009, an interactive layer 2 map, has its own tests below).
 */
for (const [index, role, bit, known] of [
  // known: the top-left of layer 3's box on screen 0, and its first opaque pixel in raster order with
  // that pixel's color (outline black), then a non-black pixel. $01F's is BG3 palette 3, its crusher
  // color 15 (gold, the castle_crusher palette's last entry; without the crusher colors the same pixel is
  // [255,90,90]), so a wrong palette fails.
  // All measured from the backend's planes.
  [
    0x002,
    'Layer 3 · Overlay',
    true,
    {
      box: { x: 0, y: 384 },
      pixel: { x: 15, y: 384 },
      rgba: [0, 0, 0, 255],
      color: { pixel: { x: 15, y: 385 }, rgba: [255, 255, 255, 255] },
    },
  ],
  [
    0x01f,
    'Layer 3 · Background',
    false,
    {
      box: { x: 56, y: 48 },
      pixel: { x: 64, y: 48 },
      rgba: [0, 0, 0, 255],
      color: { pixel: { x: 80, y: 48 }, rgba: [222, 165, 57, 255] },
    },
  ],
]) {
  test(`$${index.toString(16).padStart(3, '0')}: the Layer 3 toggle (${role}) changes the layer 3 region's pixels and restores them`, async ({
    page,
  }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    const button = l3Toggle(page, index)
    await expect(button).toBeEnabled()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(button).toHaveAttribute('title', role)
    // The bit places BG3's high plane: over layer 1 when set, under layer 1's low plane when clear.
    const order = await zOrder(page, index)
    const at = k => order.indexOf(k)
    expect(at('l2High')).toBeLessThan(at('l3Low'))
    expect(at('l3High') > at('l1High')).toBe(bit)
    expect(at('l3High') < at('l1Low')).toBe(!bit)

    const before = await layer3Region(page, index)
    expect(before.box.w * before.box.h, 'layer 3 draws pixels on screen 0').toBeGreaterThan(0)
    // A known layer 3 pixel: where the region starts, opaque in l3High; over layer 1 it is the shown color.
    expect({ x: before.box.x, y: before.box.y }).toEqual(known.box)
    const own = await page.locator(`${root(index)} canvas[data-screen="0"][data-plane="l3High"]`).evaluate((c, p) => Array.from(c.getContext('2d').getImageData(p.x, p.y, 1, 1).data), known.pixel) // prettier-ignore
    expect(own, 'layer 3 pixel and color at the known position').toEqual(known.rgba)
    const tinted = await page.locator(`${root(index)} canvas[data-screen="0"][data-plane="l3High"]`).evaluate((c, p) => Array.from(c.getContext('2d').getImageData(p.x, p.y, 1, 1).data), known.color.pixel) // prettier-ignore
    expect(tinted, 'a non-black layer 3 pixel, from the right palette').toEqual(known.color.rgba)
    if (bit) {
      const at =
        ((known.pixel.y - before.box.y) * before.box.w + (known.pixel.x - before.box.x)) * 4
      expect(before.pixels.slice(at, at + 4), 'an overlay pixel shows its own color').toEqual(own)
    }
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    for (const plane of planeLocators(page, index, 0, ['l3Low', 'l3High']))
      await expect(plane).toHaveCSS('visibility', 'hidden')
    const hidden = await layer3Region(page, index, before.box)
    const changed = hidden.pixels.filter((v, i) => v !== before.pixels[i]).length
    expect(changed, 'hiding layer 3 changes the pixels it covered').toBeGreaterThan(0)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    const back = await layer3Region(page, index, before.box)
    expect(back.pixels).toEqual(before.pixels)
  })
}

/**
 * The toggle look (option D): pressed is a filled chip with a 1px border, off has neither (a transparent
 * 1px border, so the box does not move), and a mouse click leaves no focus ring while Tab shows one.
 */
test('a layer toggle is a chip when pressed, bare when off, and rings only for the keyboard', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const button = page.locator(`${root(0x105)} [data-control="layer-l1"]`)
  const look = () =>
    button.evaluate(b => {
      const cs = getComputedStyle(b)
      const r = b.getBoundingClientRect()
      return { bg: cs.backgroundColor, border: [cs.borderTopWidth, cs.borderTopColor], outline: [cs.outlineStyle, cs.outlineWidth], ring: b.matches(':focus-visible'), size: [r.width, r.height] } // prettier-ignore
    })
  const clear = 'rgba(0, 0, 0, 0)'
  const on = await look()
  expect(on.bg, 'pressed has a fill').not.toBe(clear)
  expect(on.bg, 'and it is not the old accent tint').not.toMatch(/^rgba\(91, 156, 246/)
  expect(on.border[0]).toBe('1px')
  expect(on.border[1], 'a visible border').not.toBe(clear)

  await button.click() // a mouse click: off, no ring
  await expect(button).toHaveAttribute('aria-pressed', 'false')
  // The pointer is still over the button, so the hover fill applies: that is the designed hover.
  expect((await look()).bg, 'off under the pointer shows the hover fill').not.toBe(clear)
  await page.mouse.move(2, 2) // away from the button
  await expect.poll(async () => (await look()).bg).toBe(clear)
  const off = await look()
  expect(off.bg, 'off has no fill').toBe(clear)
  expect(off.border, 'off keeps a transparent 1px border').toEqual(['1px', clear])
  expect(off.size, 'the box does not shift').toEqual(on.size)
  expect(off.ring, 'a mouse click is not focus-visible').toBe(false)
  expect(off.outline[0]).toBe('none')

  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab') // back onto the button, from the keyboard
  const keyed = await look()
  expect(keyed.ring, 'keyboard focus is focus-visible').toBe(true)
  expect(keyed.outline[0]).not.toBe('none')
})

/**
 * Screen 0's first pixel where `want` holds, as [x, y], or null. `want` is an expression over the
 * alphas of layer 1, layer 2 and layer 3 (each the larger of its low and high plane), e.g. `a3 && !a1`.
 * Read from the plane canvases, the compositor's source.
 */
const findPixel = (page, index, want) =>
  page.evaluate(
    ({ rootSel, want }) => {
      const cv = p =>
        document.querySelector(`${rootSel} canvas[data-screen="0"][data-plane="${p}"]`)
      const alphas = ps => {
        const ds = ps.map(p => cv(p).getContext('2d').getImageData(0, 0, cv(p).width, cv(p).height).data) // prettier-ignore
        return i => Math.max(...ds.map(d => d[i * 4 + 3]))
      }
      const [a1, a2, a3] = [['l1Low', 'l1High'], ['l2Low', 'l2High'], ['l3Low', 'l3High']].map(alphas) // prettier-ignore
      const test = new Function('a1', 'a2', 'a3', `return (${want})`)
      const { width, height } = cv('l1Low')
      for (let i = 0; i < width * height; i++) {
        if (test(a1(i), a2(i), a3(i))) return [i % width, Math.floor(i / width)]
      }
      return null
    },
    { rootSel: root(index), want },
  )

/** RGBA at a pixel of screen 0's composite (what the user sees) or of one plane. */
const pixelOf = (page, index, which, [x, y]) =>
  page.evaluate(
    ({ rootSel, which, x, y }) => {
      const sel = which === 'composite' ? 'canvas[data-layer="screen"][data-screen="0"]' : `canvas[data-screen="0"][data-plane="${which}"]` // prettier-ignore
      const c = document.querySelector(`${rootSel} ${sel}`)
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data)
    },
    { rootSel: root(index), which, x, y },
  )

/** The layer 3 plane (low or high) that has an opaque pixel here. */
const l3Own = async (page, index, at) => {
  const [low, high] = [await pixelOf(page, index, 'l3Low', at), await pixelOf(page, index, 'l3High', at)] // prettier-ignore
  return low[3] !== 0 ? low : high
}

test('a map with no layer 3 disables the toggle and says why', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const none = l3Toggle(page, 0x105)
  await expect(none).toBeDisabled()
  await expect(none).toHaveAttribute('title', 'This map has no layer 3')
})

/**
 * $018 is mode 0E (BG3 alone on the main screen, BG1 and BG2 on the sub screen), where layer 3 would
 * add onto layers 1 and 2. Its layer 3 is camera-locked (settings byte $81 on tileset 13, #563), so it
 * is not drawn yet: this pins the gap. The add itself is covered by the synthetic mode 0E tests in
 * ColorMath.test.ts, until #563 draws the layer and a pixel-level check can replace this one.
 */
test('$018: layer 3 is camera-locked, so its toggle is disabled and says so', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x018)
  const locked = l3Toggle(page, 0x018)
  await expect(locked).toBeDisabled()
  await expect(locked).toHaveAttribute('aria-pressed', 'false')
  await expect(locked).toHaveAttribute('title', 'Layer 3 not drawn yet: camera-locked layer 3')
  // The plane lists still follow the mode: layers 1 and 2 on the sub screen, layer 3 alone on main,
  // and the sprites just under layer 1's priority plane (#564).
  expect(await zOrder(page, 0x018)).toEqual(['l2Low', 'l1Low', 'l2High', 'sprites', 'l1High', 'l3Low', 'l3High']) // prettier-ignore
  // No layer 3 pixels at all.
  expect(await findPixel(page, 0x018, 'a3 > 0')).toBeNull()
  // A disabled toggle does nothing when forced: state and planes stay as they were.
  await locked.click({ force: true })
  await expect(locked).toHaveAttribute('aria-pressed', 'false')
  expect(await findPixel(page, 0x018, 'a3 > 0')).toBeNull()
  for (const plane of planeLocators(page, 0x018, 0, ['l2Low', 'l1Low', 'l2High', 'l1High']))
    await expect(plane).toHaveCSS('visibility', 'visible')
})

/**
 * The sprite layer (#564), drawn by the sprite interpreter (#585). $106 holds both kinds on vanilla:
 * sprites the ROM's own INIT and MAIN draw (21 of 25) and ids the interpreter refuses (marked, with its
 * reason). Its sprites sit past screen 0, so screen 1 is scrolled into view. $105 draws 31 of 34.
 */
const spriteToggle = (page, index) => page.locator(`${root(index)} [data-control="layer-sprites"]`)
const spritePlane = (page, index, screen) =>
  page.locator(`${root(index)} canvas[data-screen="${screen}"][data-plane="sprites"]`)
const SPRITES_DRAWN = /^\d+:\d+$/

test('the sprite toggle hides and restores the sprites, and changes what is on screen', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  await showScreen(page, 0x106, 1)
  const sprites = await expectLayerToggle(page, 0x106, 'layer-sprites', 'Sprites', 'S')
  await expect(sprites).toBeEnabled()
  await expect(spritePlane(page, 0x106, 1)).toHaveAttribute('data-drawn', SPRITES_DRAWN)
  const strip = page.locator(`${root(0x106)} [data-control="map-scroller"]`)

  const shown = await shownPixels(page, strip)
  await sprites.click()
  await expect(sprites).toHaveAttribute('aria-pressed', 'false')
  for (const screen of [0, 1, 2])
    await expect(spritePlane(page, 0x106, screen)).toHaveCSS('visibility', 'hidden')
  // The terrain stays: the picture changed only by the sprites' pixels.
  for (const plane of planeLocators(page, 0x106, 1))
    await expect(plane).toHaveCSS('visibility', 'visible')
  expect((await shownPixels(page, strip)).checksum).not.toBe(shown.checksum)
  await sprites.click()
  await expect(sprites).toHaveAttribute('aria-pressed', 'true')
  await expect(spritePlane(page, 0x106, 1)).toHaveCSS('visibility', 'visible')
  expect((await shownPixels(page, strip)).checksum).toBe(shown.checksum)
})

test('an interpreter-drawn sprite shows its own pixels where the service placed it; a miss shows a marker', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  await showScreen(page, 0x106, 1)
  await expect(spritePlane(page, 0x106, 1)).toHaveAttribute('data-drawn', SPRITES_DRAWN)
  const reply = await page.evaluate(
    mp => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x106),
    project.manifestPath,
  )
  expect(reply.status).toBe('ok')
  expect(reply.sprites).toHaveLength(25)
  expect(reply.sprites.filter(s => s.status === 'drawn')).toHaveLength(21)
  const inScreen1 = s => s.box.x0 >= 256 && s.box.x1 <= 512 && s.box.y0 >= 0 && s.box.y1 <= 432
  // Measured on vanilla: the first $05 is at tile (27, 20), a 16 x 32 body whose top is above its anchor.
  const koopa = reply.sprites.find(s => s.id === 5)
  expect(koopa).toMatchObject({ x: 432, y: 320, status: 'drawn' })
  expect(koopa.box).toEqual({ x0: 432, y0: 304, x1: 448, y1: 336 })
  const marker = reply.sprites.find(s => s.status === 'placeholder' && inScreen1(s))
  expect(marker, 'a marker inside screen 1').toBeTruthy()
  // The interpreter's own words: sprite $DB is past the ROM's 201-entry pointer table.
  expect(marker.reason).toMatch(/^refused: INIT: id \$db is past the 201-entry pointer table/)

  const read = await page.evaluate(
    ({ koopa, marker }) => {
      const c = document.querySelector(
        '[id="hackbench.map-view:262"] canvas[data-screen="1"][data-plane="sprites"]',
      )
      const ctx = c.getContext('2d')
      const cut = s => {
        const w = s.box.x1 - s.box.x0
        const h = s.box.y1 - s.box.y0
        const got = ctx.getImageData(s.box.x0 - 256, s.box.y0, w, h).data
        const want = Uint8Array.from(atob(s.rgba), ch => ch.charCodeAt(0))
        // Alpha and opaque colors only: a readback premultiplies translucent pixels.
        let same = true
        let opaque = 0
        for (let i = 0; i < want.length; i += 4) {
          if (got[i + 3] !== want[i + 3]) same = false
          if (want[i + 3] !== 255) continue
          opaque++
          if (got[i] !== want[i] || got[i + 1] !== want[i + 1] || got[i + 2] !== want[i + 2])
            same = false
        }
        return { same, opaque, corner: Array.from(got.slice(0, 4)), inBox: 0 }
      }
      const abs = ctx.getImageData(432 - 256, 304, 16, 32).data
      let inBox = 0
      for (let i = 3; i < abs.length; i += 4) if (abs[i] !== 0) inBox++
      return { koopa: { ...cut(koopa), inBox }, marker: cut(marker) }
    },
    { koopa, marker },
  )
  expect(read.koopa.opaque, 'the interpreter drew pixels').toBeGreaterThan(0)
  expect(read.koopa.inBox, 'canvas pixels inside the absolute box (432,304)-(448,336)').toBeGreaterThan(0) // prettier-ignore
  expect(read.koopa.same, 'the canvas holds the served bitmap at its box').toBe(true)
  expect(read.marker.same).toBe(true)
  // The marker is 16 x 16 at the anchor, its frame the editor blue.
  expect([marker.box.x1 - marker.box.x0, marker.box.y1 - marker.box.y0]).toEqual([16, 16])
  expect(read.marker.corner).toEqual([90, 200, 255, 255])
})

test('$4F on $105 is served at its stream position plus the (8, -1) its INIT adds', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const reply = await page.evaluate(
    mp => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x105),
    project.manifestPath,
  )
  expect(reply.status).toBe('ok')
  expect(reply.sprites.filter(s => s.status === 'drawn')).toHaveLength(31)
  // Stream positions (1808, 336), (2224, 320), (4544, 320): measured on vanilla, absolute.
  const fours = reply.sprites.filter(s => s.id === 0x4f)
  expect(fours.map(s => [s.x, s.y, s.status])).toEqual([
    [1816, 335, 'drawn'],
    [2232, 319, 'drawn'],
    [4552, 319, 'drawn'],
  ])
})

test('a sprite stream with no end marker shows its note on the map tab', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  const note = page.locator(`${root(0x106)} [data-note="sprites"]`)
  // After load: the toggle is enabled (React rendered the reply) and the canvas has drawn.
  await expect(spriteToggle(page, 0x106)).toBeEnabled()
  await expect(spritePlane(page, 0x106, 1)).toHaveAttribute('data-drawn', SPRITES_DRAWN)
  await expect(note).toHaveCount(0)
  // Serve the same sprites with the truncation note, as a stream cut by the ROM's end would.
  await page.evaluate(async () => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:262')
    const real = w.projects
    w.projects = {
      mapDetails: (...a) => real.mapDetails(...a),
      mapScreen: (...a) => real.mapScreen(...a),
      mapPalaceIcons: (...a) => real.mapPalaceIcons(...a),
      mapSprites: async (...a) => ({
        ...(await real.mapSprites(...a)),
        note: 'no end marker (test)',
      }),
    }
    w.refresh()
  })
  await expect(note).toHaveText('no end marker (test)')
  await expect(note).toBeVisible()
})

test('the sprite toggle is disabled with its reason on a map without sprites', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x108)
  const sprites = spriteToggle(page, 0x108)
  await expect(sprites).toBeDisabled()
  await expect(sprites).toHaveAttribute('aria-pressed', 'false')
  await expect(sprites).toHaveAttribute('title', 'Sprites · this map has none')
})

/**
 * $009 is mode 2 (an interactive layer 2 map: BG1, BG2 and BG3 on the main screen) with BG3's priority
 * bit clear, so layer 3 sits behind layers 1 and 2. Measured on vanilla, screen 0: 3492 pixels are layer
 * 3 alone and 948 are layer 3 under layer 1.
 */
test('$009: layer 3 draws behind layers 1 and 2, and its toggle is enabled', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x009)
  const button = l3Toggle(page, 0x009)
  await expect(button).toBeEnabled()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('title', 'Layer 3 · Background')

  // Where layers 1 and 2 are empty, layer 3 is what shows.
  const alone = await findPixel(page, 0x009, 'a3 > 0 && a1 === 0 && a2 === 0')
  expect(alone, 'a pixel with layer 3 alone').not.toBeNull()
  expect(await pixelOf(page, 0x009, 'composite', alone)).toEqual(await l3Own(page, 0x009, alone))

  // Where layer 1 is over it, layer 1 shows, not layer 3.
  const under = await findPixel(page, 0x009, 'a3 > 0 && a1 > 0 && a2 === 0')
  expect(under, 'a pixel with layer 3 under layer 1').not.toBeNull()
  const l1Own = (await pixelOf(page, 0x009, 'l1Low', under))[3] ? await pixelOf(page, 0x009, 'l1Low', under) : await pixelOf(page, 0x009, 'l1High', under) // prettier-ignore
  const covered = await pixelOf(page, 0x009, 'composite', under)
  expect(covered).toEqual(l1Own)
  expect(covered).not.toEqual(await l3Own(page, 0x009, under))

  // Layer 1 off: the layer 3 pixel returns where layer 1 covered it.
  await page.locator(`${root(0x009)} [data-control="layer-l1"]`).click()
  await expect
    .poll(async () => pixelOf(page, 0x009, 'composite', under))
    .toEqual(await l3Own(page, 0x009, under))
})

/**
 * Layer 2's role follows the level mode's VerticalTable bit 7 (bank_00.asm:11736-11738), not whether the map
 * has a layer 3: $009 and $0E7 (modes 2 and 8) are the interactive foreground; $105 (mode 0), $018 and $10E
 * (mode 11, BG2 on the main screen but bit 7 clear) are background.
 */
test('the layer 2 tooltip names its role from the level mode', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  const expected = [
    [0x009, 'Layer 2 · Foreground'],
    [0x0e7, 'Layer 2 · Foreground'],
    [0x105, 'Layer 2 · Background'],
    [0x018, 'Layer 2 · Background'],
    [0x10e, 'Layer 2 · Background'],
  ]
  for (const [index, title] of expected) {
    await openMap(page, project.manifestPath, index)
    await expect(page.locator(`${root(index)} [data-control="layer-l2"]`), `$${index.toString(16)}`).toHaveAttribute('title', title) // prettier-ignore
  }
})

/**
 * On a standard-layout map the compositor changes nothing: the main-screen backdrop is black (CGRAM color 0 is
 * cleared, bank_00.asm:2046-2049), CGADSUB $24 minus BG3 lets only the backdrop add the sub screen (layer 2), and
 * the back area is the fixed color, which only shows where nothing draws (transparent, so the back area layer
 * shows). Layer 2 is therefore not tinted by the back area. The composite must equal the topmost plane pixel in the
 * #561 order, on a sample spread over the whole screen. $002 is mode 0 with layer 3 drawn and the priority bit
 * set, so BG3's high plane is in front of layer 1.
 */
test('a standard-layout map: the composite equals the plane stack', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x002)
  const order = ['l2Low', 'l2High', 'l3Low', 'l1Low', 'sprites', 'l1High', 'l3High']
  expect(await zOrder(page, 0x002)).toEqual(order)
  // The sprites arrive after the planes; the composite repaints with them, so wait for them.
  await expect(page.locator(`${root(0x002)} canvas[data-screen="0"][data-plane="sprites"]`)).toHaveAttribute('data-drawn', /^\d+:\d+$/) // prettier-ignore
  const result = await page.evaluate(
    ({ rootSel, order }) => {
      const read = sel => {
        const c = document.querySelector(`${rootSel} ${sel}`)
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      }
      const planes = order.map(p => read(`canvas[data-screen="0"][data-plane="${p}"]`))
      const comp = read('canvas[data-layer="screen"][data-screen="0"]')
      const pixels = comp.length / 4
      const step = Math.floor(pixels / 200)
      const bad = []
      let opaque = 0
      let sampled = 0
      for (let i = 0; i < pixels; i += step) {
        sampled++
        const top = planes.filter(d => d[i * 4 + 3] !== 0).pop()
        const got = Array.from(comp.slice(i * 4, i * 4 + 4))
        if (!top) {
          if (got[3] !== 0) bad.push({ i, got, want: 'transparent' })
          continue
        }
        opaque++
        const want = Array.from(top.slice(i * 4, i * 4 + 4))
        if (got.join() !== want.join()) bad.push({ i, got, want })
      }
      return { bad: bad.slice(0, 5), sampled, opaque }
    },
    { rootSel: root(0x002), order },
  )
  expect(result.sampled).toBeGreaterThanOrEqual(200)
  expect(result.opaque, 'the sample covers drawn pixels, not only empty ones').toBeGreaterThan(20)
  expect(result.bad).toEqual([])
})

test('a map the ROM reads fully carries no layer note', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await expect(page.locator(`${root(0x105)} [data-note="layers"]`)).toHaveCount(0)
})

/**
 * $0E7's L2 (an object stream, tileset 1) draws Map16 tile 349 under L1's tile 352 at column 0,
 * row 13 (measured on vanilla); both are opaque at pixel (3, 211) of screen 0, both low priority.
 * Setting tile 349's top-left priority bit in the working copy moves that quadrant to l2High,
 * which BG mode 1 stacks over l1Low: the pixel shown must turn into L2's. The composite is read
 * from the composite canvas, which stacks the planes by the payload's lists, so reordering them turns this red.
 */
test('an L2 priority tile draws over an L1 low tile, from a working-copy edit', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0xe7)
  const spot = { x: 3, y: 13 * 16 + 3 }
  const read = () =>
    page.evaluate(
      ({ rootSel, spot }) => {
        const px = c => Array.from(c.getContext('2d').getImageData(spot.x, spot.y, 1, 1).data)
        const planes = planesOf(rootSel, 0)
        // The source plane canvases; planesOf is the composite only.
        const by = k => document.querySelector(`${rootSel} canvas[data-screen="0"][data-plane="${k}"]`) // prettier-ignore
        const shown = composeCanvases(planes, spot.x, spot.y, 1, 1)
        return { shown: Array.from(shown), l1Low: px(by('l1Low')), l2High: px(by('l2High')) }
      },
      { rootSel: root(0xe7), spot },
    )
  const before = await read()
  expect(before.l1Low[3], 'L1 is opaque there').toBe(255)
  expect(before.l2High[3], 'no L2 priority yet').toBe(0)
  expect(before.shown).toEqual(before.l1Low)

  const edit = await page.evaluate(
    ({ mp }) =>
      getSvc('Symbol(Map16Service)').setQuadrantField(mp, 1, 'fg', { bg: 0, fg: 0 }, 349, 'tl', 'priority', true), // prettier-ignore
    { mp: project.manifestPath },
  )
  expect(edit.status).toBe('ok')
  await expect.poll(async () => (await read()).l2High[3], { timeout: 15000 }).toBe(255)
  const after = await read()
  expect(after.shown, 'the pixel is L2 priority color').toEqual(after.l2High)
  expect(after.shown).not.toEqual(after.l1Low)
})

/**
 * The back area is a layer of its own, between the checkerboard and L1: L1
 * is clear where no tile draws, so hiding the back area (as a layer toggle
 * will) shows the checkerboard there, not a color baked into L1.
 */
test('the back area is its own layer, with the checkerboard beneath it', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showScreen(page, 0x105, 0)
  // The background image sits over the back area, so it goes too.
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  await page
    .locator(`${root(0x105)} [data-layer="back-area"]`)
    .evaluate(el => (el.style.display = 'none'))
  await expectCheckerboard(
    expect,
    page,
    `${root(0x105)} canvas[data-screen="0"][data-plane="l1Low"]`,
    [`${root(0x105)} canvas[data-screen="0"][data-plane="l1High"]`],
  )
})

/**
 * The rule both ways (#621): $12C's $094 cells are drawn with ON/OFF off and
 * blank with it on, so on they show their off picture at 25% in the screen
 * door, over the back area layer. Measured on vanilla: 38 such cells; the one
 * at column 85, row 5 (screen 5, local column 5) changes 16 pixels, all on
 * the dim squares, each within 64 of the backdrop.
 */
test('a tile ON/OFF blanks shows in the screen door on $12C with ON/OFF on', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x12c)
  await showScreen(page, 0x12c, 5)
  const cell = async () => {
    const px = await readScreen(page, 0x12c, 5)
    const out = []
    for (let y = 5 * 16; y < 6 * 16; y++)
      for (let x = 5 * 16; x < 6 * 16; x++) out.push(px.rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4).join(',')) // prettier-ignore
    return out
  }
  const off = await cell()
  await page.locator(`${root(0x12c)} [data-control="switch-onOff"]`).click()
  await expect(page.locator(`${root(0x12c)} canvas[data-screen="5"][data-plane="l1Low"]`)).toHaveAttribute('data-drawn', /^\d+:0000:001:5$/) // prettier-ignore
  const on = await cell()
  expect(on).not.toEqual(off)
  const count = p => on.filter(q => q === p).length
  const backdrop = [...on]
    .sort((a, b) => count(b) - count(a))[0]
    .split(',')
    .map(Number)
  expect(new Set(on).size).toBeGreaterThan(1) // not simply gone
  // $094 is a one-pixel diagonal whose 16 pixels all fall on odd squares
  // (measured), so here the screen door shows only its dim half.
  expectScreenDoor(
    on.map(p => p.split(',').map(Number)),
    backdrop,
    false,
  )
})

/** The back area layer's color, "r,g,b", as the view paints it. */
const backdropOf = (page, index) =>
  page
    .locator(`${root(index)} [data-layer="back-area"]`)
    .evaluate(el => getComputedStyle(el).backgroundColor.match(/\d+/g).slice(0, 3).join(','))

/**
 * A Back Area palette edit reaches the strip's own background, which is what
 * shows with L1 hidden. $105 uses back-area color 2, the word at $00B0A4
 * (PaletteLoader ADDR_BACK_AREA plus 2 x 2; vanilla $5D80, measured).
 */
test('a back-area color edit repaints the strip behind a hidden L1 and L2', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const screen0 = page.locator(`${root(0x105)} canvas[data-screen="0"][data-plane="l1Low"]`)
  const drawnBefore = await screen0.getAttribute('data-drawn')
  const rom = fs.readFileSync(ROM)
  const at = (rom.length % 1024 === 512 ? 512 : 0) + (0x00b0a4 & 0x7fff)
  const oldHex = '$' + (rom[at] | (rom[at + 1] << 8)).toString(16).toUpperCase().padStart(4, '0')
  expect(oldHex).not.toBe('$03E0')
  const result = await page.evaluate(
    async ({ mp, oldHex }) =>
      getSvc('Symbol(PaletteService)').setColor(mp, 0x00b0a4, oldHex, '$03E0'),
    { mp: project.manifestPath, oldHex },
  )
  expect(result.status).toBe('ok')
  await expect
    .poll(() => screen0.getAttribute('data-drawn'), { timeout: 15000 })
    .not.toBe(drawnBefore)
  await page.locator(`${root(0x105)} [data-control="layer-l1"]`).click()
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  await page.locator(`${root(0x105)} [data-control="layer-sprites"]`).click()
  const hidden = await shownPixels(
    page,
    page.locator(`${root(0x105)} [data-control="map-scroller"]`),
  )
  expect(hidden.colors).toBe(1)
  expect(hidden.color).toBe('0,255,0') // $03E0, BGR555 green, widened as the app does
})

/**
 * A toggle keeps the current picture up until the new one lands: sampled
 * right after the click, before the new `data-drawn`, the screen is never
 * blank (transparent) or backdrop-only.
 */
test('a palace toggle never flashes the screen blank', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showScreen(page, 0x105, 9)
  await page.locator(`${root(0x105)} [data-control="palace-yellow"]`).click()
  const px = await readScreen(page, 0x105, 9)
  expect(px.rgba.filter((v, i) => i % 4 === 3 && v !== 255)).toHaveLength(0)
  expect(px.distinct).toBeGreaterThan(2)
  await showScreen(page, 0x105, 9, true)
})

test('opening a map draws real pixels, and two maps differ', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const a = await readScreen(page, 0x105, 0)
  expect(a.distinct).toBeGreaterThan(4)

  await openMap(page, project.manifestPath, 0x106)
  const b = await readScreen(page, 0x106, 0)
  expect(b.distinct).toBeGreaterThan(4)
  expect(b.checksum).not.toBe(a.checksum)
})

test('a one-screen map draws its one screen and asks for no other', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x0bd)
  await expect(page.locator(`${root(0x0bd)} canvas[data-plane="l1Low"]`)).toHaveCount(1)
  expect((await readScreen(page, 0x0bd, 0)).distinct).toBeGreaterThan(4)
  await expect(page.locator(`${root(0x0bd)} [data-control="map-error"]`)).toHaveCount(0)
})

test('a palette edit recolors exactly the pixels of that color, with no reload', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const before = await readScreen(page, 0x105, 0)
  const screen0 = page.locator(`${root(0x105)} canvas[data-screen="0"][data-plane="l1Low"]`)
  const drawnBefore = await screen0.getAttribute('data-drawn')

  // The word the ROM holds now, read from the file rather than assumed.
  const rom = fs.readFileSync(ROM)
  const base = rom.length % 1024 === 512 ? 512 : 0
  const at = base + (FG_COLOR_ADDR & 0x7fff)
  const word = rom[at] | (rom[at + 1] << 8)
  const oldHex = '$' + word.toString(16).toUpperCase().padStart(4, '0')
  expect(oldHex).not.toBe(NEW_HEX)
  const expand = w => [w & 31, (w >> 5) & 31, (w >> 10) & 31].map(c => (c << 3) | (c >> 2))
  const oldRgb = expand(word).join(',')
  const newRgb = expand(parseInt(NEW_HEX.slice(1), 16)).join(',')

  const result = await page.evaluate(
    async ({ mp, addr, oldHex, newHex }) =>
      getSvc('Symbol(PaletteService)').setColor(mp, addr, oldHex, newHex),
    { mp: project.manifestPath, addr: FG_COLOR_ADDR, oldHex, newHex: NEW_HEX },
  )
  expect(result.status).toBe('ok')

  // No open() or refresh here: the working-copy push must repaint it. The old
  // picture stays up while the reply is in flight, so wait for the new paint.
  await expect
    .poll(() => screen0.getAttribute('data-drawn'), { timeout: 15000 })
    .toMatch(new RegExp(`^(?!${drawnBefore}$)\\d+:0000:000:0$`))
  const after = await readScreen(page, 0x105, 0)

  let changed = 0
  for (let i = 0; i < before.rgba.length; i += 4) {
    const was = before.rgba.slice(i, i + 3).join(',')
    const now = after.rgba.slice(i, i + 3).join(',')
    if (was === now) continue
    changed++
    // Only pixels of the edited color move, and they all become the new one.
    expect(was).toBe(oldRgb)
    expect(now).toBe(newRgb)
  }
  expect(changed).toBeGreaterThan(0)
})

test('toggling the yellow palace on $105 changes exactly the switch-block cells', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const yellow = page.locator(`${root(0x105)} [data-control="palace-yellow"]`)
  await expect(yellow).toHaveAttribute('aria-pressed', 'false')

  await showScreen(page, 0x105, 9)
  const before = await readScreen(page, 0x105, 9)

  await yellow.click()
  await expect(yellow).toHaveAttribute('aria-pressed', 'true')
  await showScreen(page, 0x105, 9, true)
  const after = await readScreen(page, 0x105, 9)

  // Column 156 is screen 9's local column 12; nothing else on it moves,
  // including a far cell on the same row.
  expect(changedCells(before, after)).toEqual(['12,20'])
  expect(after.cells['0,20']).toBe(before.cells['0,20'])

  await yellow.click()
  await showScreen(page, 0x105, 9)
  expect((await readScreen(page, 0x105, 9)).checksum).toBe(before.checksum)
})

test('each palace toggle shows its own block, dotted then solid', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const icon = p =>
    page.locator(`${root(0x105)} [data-control="palace-${p}"] canvas`).evaluate(c => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      return checksumOf(d)
    })
  // Blank at the canvas's own size: PixelImageButton scales the 16x16 art.
  const blank = await page
    .locator(`${root(0x105)} [data-control="palace-yellow"] canvas`)
    .evaluate(c => checksumOf(new Uint8ClampedArray(c.width * c.height * 4)))

  const before = {}
  for (const p of ['yellow', 'green', 'red', 'blue']) {
    await expect(page.locator(`${root(0x105)} [data-control="palace-${p}"] canvas`)).toHaveCount(1)
    before[p] = await icon(p)
    expect(before[p]).not.toBe(blank)
  }
  // Four palaces, four different blocks.
  expect(new Set(Object.values(before)).size).toBe(4)

  await page.locator(`${root(0x105)} [data-control="palace-yellow"]`).click()
  await expect.poll(() => icon('yellow')).not.toBe(before.yellow)
  expect(await icon('green')).toBe(before.green)
  await expect(page.locator(`${root(0x105)} [data-control="palace-yellow"]`)).toHaveAttribute(
    'title',
    /Yellow/,
  )
})

/**
 * $014 is a switch-palace map (tileset 4), with 470 hidden $02A cells, one at
 * column 1, row 13. The map draws each cell with the Map16 sheet's own
 * renderer, so a hidden cell shows its switched-on art at 25% over the
 * back area layer, as the sheet does, never blank. Measured on vanilla: that cell
 * holds the backdrop plus 5 blended colors.
 */
/**
 * The screen door (#643, and the map tab since #421): in a faint cell,
 * pixels where the cell's own x + y is odd are the art at 25% over the
 * backdrop (a channel moves at most 64), and even ones are the art in full
 * (some at least farther than that). `cell` is 256 RGBA arrays, row-major.
 */
function expectScreenDoor(cell, backdrop, needFull = true) {
  let full = 0
  cell.forEach((p, k) => {
    const far = [0, 1, 2].some(c => Math.abs(p[c] - backdrop[c]) > 64)
    if (((k % 16) + Math.floor(k / 16)) % 2 === 1) expect(far, `dim pixel ${k}`).toBe(false)
    else if (far) full++
  })
  if (needFull) expect(full).toBeGreaterThan(0)
}

test('hidden cells on $014 show their art in the screen door over the backdrop', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x014)
  // These are about L1's screen door over the back area: the background would show through its clear pixels.
  await page.locator(`${root(0x014)} [data-control="layer-l2"]`).click()
  await expect(page.locator(`${root(0x014)} [data-control="layer-l2"]`)).toHaveAttribute('aria-pressed', 'false') // prettier-ignore
  const screen = await readScreen(page, 0x014, 0)
  const cell = []
  for (let y = 13 * 16; y < 14 * 16; y++)
    for (let x = 16; x < 32; x++)
      cell.push(screen.rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4))
  const counts = new Map()
  for (const p of cell) counts.set(p.join(','), (counts.get(p.join(',')) ?? 0) + 1)
  const backdrop = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number)
  // Blank before the shared renderer: one color, the backdrop.
  expect(counts.size).toBeGreaterThan(2)
  expectScreenDoor(cell, backdrop)
})

/** The pixels of $014's hidden $02A cell at column 1, row 13 (screen 0). */
async function hiddenCell(page) {
  const screen = await readScreen(page, 0x014, 0)
  const cell = []
  for (let y = 13 * 16; y < 14 * 16; y++)
    for (let x = 16; x < 32; x++) cell.push(screen.rgba.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4).join(',')) // prettier-ignore
  return cell
}

/**
 * The blue P-switch reveals $02A's chars (#573, a char swap): with it on the
 * cell draws that art in full, not at 25%, and off restores the 25% picture.
 * Measured on vanilla: 80 of its dim squares go from within 64 of the
 * backdrop to farther than that, which the screen door never does off.
 */
test('blue P-switch on draws $014 hidden cells in full, and off restores them', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x014)
  // These are about L1's screen door over the back area: the background would show through its clear pixels.
  await page.locator(`${root(0x014)} [data-control="layer-l2"]`).click()
  await expect(page.locator(`${root(0x014)} [data-control="layer-l2"]`)).toHaveAttribute('aria-pressed', 'false') // prettier-ignore
  const off = await hiddenCell(page)
  const blue = page.locator(`${root(0x014)} [data-control="switch-blue"]`)
  await blue.click()
  await expect(blue).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(`${root(0x014)} canvas[data-screen="0"][data-plane="l1Low"]`)).toHaveAttribute('data-drawn', drawn(0, false, true)) // prettier-ignore
  const on = await hiddenCell(page)
  const count = p => off.filter(q => q === p).length
  const backdrop = [...off]
    .sort((a, b) => count(b) - count(a))[0]
    .split(',')
    .map(Number)
  // Off, the dim squares stay within 64 of the backdrop; on, the art is drawn in full there too.
  const dimFar = cell => cell.filter((p, k) => ((k % 16) + Math.floor(k / 16)) % 2 === 1 && p.split(',').slice(0, 3).some((v, c) => Math.abs(Number(v) - backdrop[c]) > 64)).length // prettier-ignore
  expect(dimFar(off)).toBe(0)
  expect(dimFar(on)).toBeGreaterThan(0)
  expect(on).not.toEqual(off)

  await blue.click()
  await expect(page.locator(`${root(0x014)} canvas[data-screen="0"][data-plane="l1Low"]`)).toHaveAttribute('data-drawn', drawn(0)) // prettier-ignore
  expect(await hiddenCell(page)).toEqual(off)
})

test('the switch toggles show art, and two tabs keep their own switches', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x014)
  for (const k of ['blue', 'silver', 'onOff']) {
    // Art, not the text fallback, on the vanilla ROM.
    await expect(page.locator(`${root(0x014)} [data-control="switch-${k}"] canvas`)).toHaveCount(1) // prettier-ignore
  }
  await page.locator(`${root(0x014)} [data-control="switch-blue"]`).click()
  await openMap(page, project.manifestPath, 0x105)
  await expect(page.locator(`${root(0x105)} [data-control="switch-blue"]`)).toHaveAttribute('aria-pressed', 'false') // prettier-ignore
  await activate(page, 0x014)
  await expect(page.locator(`${root(0x014)} [data-control="switch-blue"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
  await expect(page.locator(`${root(0x014)} canvas[data-screen="0"][data-plane="l1Low"]`)).toHaveAttribute('data-drawn', drawn(0, false, true)) // prettier-ignore
})

/**
 * The palace icons are the ROM's normal blocks on every map. Before, $014
 * drew them through its own tileset 4, which gives the cleared blocks the
 * palace's letters and routes no object to the blue and red blocks.
 */
test('palace icons on switch-palace map $014 equal those on $105', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  const icons = async index => {
    await openMap(page, project.manifestPath, index)
    const out = {}
    for (const p of ['yellow', 'green', 'red', 'blue']) {
      const button = page.locator(`${root(index)} [data-control="palace-${p}"]`)
      const read = () =>
        button.locator('canvas').evaluate(c => checksumOf(c.getContext('2d').getImageData(0, 0, c.width, c.height).data)) // prettier-ignore
      await expect(button.locator('canvas')).toHaveCount(1)
      const off = await read()
      await button.click()
      await expect.poll(read).not.toBe(off)
      out[p] = [off, await read()]
    }
    return out
  }
  const normal = await icons(0x105)
  expect(await icons(0x014)).toEqual(normal)
})

test('two map tabs keep their own palaces', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  await showScreen(page, 0x106, 2)
  const other = await readScreen(page, 0x106, 2)

  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="palace-yellow"]`).click()
  await showScreen(page, 0x105, 9, true)

  await activate(page, 0x106)
  await expect(page.locator(`${root(0x106)} [data-control="palace-yellow"]`)).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  // $106's own yellow block (screen 2, column 7, row 20) is still unpressed.
  await expect(
    page.locator(`${root(0x106)} canvas[data-screen="2"][data-plane="l1Low"]`),
  ).toHaveAttribute('data-drawn', drawn(2))
  const still = await readScreen(page, 0x106, 2)
  expect(still.cells['7,20']).toBe(other.cells['7,20'])

  // Pressing yellow HERE changes this tab's block, proving the cell is live.
  await page.locator(`${root(0x106)} [data-control="palace-yellow"]`).click()
  await showScreen(page, 0x106, 2, true)
  expect(changedCells(still, await readScreen(page, 0x106, 2))).toEqual(['7,20'])
})

test('the header facts are in view, and the decode panel opens with its ROM bytes', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const facts = page.locator(`${root(0x105)} .hb-map-view-facts`)
  await expect(facts).toBeVisible()
  await expect(facts).toContainText(/20 screens/)

  const panel = page.locator(`${root(0x105)} [data-control="header-panel"]`)
  const table = panel.locator('.hb-map-view-table')
  await expect(table).toBeHidden()
  await panel.locator('summary').click()
  await expect(panel).toHaveJSProperty('open', true)
  await expect(table).toBeVisible()
  await expect(panel.locator('.hb-map-view-raw code')).toHaveText(/^([0-9A-F]{2} ){4}[0-9A-F]{2}$/)

  // The decoded screen count is the one the strip was sized from.
  const screensRow = panel.locator('tr', { hasText: 'Screens' }).locator('td')
  const canvases = await page.locator(`${root(0x105)} canvas[data-plane="l1Low"]`).count()
  await expect(screensRow).toHaveText(String(canvases))
  expect(canvases).toBe(20)
})

test('the map tab speaks of ROMs, never cartridges', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="header-panel"] summary`).click()
  const words = await shownWords(page, root(0x105))
  expect(words).toMatch(/Yellow switch palace/)
  expect(words).not.toMatch(CART)
})

/**
 * #342: $1E0's cloud slope (object $12, size $E5, CODE_0DADEB) is a staircase
 * that steps four columns right per row from (8,8), not a 4-wide column under
 * (8,8). Screen 0 holds the first step at (8,8) and the second at (12,9); each
 * step's body sits under the lip before it, with fill left of the body.
 * Compared by pixels per 16x16 cell.
 */
test('$1E0 screen 0 draws the cloud slope as a staircase, not a column', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x1e0)
  const cells = (await readScreen(page, 0x1e0, 0)).cells
  expect(new Set([8, 9, 10, 11].map(x => cells[`${x},8`])).size, 'four distinct lip tiles').toBe(4)
  for (let c = 0; c < 4; c++) {
    // The lip repeats one row down, four columns right, and its body sits under the first.
    expect(cells[`${12 + c},9`], `second step, lip ${c}`).toBe(cells[`${8 + c},8`])
    expect(cells[`${12 + c},10`], `body ${c}`).toBe(cells[`${8 + c},9`])
  }
  // The defect: body all the way down under (8,8). Body columns 8-10 draw as the fill, so only
  // column 11 (its body is not pixel-identical to the fill) tells the renders apart: the fill
  // reference is (8,20), the same pixels in both. Staircase: (11,9) is body, below it is fill.
  const fill = cells['8,20']
  expect(cells['11,9'], 'body under the first lip').not.toBe(fill)
  for (const y of [10, 14, 20]) expect(cells[`11,${y}`], `(11,${y}) is fill`).toBe(fill)
})

/**
 * Fit to window / Actual size (100%). The zoom is READ from the painted
 * canvas (CSS width over bitmap width), not from the indicator, which rounds
 * a fractional fit to a whole percent. $105 is horizontal (fits by height),
 * $109 vertical (fits by width): a fit that only worked on one axis fails.
 */
const zoomOf = (page, index) =>
  page.evaluate(sel => {
    const c = document.querySelector(`${sel} canvas[data-plane="l1Low"]`)
    return c.getBoundingClientRect().width / c.width
  }, root(index))

/** Waits until two successive frames report the same zoom: the fit has landed. */
const settled = (page, index) =>
  page.evaluate(
    sel =>
      new Promise(resolve => {
        // The header facts arrive by RPC after the strip first lays out and can
        // refit it; the layout is final only once they are on screen.
        const factsIn = () => !!document.querySelector(`${sel} .hb-map-view-summary`)
        const read = () => {
          const c = document.querySelector(`${sel} canvas[data-plane="l1Low"]`)
          return c.getBoundingClientRect().width / c.width
        }
        let last = read()
        let same = 0
        const tick = () => {
          const z = read()
          same = Math.abs(z - last) < 1e-9 ? same + 1 : 0
          last = z
          if (same >= 5 && factsIn()) resolve(z)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    root(index),
  )

/**
 * The view at fraction `f` along the main axis: the zoom, the client point,
 * the content pixel under it, and what a clamp needs (scroll, view size, max
 * scroll, and where the strip starts in scroll coordinates).
 */
const probeView = (page, index, f = 0.5) =>
  page.evaluate(
    ({ sel, f }) => {
      const root = document.querySelector(sel)
      const el = root.querySelector('[data-control="map-scroller"]')
      const v = el.classList.contains('hb-vertical')
      const r = el.getBoundingClientRect()
      const strip = root.querySelector('.hb-map-view-strip').getBoundingClientRect()
      const c = root.querySelector('canvas[data-plane="l1Low"]')
      const z = c.getBoundingClientRect().width / c.width
      const pt = { x: r.left + r.width * (v ? 0.5 : f), y: r.top + r.height * (v ? f : 0.5) }
      const scroll = v ? el.scrollTop : el.scrollLeft
      return {
        v,
        z,
        pt,
        content: (v ? pt.y - strip.top : pt.x - strip.left) / z,
        scroll,
        cw: v ? el.clientHeight : el.clientWidth,
        max: v ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth,
        off: (v ? strip.top - r.top : strip.left - r.left) + scroll,
      }
    },
    { sel: root(index), f },
  )

const LEVELS = [1, 2, 3, 4]
/** How far the strip's cross axis is from filling the scroller, in CSS pixels. */
const crossSlack = (page, index) =>
  page.evaluate(sel => {
    const root = document.querySelector(sel)
    const el = root.querySelector('[data-control="map-scroller"]')
    const r = root.querySelector('canvas[data-plane="l1Low"]').getBoundingClientRect()
    return el.classList.contains('hb-vertical')
      ? Math.abs(r.width - el.clientWidth)
      : Math.abs(r.height - el.clientHeight)
  }, root(index))

for (const index of [0x105, 0x109]) {
  const name = `$${index.toString(16)}`
  const open = async page => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    await settled(page, index)
    return zoomOf(page, index)
  }
  const click = (page, control) =>
    page.locator(`${root(index)} [data-control="${control}"]`).click()

  test(`${name}: Fit returns to the load-time zoom after zooming in twice`, async ({ page }) => {
    const loaded = await open(page)
    await click(page, 'zoom-in')
    await click(page, 'zoom-in')
    await expect.poll(() => zoomOf(page, index)).not.toBeCloseTo(loaded, 2)
    await click(page, 'zoom-fit')
    await expect.poll(() => zoomOf(page, index)).toBeCloseTo(loaded, 3)
    await expect(page.locator(`${root(index)} [data-control="zoom-fit"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  test(`${name}: Actual size is exactly 100%, and leaves fit mode`, async ({ page }) => {
    await open(page)
    await click(page, 'zoom-actual')
    await expect.poll(() => zoomOf(page, index)).toBe(1)
    await expect(page.locator(`${root(index)} [data-control="zoom-fit"]`)).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  test(`${name}: in fit mode a resize refits; after a manual zoom it does not`, async ({
    page,
  }) => {
    const loaded = await open(page)
    const size = page.viewportSize()
    await page.setViewportSize({ width: Math.round(size.width * 0.7), height: Math.round(size.height * 0.7) }) // prettier-ignore
    await expect.poll(() => zoomOf(page, index)).not.toBeCloseTo(loaded, 2)
    // Fits: the cross axis is the scroller's own, to within a pixel.
    const slack = await crossSlack(page, index)
    expect(slack).toBeLessThan(1.5)
    await click(page, 'zoom-fit')
    await click(page, 'zoom-in')
    const held = await zoomOf(page, index)
    await page.setViewportSize(size)
    await page.waitForTimeout(800)
    expect(await zoomOf(page, index)).toBeCloseTo(held, 6)
  })
}

/**
 * Ctrl + wheel (#392) keeps the content point under the cursor. Judged on
 * the MAIN axis (x for a horizontal strip, y for a vertical one): the cross
 * axis is fitted, so it has nothing to scroll. Cases: one notch at the
 * centre, one at an off-centre cursor, three notches in one event, and one
 * with the strip scrolled to its end and the cursor near it (not a clamp:
 * the anchored scroll still fits there).
 */
const WHEELS = [
  { name: 'one notch at the centre', notches: 1, atEnd: false, f: 0.5 },
  { name: 'one notch at an off-centre cursor', notches: 1, atEnd: false, f: 0.25 },
  { name: 'three notches in one event', notches: 3, atEnd: false, f: 0.5 },
  { name: 'one notch near the strip end', notches: 1, atEnd: true, f: 0.95 },
]
for (const index of [0x105, 0x109]) {
  for (const w of WHEELS) {
    test(`$${index.toString(16)}: Ctrl + wheel, ${w.name}, keeps the point under the cursor`, async ({
      page,
    }) => {
      const project = await createProject(page, path.join(tmp, 'MyHack'))
      await openMap(page, project.manifestPath, index)
      await settled(page, index)
      await page.locator(`${root(index)} [data-control="zoom-actual"]`).click()
      await expect.poll(() => zoomOf(page, index)).toBe(1)
      if (w.atEnd) {
        await page.evaluate(sel => {
          const el = document.querySelector(`${sel} [data-control="map-scroller"]`)
          el.scrollLeft = el.scrollWidth
          el.scrollTop = el.scrollHeight
        }, root(index))
        await settled(page, index)
      }
      const before = await probeView(page, index, w.f)
      const at = before.pt
      const want = before.content
      await page.mouse.move(at.x, at.y)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -120 * w.notches)
      await page.keyboard.up('Control')
      const zoomed = Math.min(4, 1 + w.notches)
      await expect.poll(async () => (await probeView(page, index)).z).toBe(zoomed)
      await settled(page, index)
      const after = await probeView(page, index, w.f)
      expect(Math.abs(after.content - want)).toBeLessThan(1)
      await expect(page.locator(`${root(index)} [data-control="zoom-fit"]`)).toHaveAttribute(
        'aria-pressed',
        'false',
      )
    })
  }

  const click = (page, c) => page.locator(`${root(index)} [data-control="${c}"]`).click()

  // Owner ruling (#526): every Maps button keeps the view centre fixed.
  const ANCHORS = [
    { control: 'zoom-actual', scroll: 0.6 },
    { control: 'zoom-fit', scroll: 0.6 },
    { control: 'zoom-in', scroll: 0.6 },
    { control: 'zoom-out', scroll: 0.6 },
    { control: 'zoom-out', scroll: 0.97, clamped: true },
  ]
  for (const a of ANCHORS) {
    test(`$${index.toString(16)}: ${a.control} keeps the view centre${a.clamped ? ' (strip end, clamped)' : ''}`, async ({
      page,
    }) => {
      const project = await createProject(page, path.join(tmp, 'MyHack'))
      await openMap(page, project.manifestPath, index)
      await settled(page, index)
      for (let i = 0; i < 2; i++) await click(page, 'zoom-in')
      await settled(page, index)
      await page.evaluate(
        ({ sel, f }) => {
          const el = document.querySelector(`${sel} [data-control="map-scroller"]`)
          el.scrollLeft = (el.scrollWidth - el.clientWidth) * f
          el.scrollTop = (el.scrollHeight - el.clientHeight) * f
        },
        { sel: root(index), f: a.scroll },
      )
      await settled(page, index)
      const before = await probeView(page, index)
      await click(page, a.control)
      await expect.poll(async () => (await probeView(page, index)).z).not.toBe(before.z)
      await settled(page, index)
      const after = await probeView(page, index)
      if (a.clamped) {
        // Exact: the anchored scroll, clamped to the new range. Unanchored (the
        // old scroll, clamped) must differ, or this case could not fail.
        const want = Math.min(after.max, Math.max(0, before.content * after.z + before.off - before.cw / 2)) // prettier-ignore
        const unanchored = Math.min(after.max, Math.max(0, before.scroll))
        expect(Math.abs(want - unanchored), 'anchored and unanchored differ').toBeGreaterThan(2)
        expect(Math.abs(after.scroll - want)).toBeLessThan(1)
      } else {
        expect(Math.abs(after.content - before.content)).toBeLessThan(1)
      }
    })
  }

  const fitSteps = async (page, size) => {
    if (size) await page.setViewportSize(size)
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    return settled(page, index)
  }

  test(`$${index.toString(16)}: zoom in from fit lands on the next level above the fit`, async ({
    page,
  }) => {
    const fit = await fitSteps(page)
    await click(page, 'zoom-in')
    const want = LEVELS.find(l => l > fit + 0.001)
    await expect.poll(() => zoomOf(page, index)).toBeCloseTo(want ?? fit, 6)
  })

  test(`$${index.toString(16)}: zoom out from a fit above 1 lands on the level below`, async ({
    page,
  }) => {
    const fit = await fitSteps(page, { width: 1900, height: 1400 })
    expect(fit, 'precondition: the larger window fits above 100%').toBeGreaterThan(1.05)
    await click(page, 'zoom-out')
    const want = [...LEVELS].reverse().find(l => l < fit - 0.001)
    await expect.poll(() => zoomOf(page, index)).toBeCloseTo(want, 6)
  })
}

/** A map loaded into a reused tab opens fitted, whatever zoom the last one was left at. */
for (const next of [0x106, 0x109]) {
  test(`loading $${next.toString(16)} into a $105 tab zoomed by hand re-fits`, async ({ page }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, 0x105)
    await page.waitForTimeout(500)
    await page.locator(`${root(0x105)} [data-control="zoom-actual"]`).click()
    await expect.poll(() => zoomOf(page, 0x105)).toBe(1)
    await page.evaluate(
      async ({ mp, next, first }) => {
        const w = getSvc('ApplicationShell').getWidgetById(`hackbench.map-view:${first}`)
        await w.open({ manifestPath: mp, index: next, label: next.toString(16), iconClass: '' })
      },
      { mp: project.manifestPath, next, first: 0x105 },
    )
    opened.push(`hackbench.map-view:${next}`)
    await expect(
      page.locator(`${root(next)} canvas[data-screen="0"][data-plane="l1Low"]`),
    ).toHaveAttribute('data-drawn', drawn(0), { timeout: 15000 })
    await expect(page.locator(`${root(next)} [data-control="zoom-fit"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect.poll(() => crossSlack(page, next)).toBeLessThan(1.5)
  })
}

/**
 * The Maps grid (tile 1 px, sub-screen 3 px, screen 5 px; all device px). Lines are checked as
 * PIXELS on the overlay canvas and against the real screen canvases' positions, never only
 * against the data hook.
 */
const gridToggle = index => `${root(index)} [data-control="grid-toggle"]`
const scrollerSel = index => `${root(index)} [data-control="map-scroller"]`

/** Maximal runs of painted device pixels along a row (or column) from readGrid's hits. */
const runs = hits => {
  const out = []
  for (const h of hits) {
    const last = out[out.length - 1]
    if (last && last.start + last.size === h) last.size++
    else out.push({ start: h, size: 1 })
  }
  return out
}

async function showGrid(page, index) {
  // Off must read as off without a hover (docs/ui-conventions.md, Toggle buttons).
  await expect(page.locator(gridToggle(index))).toHaveClass(/hb-icon-btn-off/)
  await page.locator(gridToggle(index)).click()
  await expect(page.locator(gridToggle(index))).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator(gridToggle(index))).toHaveClass(/hb-icon-btn-on/)
  await expect(page.locator(`${root(index)} .hb-grid-overlay`)).toBeVisible()
}

async function scrollMapTo(page, index, left, top) {
  await page.locator(scrollerSel(index)).evaluate(
    (el, [l, t]) => {
      el.scrollLeft = l
      el.scrollTop = t
    },
    [left, top],
  )
}

test('the Maps grid toggle is labelled, off by default, and the command drives it', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const toggle = page.locator(gridToggle(0x105))
  expect(await readGrid(page, root(0x105))).toBeNull()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('title', 'Show grid')
  await expect(toggle.locator('.codicon-table')).toHaveCount(1)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('title', 'Hide grid')
  await expect(toggle).toHaveAttribute('aria-label', 'Hide grid')
  expect(await readGrid(page, root(0x105))).not.toBeNull()
  await page.evaluate(() => getSvc('CommandRegistry').executeCommand('hackbench.maps.toggleGrid'))
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await readGrid(page, root(0x105))).toBeNull()
})

/** Expected weight of boundary `i` (tiles): a screen every `screen`, the half at `sub`. */
const weightOf = (i, screen, sub) =>
  i % screen === 0 ? 5 : sub !== undefined && i % screen === sub ? 3 : 1

for (const [index, vertical] of [
  [0x105, false],
  [0x109, true],
]) {
  test(`$${index.toString(16)} (${vertical ? 'vertical' : 'horizontal'}): three weights at the expected boundaries, centred`, async ({
    page,
  }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, index)
    await page.locator(`${root(index)} [data-control="zoom-actual"]`).click()
    await expect.poll(() => zoomOf(page, index)).toBe(1)
    await showGrid(page, index)
    await gridSettled(page, index)
    const g = await readGrid(page, root(index))
    expect(g.cell).toBe(16) // zoom 1
    // Vertical: x repeats every 32 columns with the half at 16; y every 16 rows.
    // Horizontal: x every 16 columns; y every 27 rows with the half at row 16.
    const xs = vertical ? [32, 16] : [16, undefined]
    const ys = vertical ? [16, undefined] : [27, 16]
    for (const l of g.xLines) expect(l.weight).toBe(weightOf(Math.round(l.pos / 16), ...xs))
    for (const l of g.yLines) expect(l.weight).toBe(weightOf(Math.round(l.pos / 16), ...ys))
    const half = (vertical ? g.xLines : g.yLines).filter(l => l.weight === 3)
    expect(half.map(l => l.pos)).toContain(256)
    expect(new Set([...g.xLines, ...g.yLines].map(l => l.weight))).toEqual(new Set([1, 3, 5]))
    // Pixels: each vertical line paints exactly its weight, centred on its boundary pixel.
    expect(runs(g.rowHits)).toEqual(g.xLines.map(l => ({ start: l.start, size: l.size })))
    // The content's own left and right edges are clipped, so their centre is not the boundary.
    const lastPos = Math.max(...g.xLines.map(l => l.pos))
    for (const l of g.xLines.filter(l => l.weight > 1 && l.start > 0 && l.pos < lastPos))
      expect(l.start + (l.size - 1) / 2).toBe(Math.round(l.pos * g.dpr))
    // The sub-screen line sits at row 16 (horizontal) or column 16 (vertical) of the CONTENT:
    // measured from the strip's own edge in the DOM, painted as a 3 px run on the canvas.
    const off = await page.evaluate(sel => {
      const o = document.querySelector(`${sel} .hb-grid-overlay`).getBoundingClientRect()
      const t = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
      return { x: t.left - o.left, y: t.top - o.top }
    }, root(index))
    const axisOff = vertical ? off.x : off.y
    const wantCentre = Math.round((axisOff + 16 * 16) * g.dpr)
    const threes = runs(vertical ? g.rowHits : g.colHits).filter(r => r.size === 3)
    // The strip's own edges are 5 px lines clipped to 3 px, so they look like 3 px runs too:
    // only an interior run counts, and exactly one of those must be the half line.
    const interior = threes.filter(r => r.start > 0 && r.start + r.size < (vertical ? g.canvasW : g.canvasH)) // prettier-ignore
    const edge = Math.max(...(vertical ? g.xLines : g.yLines).map(l => l.pos)) * g.dpr
    const inner = interior.filter(r => r.start + 1 < edge - 1)
    expect(inner.length).toBe(1)
    // Within 1 device px: the strip's box may sit on a fractional CSS offset.
    expect(Math.abs(inner[0].start + 1 - wantCentre)).toBeLessThanOrEqual(1)
  })
}

test('the grid canvas is viewport-sized, however wide the map and zoom', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showGrid(page, 0x105)
  // To the maximum: the button disables there (Fit may already start above 100%).
  const zin = page.locator(`${root(0x105)} [data-control="zoom-in"]`)
  for (let i = 0; i < 6 && (await zin.isEnabled()); i++) await zin.click()
  await expect(zin).toBeDisabled()
  await gridSettled(page, 0x105)
  const m = await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    const strip = s.querySelector('.hb-map-view-strip').getBoundingClientRect()
    return {
      cw: s.clientWidth,
      ch: s.clientHeight,
      ow: o.width,
      oh: o.height,
      dpr: Number(o.dataset.gridDpr),
      stripW: strip.width,
    }
  }, root(0x105))
  expect(m.ow).toBeLessThanOrEqual(Math.ceil(m.cw * m.dpr))
  expect(m.oh).toBeLessThanOrEqual(Math.ceil(m.ch * m.dpr))
  // The content really is much wider than what the canvas covers.
  expect(m.stripW).toBeGreaterThan(m.cw * 3)
})

/**
 * How far every grid line sits from its boundary in the CONTENT, in device px: each line's
 * centre against the strip's own edge plus the line's content position. Lines clipped by the
 * viewport edge are skipped (their centre is not the boundary). Tolerance at the call sites is
 * 1.5 device px: one px of rounding in the overlay, half a px of fractional layout (Fit zoom).
 */
async function lineDeviation(page, index) {
  return page.evaluate(sel => {
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    const strip = document.querySelector(`${sel} .hb-map-view-strip`).getBoundingClientRect()
    const lines = JSON.parse(o.dataset.gridLines)
    const dpr = Number(o.dataset.gridDpr)
    const box = o.getBoundingClientRect()
    const worst = { x: 0, y: 0 }
    const seen = { x: new Set(), y: new Set() }
    const check = (axis, l, edge, over, cap) => {
      if (l.start <= 0 || l.start + l.size >= cap) return
      const want = (edge + l.pos - over) * dpr + 0.5
      worst[axis] = Math.max(worst[axis], Math.abs(l.start + l.size / 2 - want))
      seen[axis].add(l.weight)
    }
    for (const l of lines.x) check('x', l, strip.left, box.left, o.width)
    for (const l of lines.y) check('y', l, strip.top, box.top, o.height)
    return { worst, x: [...seen.x], y: [...seen.y], cellPx: Number(o.dataset.gridCellPx), w: o.width, h: o.height } // prettier-ignore
  }, root(index))
}

const TOL = 1.5

/**
 * Waits until the overlay's drawn lines sit on the strip's boundaries for the CURRENT scroll, zoom
 * and size (the same deviation the alignment tests assert), instead of a fixed pause: the pixel
 * samples that follow are only meaningful once the overlay has caught up with the layout.
 */
async function gridSettled(page, index) {
  await expect
    .poll(async () => {
      const d = await lineDeviation(page, index)
      return Math.max(d.worst.x, d.worst.y)
    })
    .toBeLessThanOrEqual(TOL)
  // The metadata is written at render; the canvas is painted after the commit. Wait for the
  // PIXELS to be exactly the lines the metadata lists, or a sample can read the previous paint.
  await expect.poll(() => gridPixelsMatchLines(page, index)).toBe(true)
}

/**
 * Whether the overlay canvas's painted pixels are exactly its metadata's lines: along one row
 * that crosses no horizontal line, the painted columns equal the vertical lines covering that row;
 * along one column that crosses no vertical line, the painted rows equal the horizontal lines.
 */
const gridPixelsMatchLines = (page, index) =>
  page.evaluate(sel => {
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    if (!o || o.width === 0 || o.height === 0) return false
    const lines = JSON.parse(o.dataset.gridLines)
    // No expected lines would match an empty canvas: that is "not drawn yet", not "settled".
    if (lines.x.length === 0 || lines.y.length === 0) return false
    const W = o.width
    const H = o.height
    const data = o.getContext('2d').getImageData(0, 0, W, H).data
    const painted = (x, y) => data[(y * W + x) * 4 + 3] > 0
    const covers = (ls, v) => ls.some(l => v >= l.start && v < l.start + l.size)
    const row = Array.from({ length: H }, (_, y) => y).find(y => !covers(lines.y, y))
    const col = Array.from({ length: W }, (_, x) => x).find(x => !covers(lines.x, x))
    if (row === undefined || col === undefined) return false
    const want = (ls, v, n) =>
      Array.from({ length: n }, (_, i) => i).filter(i => ls.some(l => i >= l.start && i < l.start + l.size && v >= l.from && v < l.to)) // prettier-ignore
    const got = (n, at) => Array.from({ length: n }, (_, i) => i).filter(at)
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
    return (
      same(
        got(W, x => painted(x, row)),
        want(lines.x, row, W),
      ) &&
      same(
        got(H, y => painted(col, y)),
        want(lines.y, col, H),
      )
    )
  }, root(index))

test('gridPixelsMatchLines is true when painted, false when cleared, and false for zero lines', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await showGrid(page, 0x105)
  await gridSettled(page, 0x105)
  expect(await gridPixelsMatchLines(page, 0x105)).toBe(true)
  const overlay = fn => page.evaluate(fn, root(0x105))
  await overlay(sel => {
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    o.getContext('2d').clearRect(0, 0, o.width, o.height)
  })
  // Metadata untouched, canvas blank: the oracle must see the difference.
  expect(await gridPixelsMatchLines(page, 0x105)).toBe(false)
  // Zero lines listed and nothing painted must not read as settled.
  await overlay(sel => {
    document.querySelector(`${sel} .hb-grid-overlay`).dataset.gridLines = '{"x":[],"y":[]}'
  })
  expect(await gridPixelsMatchLines(page, 0x105)).toBe(false)
})

// Assumptions: $105 is horizontal and 10+ screens wide, so at Fit (height-fitted) and at 200% it
// scrolls sideways; $109 is vertical and several screens tall, so it scrolls down. Both are
// asserted below (maxScroll > 0) rather than trusted.
const scrollMax = (page, index, axis) =>
  page.locator(scrollerSel(index)).evaluate((s, a) => (a === 'x' ? s.scrollWidth - s.clientWidth : s.scrollHeight - s.clientHeight), axis) // prettier-ignore

for (const [index, axis] of [
  [0x105, 'x'],
  [0x109, 'y'],
]) {
  for (const mode of ['actual', 'fit']) {
    test(`$${index.toString(16)}: every grid line, sub-screen line included, stays on its boundary while scrolling, at ${mode} zoom`, async ({
      page,
    }) => {
      const project = await createProject(page, path.join(tmp, 'MyHack'))
      await openMap(page, project.manifestPath, index)
      await page.locator(`${root(index)} [data-control="zoom-${mode}"]`).click()
      // Settled, not slept: Actual is zoom 1; Fit shows its pressed state once it has taken effect.
      if (mode === 'actual') await expect.poll(() => zoomOf(page, index)).toBe(1)
      else await expect(page.locator(`${root(index)} [data-control="zoom-fit"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
      await expect.poll(() => scrollMax(page, index, axis)).toBeGreaterThan(0)
      const max = await scrollMax(page, index, axis)
      expect(max).toBeGreaterThan(0)
      // Toggled ON while scrolled: the first paint must already be right.
      await scrollMapTo(page, index, axis === 'x' ? Math.floor(max * 0.4) : 0, axis === 'y' ? Math.floor(max * 0.4) : 0) // prettier-ignore
      await showGrid(page, index)
      for (const at of [0.4, 0.8, 0.15]) {
        await scrollMapTo(page, index, axis === 'x' ? Math.floor(max * at) : 0, axis === 'y' ? Math.floor(max * at) : 0) // prettier-ignore
        await expect
          .poll(async () => {
            const d = await lineDeviation(page, index)
            return Math.max(d.worst.x, d.worst.y)
          })
          .toBeLessThanOrEqual(TOL)
        const d = await lineDeviation(page, index)
        // Sub-screen (3) and screen (5) lines are among those checked, on the axis that has them.
        expect(d[axis === 'x' ? 'x' : 'y']).toContain(5)
        const halfAxis = axis === 'x' ? 'y' : 'x' // rows split horizontal maps, columns vertical ones
        if (mode === 'actual') expect(d[halfAxis]).toContain(3)
      }
    })
  }
}

test('the grid stays aligned after Ctrl + wheel zoom and after a resize', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="zoom-actual"]`).click()
  await showGrid(page, 0x105)
  const before = (await lineDeviation(page, 0x105)).cellPx
  const box = await page.locator(scrollerSel(0x105)).boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await lineDeviation(page, 0x105)).cellPx).toBeGreaterThan(before)
  await expect
    .poll(async () => {
      const d = await lineDeviation(page, 0x105)
      return Math.max(d.worst.x, d.worst.y)
    })
    .toBeLessThanOrEqual(TOL)
  const size = page.viewportSize()
  const clientBefore = await page.locator(scrollerSel(0x105)).evaluate(s => s.clientWidth)
  await page.setViewportSize({ width: Math.floor(size.width * 0.7), height: Math.floor(size.height * 0.8) }) // prettier-ignore
  // Until the scroller has shrunk AND the overlay has followed it to the pixel.
  await expect
    .poll(() =>
      page.evaluate(
        ([sel, was]) => {
          const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
          const o = document.querySelector(`${sel} .hb-grid-overlay`)
          return s.clientWidth < was && parseFloat(o.style.width) === s.clientWidth && parseFloat(o.style.height) === s.clientHeight // prettier-ignore
        },
        [root(0x105), clientBefore],
      ),
    )
    .toBe(true)
  const d = await page.evaluate(sel => {
    const s = document.querySelector(`${sel} [data-control="map-scroller"]`)
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    return { cw: s.clientWidth, ch: s.clientHeight, ow: parseFloat(o.style.width), oh: parseFloat(o.style.height) } // prettier-ignore
  }, root(0x105))
  expect(d.ow).toBe(d.cw)
  expect(d.oh).toBe(d.ch)
  await expect
    .poll(async () => {
      const dev = await lineDeviation(page, 0x105)
      return Math.max(dev.worst.x, dev.worst.y)
    })
    .toBeLessThanOrEqual(TOL)
  await page.setViewportSize(size)
})

/**
 * The overlay must be ABOVE the level planes (the composite canvas, z-index 100, over the source planes, 1..7): a stacking bug draws it under them,
 * where it shows only through clear pixels and every data-hook and canvas check still passes. So
 * compare COMPOSITED screen pixels, grid on against grid off, at thin vertical lines over opaque
 * terrain: the line pixels must change, their neighbours must not. Decoded numerically in the page.
 */
test('the grid is composited above opaque level content', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="zoom-actual"]`).click()
  await expect.poll(() => zoomOf(page, 0x105)).toBe(1)
  await showGrid(page, 0x105)
  await gridSettled(page, 0x105)
  const probe = await page.evaluate(sel => {
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    const dpr = Number(o.dataset.gridDpr)
    const lines = JSON.parse(o.dataset.gridLines)
    const r = o.getBoundingClientRect()
    const c = document.querySelector(`${sel} canvas[data-screen="0"][data-plane="l1Low"]`)
    const cr = c.getBoundingClientRect()
    const alpha = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const pts = []
    // Thin vertical lines inside screen 0 only, at rows where L1 is fully opaque both on the line and beside it.
    for (const l of lines.x.filter(l => l.weight === 1 && l.pos > 0 && l.pos < c.width)) {
      for (let y = 0; y < c.height && pts.length < 60; y += 7) {
        const a = x => alpha[(y * c.width + x) * 4 + 3]
        if (a(l.pos) === 255 && a(l.pos + 2) === 255) pts.push({ x: l.pos, y })
      }
    }
    return { pts, left: cr.left, top: cr.top, ox: r.left, oy: r.top, dpr }
  }, root(0x105))
  expect(probe.dpr).toBe(1)
  expect(probe.pts.length).toBeGreaterThan(10)
  const clip = await page.evaluate(sel => {
    const r = document.querySelector(`${sel} .hb-grid-overlay`).getBoundingClientRect()
    return { x: Math.ceil(r.left), y: Math.ceil(r.top), width: Math.floor(r.width) - 1, height: Math.floor(r.height) - 1 } // prettier-ignore
  }, root(0x105))
  const shot = async () => {
    await page.mouse.move(0, 0)
    return (await page.screenshot({ clip })).toString('base64')
  }
  const on = await shot()
  await page.locator(gridToggle(0x105)).click()
  await expect(page.locator(`${root(0x105)} .hb-grid-overlay`)).toHaveCount(0)
  const off = await shot()
  const r = await page.evaluate(
    async ({ on, off, pts, left, top, clip }) => {
      const read = async b64 => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, c.width, c.height)
      }
      const [a, b] = [await read(on), await read(off)]
      const at = (d, x, y) => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3)) // prettier-ignore
      let lineChanged = 0
      let besideSame = 0
      for (const p of pts) {
        const x = Math.round(left + p.x - clip.x)
        const y = Math.round(top + p.y - clip.y)
        if (at(a, x, y).join() !== at(b, x, y).join()) lineChanged++
        if (at(a, x + 2, y).join() === at(b, x + 2, y).join()) besideSame++
      }
      return { lineChanged, besideSame, n: pts.length }
    },
    { on, off, pts: probe.pts, left: probe.left, top: probe.top, clip },
  )
  // 90%: a few tiles animate between the two screenshots.
  expect(r.lineChanged).toBeGreaterThanOrEqual(r.n * 0.9)
  expect(r.besideSame).toBeGreaterThanOrEqual(r.n * 0.9)
})

/**
 * The grid must also sit above the SPRITE layer (#564), which stacks between L1's low and
 * priority planes: a grid under the sprites shows through clear pixels only, so the opaque-terrain
 * check above passes. $106's first $05 sits at content (432, 304) to (448, 336), and the tile lines
 * x = 432 and y = 320 cross it. Pixels where that sprite is opaque must change when the grid is on.
 */
test('the grid is composited above the sprite layer', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  await page.locator(`${root(0x106)} [data-control="zoom-actual"]`).click()
  await expect.poll(() => zoomOf(page, 0x106)).toBe(1)
  await showScreen(page, 0x106, 1)
  await expect(spritePlane(page, 0x106, 1)).toHaveAttribute('data-drawn', SPRITES_DRAWN)
  await showGrid(page, 0x106)
  await page.mouse.move(0, 0)
  // The koopa's rows are 304..336: bring them to the middle of the scroller, not just the screen's top.
  await page.evaluate(sel => {
    const sc = document.querySelector(`${sel} [data-control="map-scroller"]`)
    sc.scrollTop = Math.max(0, 320 - sc.clientHeight / 2)
  }, root(0x106))
  await gridSettled(page, 0x106)
  const probe = await page.evaluate(sel => {
    const c = document.querySelector(`${sel} canvas[data-screen="1"][data-plane="sprites"]`)
    const cr = c.getBoundingClientRect()
    const zoom = cr.width / c.width
    const a = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const pts = []
    for (let y = 304; y < 336; y++) {
      for (let x = 432; x < 448; x++) {
        // Opaque sprite pixels exactly on a grid line.
        if ((x === 432 || y === 320) && a[(y * c.width + (x - 256)) * 4 + 3] === 255) {
          const p = [Math.round(cr.left + (x - 256) * zoom), Math.round(cr.top + y * zoom)]
          const sr = document.querySelector(`${sel} [data-control="map-scroller"]`).getBoundingClientRect() // prettier-ignore
          if (p[0] > sr.left && p[0] < sr.right && p[1] > sr.top && p[1] < sr.bottom) pts.push(p)
        }
      }
    }
    const o = document.querySelector(`${sel} .hb-grid-overlay`)
    return { pts, zoom, dpr: Number(o.dataset.gridDpr), w: innerWidth, h: innerHeight }
  }, root(0x106))
  expect([probe.zoom, probe.dpr]).toEqual([1, 1])
  // Not vacuous: enough opaque sprite pixels lie on the lines.
  expect(probe.pts.length).toBeGreaterThan(8)
  const shot = async () =>
    (await page.screenshot({ clip: { x: 0, y: 0, width: probe.w, height: probe.h } })).toString('base64') // prettier-ignore
  const on = await shot()
  await page.locator(gridToggle(0x106)).click()
  await expect(page.locator(`${root(0x106)} .hb-grid-overlay`)).toHaveCount(0)
  const off = await shot()
  const changed = await page.evaluate(
    async ({ on, off, pts }) => {
      const read = async b64 => {
        const img = new Image()
        img.src = `data:image/png;base64,${b64}`
        await img.decode()
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        ctx.drawImage(img, 0, 0)
        return ctx.getImageData(0, 0, c.width, c.height)
      }
      const [a, b] = [await read(on), await read(off)]
      const px = (d, [x, y]) => Array.from(d.data.slice((y * d.width + x) * 4, (y * d.width + x) * 4 + 3)).join() // prettier-ignore
      return pts.filter(p => px(a, p) !== px(b, p)).length
    },
    { on, off, pts: probe.pts },
  )
  // 80%: a sprite can animate between the two screenshots.
  expect(changed).toBeGreaterThanOrEqual(probe.pts.length * 0.8)
})

/**
 * The ON/OFF tracks on $005 (#560). Vanilla $094 is a diagonal drawn while the switch byte $14AF is
 * 0, $095 its mirror drawn while it is 1, each a one-pixel line. The screen door once drew $095
 * at full strength with $14AF 0, so both looked drawn in both states. Measured: $094 at column 152,
 * row 18 and $095 at column 151, row 20, both on screen 9.
 */
test.describe('ON/OFF tracks on $005', () => {
  const SCREEN = 9
  // [local column, row, on the track at cell pixel (x, y)]
  const TRACKS = {
    drawnOff: [152 - SCREEN * 16, 18, (x, y) => x + y === 15],
    drawnOn: [151 - SCREEN * 16, 20, (x, y) => x === y],
  }

  /**
   * How many of a track's 16 pixels the L1 planes draw at full alpha and in the screen door. Read from the planes
   * themselves (255 drawn, 64 in the screen door, 0 clear), not from the composited screen:
   * the ghost is within 64 of what lies under it, not of any one color.
   */
  async function strong(page, [col, row, onTrack]) {
    return page.evaluate(
      ({ rootSel, screen, col, row, anti }) => {
        const on = anti ? (x, y) => x + y === 15 : (x, y) => x === y
        const planes = ['l1Low', 'l1High']
          .map(p =>
            document.querySelector(`${rootSel} canvas[data-screen="${screen}"][data-plane="${p}"]`),
          )
          .filter(Boolean)
          .map(c => c.getContext('2d').getImageData(0, 0, c.width, c.height))
        const n = { full: 0, dim: 0 }
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++) {
            const i = ((row * 16 + y) * planes[0].width + col * 16 + x) * 4 + 3
            if (!on(x, y)) continue
            if (planes.some(d => d.data[i] === 255)) n.full++
            else if (planes.some(d => d.data[i] === 64)) n.dim++
          }
        return n
      },
      { rootSel: root(0x005), screen: SCREEN, col, row, anti: onTrack(15, 0) },
    )
  }

  test('each track draws in full only in its own state and in the screen door in the other', async ({
    page,
  }) => {
    const project = await createProject(page, path.join(tmp, 'MyHack'))
    await openMap(page, project.manifestPath, 0x005)
    await showScreen(page, 0x005, SCREEN)
    const off = [await strong(page, TRACKS.drawnOff), await strong(page, TRACKS.drawnOn)]
    await page.locator(`${root(0x005)} [data-control="switch-onOff"]`).click()
    await expect(page.locator(`${root(0x005)} canvas[data-screen="${SCREEN}"][data-plane="l1Low"]`)).toHaveAttribute('data-drawn', /^\d+:0000:001:9$/) // prettier-ignore
    const on = [await strong(page, TRACKS.drawnOff), await strong(page, TRACKS.drawnOn)]
    // Not vacuous: a drawn track is strong at nearly every pixel (a sprite may cross one).
    expect(off[0].full).toBeGreaterThanOrEqual(12)
    expect(on[1].full).toBeGreaterThanOrEqual(12)
    // Hidden: the screen door's 25% is there (a blank track would fail), and no strong pixel.
    for (const hidden of [off[1], on[0]]) {
      expect(hidden.full).toBe(0)
      expect(hidden.dim).toBeGreaterThan(0)
    }
  })
})

/**
 * The zoom anchor survives a screen reply that lands between a zoom change and the React commit that
 * lays the strip out at it (#547 plant 1: `restoreAnchor` called from `sync`). The reply's
 * continuation is a microtask, so releasing a held reply in the same task as the click runs it ahead
 * of the commit, on the old layout. The other half of the issue (the `renderedZoom` guard) is ruled
 * unreachable from UI input: docs/decisions/2026-10-08-zoom-anchor-race-seam.md.
 *
 * Judged on the CONTENT pixel under the view centre, like the #526 button tests: a Zoom In keeps it
 * fixed. An anchor restored early (on the old layout) is gone when the right commit lands, and the
 * centre drifts by thousands of pixels.
 */
test.describe('zoom anchor across the commit gap (#547)', () => {
  for (const index of [0x105, 0x109]) {
    test(`$${index.toString(16)}: a screen reply landing before the Zoom In commit does not consume the anchor`, async ({
      page,
    }) => {
      const project = await createProject(page, path.join(tmp, 'MyHack'))
      await openMap(page, project.manifestPath, index)
      await settled(page, index)
      await page.locator(`${root(index)} [data-control="zoom-actual"]`).click()
      await expect.poll(() => zoomOf(page, index)).toBe(1)
      await settled(page, index)
      // Scrolled 60% along the main axis, so the anchor is far from the origin.
      await page.evaluate(
        ({ sel, f }) => {
          const el = document.querySelector(`${sel} [data-control="map-scroller"]`)
          el.scrollLeft = (el.scrollWidth - el.clientWidth) * f
          el.scrollTop = (el.scrollHeight - el.clientHeight) * f
        },
        { sel: root(index), f: 0.6 },
      )
      await settled(page, index)
      const before = await probeView(page, index)

      // Hold every screen reply. The stub replaces what w.projects POINTS TO (docs/testing.md
      // "Playwright and RPC"); the real reply is fetched, then parked until released.
      await page.evaluate(id => {
        const w = getSvc('ApplicationShell').getWidgetById(`hackbench.map-view:${id}`)
        const real = w.projects
        const release = (window.hbRelease = [])
        w.projects = new Proxy(real, {
          get: (t, k) =>
            k === 'mapScreen'
              ? (...a) => real.mapScreen(...a).then(r => new Promise(res => release.push(() => res(r)))) // prettier-ignore
              : (...a) => real[k](...a),
        })
        w.hbRealProjects = real
        w.refresh() // clears the screen cache and asks for the visible ones again
      }, index)
      await expect.poll(() => page.evaluate(() => window.hbRelease.length)).toBeGreaterThan(0)

      const seen = await page.evaluate(
        async ({ sel, id }) => {
          const w = getSvc('ApplicationShell').getWidgetById(`hackbench.map-view:${id}`)
          const scroller = document.querySelector(`${sel} [data-control="map-scroller"]`)
          const rendered = () => scroller.getAttribute('data-rendered-zoom')
          const pendingBefore = w.pending.size
          document.querySelector(`${sel} [data-control="zoom-in"]`).click()
          const atClick = { rendered: rendered(), zoom: w.zoomController.value }
          window.hbRelease.splice(0).forEach(f => f())
          // The continuations (fetchScreen, then sync) are microtasks: they run in this drain.
          for (let i = 0; i < 20; i++) await Promise.resolve()
          return {
            pendingBefore,
            pendingAfter: w.pending.size,
            atClick,
            renderedAfterReply: rendered(),
            zoomAfterReply: w.zoomController.value,
          }
        },
        { sel: root(index), id: index },
      )
      // Preconditions: replies were in flight, they were consumed, and the committed zoom was still
      // the old one while the controller already held the new one.
      expect(seen.pendingBefore, 'replies were held').toBeGreaterThan(0)
      expect(seen.pendingAfter, 'the replies were processed before the commit').toBe(0)
      expect(seen.atClick.rendered).toBe('1')
      expect(seen.renderedAfterReply, 'no commit landed before the replies ran').toBe('1')
      expect(seen.zoomAfterReply, 'the controller already moved on').toBe(2)

      await expect.poll(() => zoomOf(page, index)).toBe(2)
      await settled(page, index)
      const after = await probeView(page, index)
      expect(Math.abs(after.content - before.content)).toBeLessThan(1)
    })
  }
})
