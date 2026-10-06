/**
 * HackBench: painting GFX tiles, end to end against the shell.
 *
 * Strokes are widget state until Save; Save sends ONE gfx op layer, so what
 * these tests read back is (a) the canvas, (b) the layer file on disk replayed
 * in Node by the same core the backend uses, and (c) the base ROM's hash. All
 * pointer work goes through real mouse events on the canvas, so a canvas that
 * ignores the pointer fails, which an "is it on screen" check would not.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const nodeCrypto = require('crypto')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const ROM = process.env.HB_ROM || romPath(VANILLA)

const { loadLayers } = require('../../extension/lib/src/project/OpsStore')
const { WorkingRom } = require('../../extension/lib/src/project/WorkingRom')
const { GfxTable } = require('../../extension/lib/src/rom/GfxTable')
const { RomFile } = require('../../extension/lib/src/rom/RomFile')

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
}`

const FILE = 0
/** Two pixels in two different 8x8 characters (tiles 0 and 1) of GFX 00. */
const P1 = { x: 3, y: 5 }
const P2 = { x: 11, y: 5 }

let tmp

async function boot(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-paint-'))
  await boot(page)
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page, name) {
  const directory = path.join(tmp, name)
  const project = await page.evaluate(
    ({ rom, directory, projectName }) =>
      getSvc('Symbol(ProjectService)').createProject({
        romPath: rom,
        name: projectName,
        directory,
      }),
    { rom: ROM, directory, projectName: name },
  )
  return { manifestPath: project.manifestPath, directory }
}

/** Open GFX file FILE in a pinned tab, as a double click leaves it, and wait for its canvas. */
async function openSheet(page, manifestPath) {
  await page.evaluate(
    async ({ mp, i }) => {
      await (await getWidget('hackbench.gfx-explorer')).load(mp)
      await getSvc('PreviewTabs').pin(
        'hackbench.gfx-view',
        { index: i },
        w => w.open({ manifestPath: mp, index: i, label: `GFX ${i}` }),
        p => p.shows(i),
        {},
      )
    },
    { mp: manifestPath, i: FILE },
  )
  await page.waitForSelector('#hb-gfx-canvas', { timeout: 15000 })
  await expect(page.locator('#hb-gfx-swatch-1')).toBeVisible()
}

const pixelAt = (page, { x, y }) =>
  page.evaluate(
    ({ x, y }) => {
      const c = document.querySelector('#hb-gfx-canvas')
      return Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data)
    },
    { x, y },
  )

/** Screen position of the middle of sheet pixel (x, y), from the canvas's own box. */
async function screenPoint(page, { x, y }) {
  const b = await page.locator('#hb-gfx-canvas').boundingBox()
  const w = await page.evaluate(() => document.querySelector('#hb-gfx-canvas').width)
  const k = b.width / w
  return { x: b.x + (x + 0.5) * k, y: b.y + (y + 0.5) * k }
}

/** One stroke: pointer down, up. */
async function stroke(page, pixel) {
  const p = await screenPoint(page, pixel)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** A palette index whose color is opaque and differs from the pixels in `at`, and that color. */
async function pickColor(page, at) {
  const before = await Promise.all(at.map(p => pixelAt(page, p)))
  const colors = await page.evaluate(() =>
    getSvc('WidgetManager')
      .getWidgets('hackbench.gfx-view')[0]
      .sheet.paletteColors.map(c => [c.r, c.g, c.b, c.a]),
  )
  const index = colors.findIndex(
    (c, i) => i > 0 && c[3] > 0 && before.every(b => b.join() !== c.join()),
  )
  expect(index, 'no opaque color differs from the pixels under test').toBeGreaterThan(0)
  await page.click(`#hb-gfx-swatch-${index}`)
  return { index, rgba: colors[index], before }
}

const sha = file => nodeCrypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const opFiles = dir => {
  const d = path.join(dir, 'ops')
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : []
}

/** The pixel's palette index after replaying the project's layers from disk onto the ROM. */
function indexOnDisk(directory, { x, y }, tile) {
  const bytes = new Uint8Array(fs.readFileSync(ROM))
  const w = new WorkingRom(bytes, RomFile.fromBytes(ROM, Buffer.from(bytes)).hasHeader)
  w.restore(loadLayers(directory))
  const table = GfxTable.load(RomFile.fromBytes('w.sfc', Buffer.from(w.bytes())))
  return table.tile(FILE, tile)[(y & 7) * 8 + (x & 7)]
}

const projectSvc = (page, method, mp) =>
  page.evaluate(([m, p]) => getSvc('Symbol(ProjectService)')[m](p), [method, mp])

test('paint, Save, reopen: the pixel reads back, from the canvas and from disk', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'RoundTrip')
  await openSheet(page, manifestPath)
  const { index, rgba, before } = await pickColor(page, [P1])

  await stroke(page, P1)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'true')
  expect(opFiles(directory), 'nothing reaches the project before Save').toHaveLength(0)

  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'false')
  expect(opFiles(directory)).toHaveLength(1)
  expect(indexOnDisk(directory, P1, 0)).toBe(index)

  await boot(page)
  await openSheet(page, manifestPath)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  expect(rgba).not.toEqual(before[0])
})

test('Save never writes the base ROM', async ({ page }) => {
  const { manifestPath } = await createProject(page, 'BaseHash')
  const hash = sha(ROM)
  await openSheet(page, manifestPath)
  await pickColor(page, [P1])
  await stroke(page, P1)
  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')

  expect(sha(ROM)).toBe(hash)
  await projectSvc(page, 'undo', manifestPath)
  expect(sha(ROM)).toBe(hash)
})

test('strokes on two characters, one Save: one layer, one undo removes both, redo restores both', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'TwoChars')
  await openSheet(page, manifestPath)
  const { index, rgba, before } = await pickColor(page, [P1, P2])

  await stroke(page, P1)
  await stroke(page, P2)
  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  expect(opFiles(directory), 'one Save is one layer').toHaveLength(1)
  // Both characters, replayed from the layer file by the core, not read off the canvas.
  expect(indexOnDisk(directory, P1, 0)).toBe(index)
  expect(indexOnDisk(directory, P2, 1)).toBe(index)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  expect(await pixelAt(page, P2)).toEqual(rgba)

  const undone = await projectSvc(page, 'undo', manifestPath)
  expect(undone.canUndo, 'a single undo emptied the stack').toBe(false)
  await expect.poll(() => pixelAt(page, P1)).toEqual(before[0])
  await expect.poll(() => pixelAt(page, P2)).toEqual(before[1])

  await projectSvc(page, 'redo', manifestPath)
  await expect.poll(() => pixelAt(page, P1)).toEqual(rgba)
  await expect.poll(() => pixelAt(page, P2)).toEqual(rgba)
})

test('painting without Save, then reopening, shows the original pixel', async ({ page }) => {
  const { manifestPath, directory } = await createProject(page, 'Unsaved')
  await openSheet(page, manifestPath)
  const { rgba, before } = await pickColor(page, [P1])
  await stroke(page, P1)
  expect(await pixelAt(page, P1)).toEqual(rgba)

  await boot(page)
  await openSheet(page, manifestPath)
  expect(await pixelAt(page, P1)).toEqual(before[0])
  expect(opFiles(directory)).toHaveLength(0)
})

test('stroke undo before Save reverts the pixel, and stroke redo restores it', async ({ page }) => {
  const { manifestPath, directory } = await createProject(page, 'StrokeUndo')
  await openSheet(page, manifestPath)
  const { rgba, before } = await pickColor(page, [P1])

  await stroke(page, P1)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  await page.click('#hb-gfx-stroke-undo')
  expect(await pixelAt(page, P1)).toEqual(before[0])
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'false')
  await expect(page.locator('#hb-gfx-save')).toBeDisabled()

  await page.click('#hb-gfx-stroke-redo')
  expect(await pixelAt(page, P1)).toEqual(rgba)
  await expect(page.locator('#hb-gfx-save')).toBeEnabled()
  expect(opFiles(directory)).toHaveLength(0)
})

test("closing with unsaved strokes asks, and Don't save discards them", async ({ page }) => {
  const { manifestPath } = await createProject(page, 'CloseAsk')
  await openSheet(page, manifestPath)
  const { before } = await pickColor(page, [P1])
  await stroke(page, P1)

  // Not awaited in the page: close() resolves only after the dialog is answered.
  await page.evaluate(() => {
    getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0].close()
  })
  const dialog = page.locator('.dialogOverlay').first()
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: /don.t save/i }).click()
  await expect(page.locator('#hb-gfx-canvas')).toHaveCount(0)

  await openSheet(page, manifestPath)
  expect(await pixelAt(page, P1)).toEqual(before[0])
})

const strokeCount = page =>
  page.evaluate(() => getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0].strokes.length)

const widgetState = page =>
  page.evaluate(() => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    return { bpp: w.sheet && w.sheet.bpp, error: w.error || null, dirty: w.dirty }
  })

/** Pick a depth other than the file's own, and wait until the sheet is decoded at it. */
async function forceOtherDepth(page, pick) {
  const own = (await widgetState(page)).bpp
  const other = pick(own)
  await page.selectOption('#hb-gfx-bpp-select', String(other))
  await expect.poll(async () => (await widgetState(page)).bpp).toBe(other)
  return { own, other }
}

test("choosing another depth and then the file's own depth turns painting back on", async ({
  page,
}) => {
  const { manifestPath } = await createProject(page, 'DepthRoundTrip')
  await openSheet(page, manifestPath)
  const { own } = await forceOtherDepth(page, b => (b === 4 ? 3 : 4))
  await expect(page.locator('#hb-gfx-swatches'), 'a forced depth offers no painting').toHaveCount(0)

  await page.selectOption('#hb-gfx-bpp-select', String(own))
  await expect.poll(async () => (await widgetState(page)).bpp).toBe(own)
  await expect(page.locator('#hb-gfx-swatch-1')).toBeVisible()
  const { rgba } = await pickColor(page, [P1])
  await stroke(page, P1)
  expect(await pixelAt(page, P1)).toEqual(rgba)
})

test('a forced deeper depth with strokes pending breaks nothing, and the strokes survive', async ({
  page,
}) => {
  const errors = []
  page.on('pageerror', e => errors.push(String(e)))
  const { manifestPath } = await createProject(page, 'DeeperForce')
  await openSheet(page, manifestPath)
  const P3 = { x: 3, y: 60 } // tile row 7: past the end of a deeper (shorter) sheet of this file
  const { rgba } = await pickColor(page, [P1, P3])
  await stroke(page, P1)
  await stroke(page, P3)
  expect(await pixelAt(page, P3)).toEqual(rgba)

  const { own } = await forceOtherDepth(page, b => (b === 4 ? 3 : 4))
  const forced = await page.evaluate(({ x, y }) => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    const i = (y * w.sheet.width + x) * 4
    return { height: w.sheet.height, base: Array.from(w.baseRgba.slice(i, i + 4)) }
  }, P1)
  test.skip(forced.height > P3.y, "this ROM's file 0 gives no sheet short enough at another depth")
  expect((await widgetState(page)).error).toBeNull()
  expect(errors).toEqual([])
  // The overlay is for the file's own layout only: over another depth's sheet
  // the same pixel position is a different pixel.
  expect(forced.base).not.toEqual(rgba)
  expect(await pixelAt(page, P1)).toEqual(forced.base)

  await page.selectOption('#hb-gfx-bpp-select', String(own))
  await expect.poll(async () => (await widgetState(page)).bpp).toBe(own)
  expect(await pixelAt(page, P3)).toEqual(rgba)
  expect((await widgetState(page)).dirty).toBe(true)
})

test('a pixel in the second tile row, painted at a zoom other than the default, saves to the right character', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'RowTwo')
  await openSheet(page, manifestPath)
  await page.click('[data-control="zoom-out"]')
  const P4 = { x: 5, y: 12 } // tile row 1, column 0: tile 16, pixel (5, 4)
  const { index, rgba } = await pickColor(page, [P4])
  const box = await page.locator('#hb-gfx-canvas').boundingBox()
  const w = await page.evaluate(() => document.querySelector('#hb-gfx-canvas').width)
  expect(box.width / w, 'a zoom other than 1x and the default 4x').toBe(3)
  await stroke(page, P4)
  expect(await pixelAt(page, P4)).toEqual(rgba)
  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  expect(indexOnDisk(directory, P4, 16)).toBe(index)
})

/** Replace the widget's saveGfx with one that waits for window.__release(). */
const stallSave = page =>
  page.evaluate(() => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    const real = w.gfx
    window.__release = undefined
    w.gfx = new Proxy(real, {
      get: (t, k) => {
        if (k === 'saveGfx')
          return (...a) => new Promise(res => (window.__release = () => res(t.saveGfx(...a))))
        const v = t[k]
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  })

const redoFiles = dir => {
  const d = path.join(dir, 'ops', 'redo')
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')) : []
}

test('painting and stroke undo are blocked while a Save is in flight, and nothing is lost', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'SaveInFlight')
  await openSheet(page, manifestPath)
  const { rgba, before } = await pickColor(page, [P1, P2])
  await stroke(page, P1)
  await stallSave(page)
  await page.click('#hb-gfx-save')
  await expect.poll(() => page.evaluate(() => !!window.__release)).toBe(true)

  await stroke(page, P2) // blocked
  expect(await pixelAt(page, P2)).toEqual(before[1])
  expect(await strokeCount(page), 'a stroke during a Save is refused').toBe(1)
  await page.keyboard.press('Control+z') // blocked
  expect(await strokeCount(page), 'stroke undo during a Save is refused').toBe(1)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  expect(opFiles(directory), 'no layer moved while the Save was stalled').toHaveLength(0)

  await page.evaluate(() => window.__release())
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  expect(opFiles(directory)).toHaveLength(1)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  expect(await pixelAt(page, P2)).toEqual(before[1])
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'false')
})

test('Ctrl+Z during an in-flight Save does not undo the project layer below it', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'SaveInFlightKeys')
  await page.evaluate(mp => (getSvc('ProjectContext').current = { manifestPath: mp }), manifestPath)
  await openSheet(page, manifestPath)
  const { rgba } = await pickColor(page, [P1, P2])
  await stroke(page, P1)
  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  await stroke(page, P2)
  await stallSave(page)
  await page.click('#hb-gfx-save')
  await expect.poll(() => page.evaluate(() => !!window.__release)).toBe(true)

  await page.keyboard.press('Control+z') // must do nothing at all
  await page.waitForTimeout(500)
  await page.evaluate(() => window.__release())
  await expect(page.locator('#hb-gfx-dirty')).toHaveAttribute('data-dirty', 'false')
  await expect.poll(() => opFiles(directory).length).toBe(2)
  expect(redoFiles(directory), 'nothing was undone into ops/redo').toHaveLength(0)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  expect(await pixelAt(page, P2)).toEqual(rgba)
})

test('a reload pushed in the middle of a drag keeps the pixels already drawn', async ({ page }) => {
  const { manifestPath } = await createProject(page, 'ReloadMidDrag')
  await openSheet(page, manifestPath)
  const { rgba } = await pickColor(page, [P1])
  const p = await screenPoint(page, P1)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.evaluate(() => getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0].reload())
  await page.waitForTimeout(500)
  expect(await pixelAt(page, P1)).toEqual(rgba)
  await page.mouse.up()
  expect((await widgetState(page)).dirty).toBe(true)
})

test('Ctrl+Z and Ctrl+Y walk the strokes before Save, and Ctrl+Z undoes the layer after it', async ({
  page,
}) => {
  const { manifestPath, directory } = await createProject(page, 'Keys')
  await page.evaluate(mp => (getSvc('ProjectContext').current = { manifestPath: mp }), manifestPath)
  await openSheet(page, manifestPath)
  const { rgba, before } = await pickColor(page, [P1])
  await stroke(page, P1)

  await page.keyboard.press('Control+z')
  await expect.poll(() => pixelAt(page, P1)).toEqual(before[0])
  expect(opFiles(directory)).toHaveLength(0)
  await page.keyboard.press('Control+y')
  await expect.poll(() => pixelAt(page, P1)).toEqual(rgba)

  await page.click('#hb-gfx-save')
  await expect(page.locator('#hb-gfx-save-message')).toHaveAttribute('data-status', 'ok')
  expect(opFiles(directory)).toHaveLength(1)
  await page.evaluate(() =>
    getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0].node.focus(),
  )
  await page.keyboard.press('Control+z')
  await expect.poll(() => opFiles(directory).length).toBe(0)
  await expect.poll(() => pixelAt(page, P1)).toEqual(before[0])
})

/** Stall gfxSheet until window.__sheetRelease() is called; other calls pass through. */
const stallSheet = page =>
  page.evaluate(() => {
    const w = getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0]
    const real = w.gfx
    w.gfx = new Proxy(real, {
      get: (t, k) => {
        if (k === 'gfxSheet')
          return (...a) => new Promise(res => (window.__sheetRelease = () => res(t.gfxSheet(...a))))
        const v = t[k]
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  })

test("painting stays off until the file's own depth has actually loaded", async ({ page }) => {
  const { manifestPath } = await createProject(page, 'OwnDepthLoading')
  await openSheet(page, manifestPath)
  const { own } = await forceOtherDepth(page, b => (b === 4 ? 3 : 4))
  await stallSheet(page)
  await page.evaluate(
    v =>
      getSvc('WidgetManager')
        .getWidgets('hackbench.gfx-view')[0]
        .handleBppChange({ target: { value: v } }),
    String(own),
  )
  const canPaint = () =>
    page.evaluate(() => getSvc('WidgetManager').getWidgets('hackbench.gfx-view')[0].canPaint)
  expect(await canPaint(), 'the forced sheet is still on screen').toBe(false)
  await page.evaluate(() => window.__sheetRelease())
  await expect.poll(canPaint).toBe(true)
})

test("a depth chosen before the first sheet arrives still lets the file's own depth paint", async ({
  page,
}) => {
  const { manifestPath } = await createProject(page, 'EarlyDepth')
  const out = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.gfx-view')
    const files = await getSvc('Symbol(GfxService)').listGfxFiles(mp)
    const own = files.files[0].defaultBpp
    const other = own === 4 ? 3 : 4
    const opened = w.open({ manifestPath: mp, index: 0, label: 'GFX 0' })
    w.handleBppChange({ target: { value: String(other) } }) // before any sheet
    await opened
    await new Promise(r => setTimeout(r, 1500))
    w.handleBppChange({ target: { value: String(own) } })
    await new Promise(r => setTimeout(r, 1500))
    return { own, bpp: w.sheet && w.sheet.bpp, canPaint: w.canPaint }
  }, manifestPath)
  expect(out.bpp).toBe(out.own)
  expect(out.canPaint).toBe(true)
})
