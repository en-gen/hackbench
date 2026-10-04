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
const MAP_PLANES = ['l2Low', 'l1Low', 'l2High', 'l1High']
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
 * A layer toggle's face: pressed, named, and the owner's icon with its own bar (top, middle or
 * bottom) in the button's color and the others dimmed.
 */
async function expectLayerToggle(page, index, control, label, bar) {
  const button = page.locator(`${root(index)} [data-control="${control}"]`)
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveAttribute('aria-label', label)
  await expect(button).toHaveAttribute('title', label)
  const bars = await button
    .locator('svg rect')
    .evaluateAll(rs => rs.map(r => ({ y: r.getAttribute('y'), fill: getComputedStyle(r).fill })))
  const color = await button.evaluate(b => getComputedStyle(b).color)
  expect(bars.map(b => b.y)).toEqual(['1', '6', '11'])
  bars.forEach((b, i) => (i === bar ? expect(b.fill).toBe(color) : expect(b.fill).not.toBe(color)))
  return button
}

test('the L1 toggle hides and restores the foreground, per tab', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await expectEveryVisibleScreenDrawn(page, 0x105)
  const l1 = await expectLayerToggle(page, 0x105, 'layer-l1', 'Foreground', 1)
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
  // With the background off as well, only the back area is left.
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  const hidden = await shownPixels(page, strip)
  expect(hidden.colors).toBe(1)
  expect(hidden.color).toBe(backdrop)

  await openMap(page, project.manifestPath, 0x106)
  await expect(page.locator(`${root(0x106)} [data-control="layer-l1"]`)).toHaveAttribute('aria-pressed', 'true') // prettier-ignore
  await activate(page, 0x105)
  await l1.click()
  await page.locator(`${root(0x105)} [data-control="layer-l2"]`).click()
  await expect(l1).toHaveAttribute('aria-pressed', 'true')
  for (const plane of planeLocators(page, 0x105, 0, MAP_PLANES))
    await expect(plane).toHaveCSS('visibility', 'visible')
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
  const l2 = await expectLayerToggle(page, 0x105, 'layer-l2', 'Background', 2)
  const strip = page.locator(`${root(0x105)} [data-control="map-scroller"]`)
  // Back to front: Background, then Foreground, beside each other.
  const order = await page
    .locator(`${root(0x105)} .hb-map-view-toolbar [data-control^="layer-"]`)
    .evaluateAll(bs => bs.map(b => b.dataset.control))
  expect(order).toEqual(['layer-l2', 'layer-l1'])
  // A visible separator sits between Foreground and the first switch toggle, by DOM order.
  const sep = await page.evaluate(rootSel => {
    const bar = document.querySelector(`${rootSel} .hb-map-view-toolbar`)
    const kids = [...bar.children]
    const at = c => kids.findIndex(k => k.dataset.control === c)
    const el = kids.find(k => k.dataset.control === 'toolbar-sep')
    const r = el.getBoundingClientRect()
    return { between: at('toolbar-sep') === at('layer-l1') + 1 && at('toolbar-sep') < at('palace-yellow'), w: r.width, h: r.height } // prettier-ignore
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
 * BG mode 1 stacks BG1 high > BG2 high > BG1 low > BG2 low (map-screen's
 * MAP_PLANE_KEYS). Read from the computed z-index, not the source order. No
 * vanilla or magic-ROM slot draws an l2High pixel (swept: 0 of 488 maps each),
 * so there is no corpus screen to check the order on pixels; the unit tests
 * pin which plane a priority subtile lands in on synthetic data.
 */
test('the canvas stack is l2Low, l1Low, l2High, l1High, bottom to top', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const stack = await page
    .locator(`${root(0x105)} canvas[data-screen="0"]`)
    .evaluateAll(cs =>
      cs
        .map(c => ({ plane: c.dataset.plane, z: Number(getComputedStyle(c).zIndex) }))
        .sort((a, b) => a.z - b.z),
    )
  expect(stack.map(c => c.plane)).toEqual(['l2Low', 'l1Low', 'l2High', 'l1High'])
  expect(new Set(stack.map(c => c.z)).size, 'four distinct levels').toBe(4)
  expect(stack[0].z).toBeGreaterThan(0)
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
 * from the canvases in their z-index order, so reordering MAP_PLANE_KEYS turns this red.
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
        const by = k => planes.find(c => c.dataset.plane === k)
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
      async ({ mp, next }) => {
        const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:261')
        await w.open({ manifestPath: mp, index: next, label: next.toString(16), iconClass: '' })
      },
      { mp: project.manifestPath, next },
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
