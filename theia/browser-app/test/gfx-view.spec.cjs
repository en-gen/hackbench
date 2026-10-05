/**
 * Loading and viewing GFX files, end to end against the shell.
 *
 * Modelled on load-maps.spec.cjs. The defect this guards against is a canvas
 * that renders but shows nothing real: an all-black or all-transparent paint
 * passes any "did it render" check, so every canvas assertion here reads the
 * pixels back and checks for actual variation and coverage.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords, makeUntitledAndUnlocated } = require('./rom-words.cjs')
const { expectCheckerboard } = require('./pixel-canvas.cjs')
const { readGrid, shootCanvas, compositedGridDiff } = require('./grid-probe.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, INVICTUS } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
/** A hack that replaced the LC_LZ2 decompressor, so the read gate refuses
 * every GFX file (#487), unlike every other ROM in the corpus. */
const INVICTUS_ROM = process.env.HB_ROM_INVICTUS || romPath(INVICTUS)

/**
 * GfxLoader.GFX_FILE_COUNT for vanilla: GFXFilesHigh ($00B9C4) minus
 * GFXFilesLow ($00B992) = 50 (bank_00.asm:6415,6467) -- the split pointer
 * tables the loader reads, not an assumed figure.
 */
const VANILLA_GFX_FILES = 50

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  const wm = getSvc('WidgetManager')
  return wm.getOrCreateWidget(id)
}`

let tmp

/**
 * Bring the Graphics view to the front, as clicking its tab does.
 *
 * Activation matters: the tree virtualises its rows, so a widget that is
 * attached but not visible renders zero of them however full its model is.
 */
async function revealGfx(page) {
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.gfx-explorer')
  })
  await page.waitForTimeout(800)
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-gfx-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page, dir, name = 'MyHack', rom = ROM) {
  return page.evaluate(
    async ({ romPath, directory, projectName }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: projectName, directory })
    },
    { romPath: rom, directory: dir, projectName: name },
  )
}

/**
 * Create a project and load its GFX files, returning what the widget holds.
 *
 * `rows` is every tree row INCLUDING the two Map16 rows that now sit above
 * the GFX file list (map16-view.spec.cjs covers them); `fileRows` is
 * `rows` filtered to `kind === 'file'`, which is what every GFX-file-only
 * assertion in this spec actually wants.
 */
async function loadGfx(page, dir, rom = ROM) {
  const project = await createProject(page, dir, 'MyHack', rom)
  const result = await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(manifestPath)
    return {
      manifestPath,
      fileCount: w.fileCount,
      rows: (w.model.root.children || []).map(n => ({
        index: n.index,
        hex: n.hex,
        tileCount: n.tileCount,
        bpp: n.bpp,
        kind: n.kind,
      })),
    }
  }, project.manifestPath)
  return { ...result, fileRows: result.rows.filter(r => r.kind === 'file') }
}

/** How many non-file rows sit above the GFX list: Map16 Foreground and
 *  Map16 Background (gfx-explorer-widget.tsx's MAP16_ROWS). */
const MAP16_ROW_COUNT = 2

/** The first GFX FILE row's locator - the Map16 rows sit above the list. */
function firstGfxFileRow(page) {
  return page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').nth(MAP16_ROW_COUNT)
}

/** The `n`th GFX FILE row (0-based), same offset as `firstGfxFileRow`. */
function gfxFileRow(page, n) {
  return page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').nth(MAP16_ROW_COUNT + n)
}

/** One GFX view widget's dom root, keyed by file index - GFX_VIEW_ID in gfx-view-widget.tsx. */
function gfxViewRoot(index) {
  return `[id="hackbench.gfx-view:${index}"]`
}

test('the graphics view has nothing to show until a project is open', async ({ page }) => {
  await revealGfx(page)

  const state = await page.evaluate(async () => {
    const w = await getWidget('hackbench.gfx-explorer')
    return { fileCount: w.fileCount, rows: (w.model.root.children || []).map(n => n.name) }
  })

  expect(state.fileCount).toBe(0)
  expect(state.rows.join(' ')).toMatch(/open a project/i)
})

test('a new project lists every GFX file its cartridge holds', async ({ page }) => {
  const result = await loadGfx(page, path.join(tmp, 'MyHack'))

  expect(result.fileCount).toBe(VANILLA_GFX_FILES)
  // Both Map16 tables sit above the file list, one row each
  // (map16-view.spec.cjs covers those rows themselves).
  expect(result.rows.length).toBe(VANILLA_GFX_FILES + MAP16_ROW_COUNT)
  expect(result.rows.slice(0, MAP16_ROW_COUNT).every(r => r.kind === 'map16')).toBe(true)
  expect(result.fileRows.length).toBe(VANILLA_GFX_FILES)
  expect(result.fileRows.every(r => r.kind === 'file')).toBe(true)

  for (const r of result.fileRows) {
    expect(r.tileCount).toBeGreaterThan(0)
    expect([2, 3, 4, 'mode7']).toContain(r.bpp)
  }
  // Every file addressable, not collapsed onto a shared row id.
  expect(new Set(result.fileRows.map(r => r.index)).size).toBe(VANILLA_GFX_FILES)
  expect(result.fileRows[0].hex).toBe('00')
})

test('the GFX rows are rendered and reachable, not just in the model', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  // The tree virtualises its rows (react-virtuoso), so this checks that some
  // rows made it to the DOM, not that all 50 did -- the model-level test
  // above already covers the exact count.
  const rows = await page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').count()
  expect(rows).toBeGreaterThan(2)

  // `.hb-gfx-id` deliberately excludes the Map16 rows (own classes, see
  // gfx-explorer-widget.tsx), so every match here is still a GFX $XX file.
  const ids = await page.locator('#hackbench\\.gfx-explorer .hb-gfx-id').allTextContents()
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) expect(id).toMatch(/^GFX \$[0-9A-F]{2}$/)
})

test('clicking a row opens a canvas with real, non-uniform pixel data', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)

  const info = await readCanvas(page)

  expect(info.width).toBeGreaterThan(0)
  expect(info.height).toBeGreaterThan(0)
  // The failure mode this guards: an all-black or all-transparent canvas,
  // which "it rendered" checks cannot see.
  expect(info.distinctColors).toBeGreaterThan(1)
  expect(info.opaquePixels).toBeGreaterThan(0)

  // The status line's tile count must agree with the model's, not just look
  // like a number.
  const summary = await page.locator('.hb-gfx-view-summary').textContent()
  expect(summary).toMatch(/\d+ tiles/)
})

/** Color 0 is transparent; what shows through is a checkerboard, not a flat panel color. */
test('color 0 shows a transparency checkerboard', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)
  await expectCheckerboard(expect, page, '.hb-gfx-view-canvas')
})

/**
 * Closing and reopening the view, then clicking a row.
 *
 * The explorer is user-closable and its WidgetFactory builds a fresh
 * instance (with its own onFileOpened emitter) on reopen. A subscription
 * taken once at startup against whichever instance existed then goes
 * silently dead here: the click does nothing and this test times out
 * waiting for the canvas instead of failing an assertion.
 */
test('closing and reopening the Graphics view still wires row clicks', async ({ page }) => {
  const result = await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  await page.evaluate(async () => {
    await getSvc('ApplicationShell').closeWidget('hackbench.gfx-explorer')
  })
  await page.waitForTimeout(500)

  // Reopen the way a user actually does: the activity-bar icon's toggle
  // command. This is what re-attaches a fresh widget to the shell; calling
  // getOrCreateWidget directly (as the old revealGfx-only version of this
  // test did) leaves the new instance unattached and the test times out for
  // the wrong reason before it ever reaches the click.
  await page.evaluate(async () => {
    await getSvc('CommandRegistry').executeCommand('hackbench.gfx.focus')
  })
  await page.waitForTimeout(500)

  await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(manifestPath)
  }, result.manifestPath)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)

  const info = await readCanvas(page)
  expect(info.distinctColors).toBeGreaterThan(1)
})

/**
 * Invictus 1.0 XORs every GFX pointer with a key read from its decompressor
 * prelude, then decodes with a fast LC_LZ2 routine (#603). Every file must
 * list with a depth and open as tile data, with no error. Before #603 all
 * 50 were refused.
 */
test('a ROM with a keyed, fast decompressor lists and draws every file', async ({ page }) => {
  test.skip(!fs.existsSync(INVICTUS_ROM), 'Invictus fixture not present on this machine')

  const result = await loadGfx(page, path.join(tmp, 'InvictusHack'), INVICTUS_ROM)
  expect(result.fileRows.length).toBe(50)
  for (const r of result.fileRows) expect(r.bpp).not.toBeNull()

  await revealGfx(page)
  const row = firstGfxFileRow(page)
  await expect(row.locator('.hb-gfx-meta')).not.toHaveText('unavailable')

  await row.click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)
  await expect(page.locator('.hb-gfx-view-error')).toHaveCount(0)
  expect((await readCanvas(page)).distinctColors).toBeGreaterThan(1)
})

test('switching bit depth re-decodes the sheet, not just its label', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  // File 0 decodes at 3bpp by default (24 bytes/tile); switching to 4bpp
  // (32 bytes/tile) on the SAME raw bytes must change the tile count.
  await firstGfxFileRow(page).click()
  await page.waitForSelector('#hb-gfx-bpp-select', { timeout: 15000 })
  await page.waitForTimeout(500)

  const before = await readCanvas(page)
  const summaryBefore = await page.locator('.hb-gfx-view-summary').textContent()

  await page.selectOption('#hb-gfx-bpp-select', '4')
  await page.waitForTimeout(500)

  const after = await readCanvas(page)
  const summaryAfter = await page.locator('.hb-gfx-view-summary').textContent()

  expect(summaryAfter).not.toBe(summaryBefore)
  expect(after.height).not.toBe(before.height)
})

/**
 * The Mode 7 file (vanilla GFX $27) is packed 3-bit pixels, not bitplanes.
 * Every planar depth paints it as noise, which is the bug this guards, and
 * noise passes any "distinct colors" check. So the oracle is coherence:
 * the share of horizontally adjacent pixels that match. Measured on the
 * vanilla ROM: 0.62 decoded as Mode 7, 0.20 misread as 3bpp.
 */
test('the Mode 7 GFX file opens as Mode 7 and paints coherent art, not noise', async ({ page }) => {
  const MODE7_FILE = 0x27 // CODE_00AB42's LDY operand on the vanilla ROM
  const result = await loadGfx(page, path.join(tmp, 'MyHack'))
  expect(result.rows.find(r => r.index === MODE7_FILE).bpp).toBe('mode7')
  expect(result.rows.filter(r => r.bpp === 'mode7').length).toBe(1)

  await revealGfx(page)
  await page.evaluate(async index => {
    const w = await getWidget('hackbench.gfx-explorer')
    w.fireOpen(
      w.model.root.children.find(n => n.index === index),
      false,
    )
  }, MODE7_FILE)
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)

  expect(await page.locator('#hb-gfx-bpp-select').inputValue()).toBe('mode7')
  const mode7 = await readCanvas(page)

  await page.selectOption('#hb-gfx-bpp-select', '3')
  await page.waitForTimeout(500)
  const planar = await readCanvas(page)

  // Same 24 bytes per tile both ways, so the height alone cannot tell them
  // apart; the pixels must.
  expect(planar.height).toBe(mode7.height)
  expect(mode7.coherence).toBeGreaterThan(0.5)
  expect(mode7.coherence - planar.coherence).toBeGreaterThan(0.2)
})

test('switching the palette row repaints the canvas', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await firstGfxFileRow(page).click()
  await page.waitForSelector('#hb-gfx-palette-row-select', { timeout: 15000 })
  await page.waitForTimeout(500)

  const before = await readCanvas(page)
  await page.selectOption('#hb-gfx-palette-row-select', '9')
  await page.waitForTimeout(500)
  const after = await readCanvas(page)

  // Different CGRAM rows colour real tile data differently; an unchanged
  // checksum over the whole sheet would mean the row picker never reached
  // the decode. Summed over every pixel, not a corner sample, since a corner
  // can legitimately be transparent (index 0) under either row.
  expect(after.checksum).not.toBe(before.checksum)
})

/**
 * The feature's headline cross-view claim: a palette edit made through
 * PaletteService visibly recolours an ALREADY-OPEN GFX sheet, with no
 * manual reload - the entire point of `gfx-push-client.ts` and
 * `WorkingCopyNotifier`. Nothing else in this suite exercises that push
 * path; every other GFX test either never edits a palette, or calls
 * `w.load(...)` itself, which would pass even if the push were dead.
 *
 * GFX file $00 (the first GFX FILE row - the Map16 rows sit above it)
 * decodes at its natural default of 3bpp - see the "switching bit depth"
 * test above. A 3bpp pixel is 3 bits,
 * so decodeGfxSheet can only ever sample palette indices 0-7 out of a
 * CGRAM row's 16; indices 8-15 are not "wrong colour", they are simply
 * never read at this depth, regardless of which row is selected. An
 * earlier version of this test edited col 9 ($00B2CE, Mario's red) and
 * failed for exactly that reason - confirmed by decoding file $00's raw
 * bytes directly (decodeTilesBatch(raw, 3)) and checking which indices
 * the real tile data actually uses: {0,1,2,3,4,5,6,7}, never 9. That is a
 * bad test, not a broken push path.
 *
 * col 6 - PlayerColors' first entry, $00B2C8, $635F vanilla
 * (PLAYER_COL_START in PaletteLoader.ts; bank_00.asm:6163) - lands on
 * index 6, which the same raw-bytes check confirms file $00 does use at
 * 3bpp.
 */
test('a palette edit visibly recolours an already-open GFX sheet, with no manual reload', async ({
  page,
}) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(manifestPath)
  }, project.manifestPath)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  await firstGfxFileRow(page).click()
  await page.waitForSelector('#hb-gfx-palette-row-select', { timeout: 15000 })
  await page.waitForTimeout(500)

  // PlayerColors is CGRAM row 8. Leave bit depth at its default (3bpp for
  // file $00) rather than forcing 4bpp: the point is that an ordinary,
  // already-open sheet repaints, not a depth the user had to pick first.
  await page.selectOption('#hb-gfx-palette-row-select', '8')
  await page.waitForTimeout(500)
  const before = await readCanvas(page)

  // Edit through PaletteService directly - the palette VIEW is not open at
  // all, so this is unambiguously the push path and not some coincidental
  // shared in-memory reference the widget already held.
  const setColorResult = await page.evaluate(async manifestPath => {
    const svc = getSvc('Symbol(PaletteService)')
    return svc.setColor(manifestPath, 0x00b2c8, '$635F', '$03E0')
  }, project.manifestPath)
  expect(setColorResult.status).toBe('ok')

  // No call to w.load/w.reload here: the push is what must repaint this.
  await page.waitForTimeout(500)
  const after = await readCanvas(page)

  expect(after.checksum).not.toBe(before.checksum)
})

/** Read the open GFX view's canvas back: dimensions and real pixel variety. */
async function readCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.hb-gfx-view-canvas')
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const distinct = new Set()
    let opaque = 0
    let checksum = 0
    let same = 0
    for (let i = 0; i < data.length; i += 4) {
      if ((i / 4) % canvas.width !== canvas.width - 1) {
        let eq = true
        for (let c = 0; c < 4; c++) if (data[i + c] !== data[i + 4 + c]) eq = false
        if (eq) same++
      }
      distinct.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`)
      if (data[i + 3] > 0) opaque++
      checksum = (checksum + data[i] * 7 + data[i + 1] * 13 + data[i + 2] * 17 + data[i + 3]) >>> 0
    }
    return {
      width: canvas.width,
      height: canvas.height,
      distinctColors: distinct.size,
      opaquePixels: opaque,
      checksum,
      /** Share of horizontally adjacent pixel pairs that match. */
      coherence: same / ((canvas.width - 1) * canvas.height),
    }
  })
}

test('a project whose cartridge is not on this machine asks for it', async ({ page }) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')

  await createProject(page, dir, 'Shared')

  // Point the manifest at a cartridge this machine has never seen: the state
  // a collaborator is in after cloning a project, and it must read as
  // "locate it", not as a failure.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const state = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(GfxService)')
    const res = await svc.listGfxFiles(mp)
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(mp)
    return {
      status: res.status,
      fileCount: w.fileCount,
      rows: (w.model.root.children || []).map(n => n.name),
    }
  }, manifestPath)

  expect(state.status).toBe('rom-not-located')
  expect(state.fileCount).toBe(0)
  expect(state.rows.join(' ')).toMatch(/locate/i)
  expect(state.rows.join(' ')).toContain('SOMEONE ELSES CART')
})

test('the graphics explorer and GFX view speak of ROMs, never cartridges', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'Words'))
  await revealGfx(page)
  await page.waitForSelector('[id="hackbench.gfx-explorer"] .theia-TreeNode', { timeout: 15000 })
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  const view = await shownWords(page, '.hb-gfx-view-body')
  expect(view).toMatch(/tiles/)
  expect(view).not.toMatch(CART)

  const project = await createProject(page, path.join(tmp, 'Untitled'), 'Untitled')
  makeUntitledAndUnlocated(project.manifestPath)
  await page.evaluate(
    async mp => (await getWidget('hackbench.gfx-explorer')).load(mp),
    project.manifestPath,
  )
  const explorer = () => shownWords(page, '[id="hackbench.gfx-explorer"]')
  await expect.poll(explorer).toContain('Locate the base ROM')
  expect(await explorer()).not.toMatch(CART)
})

/**
 * Ctrl + wheel over the GFX sheet (#651), mirroring map16-view.spec.cjs's
 * own coverage. The GFX zoom stepper reads the SAME shared `ZoomController`
 * every open sheet does (gfx-view-widget.tsx's `sharedZoomController`), so
 * the interesting case here is the SECOND part: does a wheel-driven step on
 * one sheet also move a sheet that never received the event.
 */
async function ctrlWheel(page, locator, deltaY) {
  const box = await locator.boundingBox()
  await ctrlWheelAt(page, box.x + box.width / 2, box.y + box.height / 2, deltaY)
}

/** Settles a wheel: the widget's update frame, then the anchor's follow-up frame. */
async function afterWheel(page) {
  await page.evaluate(
    () =>
      new Promise(r =>
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))),
      ),
  )
}

/** The canvas's on-screen zoom, from its laid-out width, so a wait can see the repaint land. */
function canvasZoom(page, sel) {
  return page.evaluate(s => {
    const c = document.querySelector(s)
    return c.getBoundingClientRect().width / c.width
  }, sel)
}

/** Same as `ctrlWheel`, but at a client point the caller already knows,
 * rather than re-measuring `locator`'s CURRENT box - needed for anchoring
 * checks, where the point has to match exactly what the content-coordinate
 * comparison uses. */
async function ctrlWheelAt(page, clientX, clientY, deltaY) {
  await page.mouse.move(clientX, clientY)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, deltaY)
  await page.keyboard.up('Control')
  await afterWheel(page)
}

test('Ctrl + wheel over the GFX sheet steps its zoom indicator and canvas size', async ({
  page,
}) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)

  const canvas = page.locator('.hb-gfx-view-canvas')
  const wrap = page.locator('.hb-gfx-view-canvas-wrap')
  const widthBefore = await canvas.evaluate(el => el.getBoundingClientRect().width)
  const indicator = page.locator('[data-control="zoom-indicator"]')
  const before = await indicator.textContent()

  await ctrlWheel(page, wrap, -120)

  await expect(indicator).not.toHaveText(before)
  await expect
    .poll(() => canvas.evaluate(el => el.getBoundingClientRect().width))
    .toBeGreaterThan(widthBefore)
})

test('Ctrl + wheel on the GFX sheet clamps at 1x and 8x', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)

  const wrap = page.locator('.hb-gfx-view-canvas-wrap')
  const indicator = page.locator('[data-control="zoom-indicator"]')

  await ctrlWheel(page, wrap, -2000)
  await expect(indicator).toHaveText('800%')
  await expect(page.locator('[data-control="zoom-in"]')).toBeDisabled()

  await ctrlWheel(page, wrap, 2000)
  await expect(indicator).toHaveText('100%')
  await expect(page.locator('[data-control="zoom-out"]')).toBeDisabled()
})

test('a second open GFX sheet follows a zoom change made on the first', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  await gfxFileRow(page, 0).dblclick() // pin file 0
  await gfxFileRow(page, 1).dblclick() // pin file 1 as a second, independent widget
  await page.waitForSelector(`${gfxViewRoot(1)} .hb-gfx-view-canvas`, { timeout: 15000 })
  await page.waitForTimeout(300)

  const indicatorFor = index =>
    page.locator(`${gfxViewRoot(index)} [data-control="zoom-indicator"]`)
  const before0 = await indicatorFor(0).textContent()
  const before1 = await indicatorFor(1).textContent()
  expect(before1).toBe(before0) // shared controller: both open at the same zoom

  const wrap1 = page.locator(`${gfxViewRoot(1)} .hb-gfx-view-canvas-wrap`)
  await ctrlWheel(page, wrap1, -120) // wheel over sheet 1 only

  await expect(indicatorFor(1)).not.toHaveText(before1)
  // Sheet 0 never received a wheel event, but the shared controller moved it too.
  await expect(indicatorFor(0)).toHaveText(await indicatorFor(1).textContent())
})

/** The client-space point's CONTENT coordinate on the GFX canvas. */
async function gfxContentPointAt(page, canvasSel, clientX, clientY) {
  return page.evaluate(
    ({ canvasSel, clientX, clientY }) => {
      const canvas = document.querySelector(canvasSel)
      const rect = canvas.getBoundingClientRect()
      const zoom = rect.width / canvas.width
      return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom }
    },
    { canvasSel, clientX, clientY },
  )
}

test('Ctrl + wheel keeps the same canvas pixel under the cursor, in and out, within 1px', async ({
  page,
}) => {
  // A viewport this small guarantees the canvas overflows `.hb-gfx-view` at
  // EVERY zoom level this test uses - anchoring can only be proven where
  // there is scrollable range for it to actually act on. At the default
  // viewport the 128x64 sheet stayed entirely inside the view through 4x
  // and 6x, so scrollLeft/scrollTop stayed clamped to 0 the whole time and
  // the "anchor" was a no-op: the point drifted exactly as fast as an
  // un-anchored zoom from a fixed top-left corner would.
  await page.setViewportSize({ width: 500, height: 450 })
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)

  const canvasSel = '.hb-gfx-view-canvas'
  const view = page.locator('.hb-gfx-view')
  // A SMALL, off-center scroll, not the middle of the overflow range:
  // scrolled to dead center, this spec could not tell restoreAnchor() apart
  // from having none at all (proven by disabling it and seeing this spec
  // stay green) - a symmetric resize from a symmetric scroll position keeps
  // the visible center roughly stable on its own. A small, asymmetric
  // offset does not get that free ride.
  await view.evaluate(el => {
    el.scrollLeft = 15
    el.scrollTop = 15
  })
  const overflow = await view.evaluate(el => ({
    x: el.scrollWidth - el.clientWidth,
    y: el.scrollHeight - el.clientHeight,
  }))
  expect(overflow.x).toBeGreaterThan(10) // the setup itself must produce overflow
  expect(overflow.y).toBeGreaterThan(10)

  // A point near the VIEW's own bottom-left corner, never the canvas's own
  // boundingBox(): that is the canvas's full, UNCLIPPED layout box, which -
  // once it is much bigger than the viewport - can put "30px into the
  // canvas" outside the visible viewport entirely, where mouse events
  // cannot land (measured: a 512x256 canvas in a 100x131 visible pane put
  // that point ~130px below the bottom of the actual window). `.hb-gfx-
  // view`'s own box IS the visible, clipped viewport, and the canvas fills
  // it entirely below the toolbar, so a point near its bottom-left lands on
  // the canvas.
  const viewBox = await view.boundingBox()
  const clientX = viewBox.x + 20
  const clientY = viewBox.y + viewBox.height - 20

  const before = await gfxContentPointAt(page, canvasSel, clientX, clientY)
  // ctrlWheelAt, not ctrlWheel(page, locator, ...): re-deriving the point
  // from a fresh boundingBox() after a re-render could wheel somewhere
  // other than clientX/clientY, which is what `before`/`afterIn` compare.
  const zoomBefore = await canvasZoom(page, canvasSel)
  await ctrlWheelAt(page, clientX, clientY, -120) // one step in
  await expect.poll(() => canvasZoom(page, canvasSel)).toBeGreaterThan(zoomBefore)
  await afterWheel(page)
  const afterIn = await gfxContentPointAt(page, canvasSel, clientX, clientY)
  expect(Math.abs(afterIn.x - before.x)).toBeLessThan(1)
  expect(Math.abs(afterIn.y - before.y)).toBeLessThan(1)

  await ctrlWheelAt(page, clientX, clientY, 120) // one step back out
  await expect.poll(() => canvasZoom(page, canvasSel)).toBe(zoomBefore)
  await afterWheel(page)
  const afterOut = await gfxContentPointAt(page, canvasSel, clientX, clientY)
  expect(Math.abs(afterOut.x - before.x)).toBeLessThan(1)
  expect(Math.abs(afterOut.y - before.y)).toBeLessThan(1)
})

test('Ctrl + wheel over the GFX sheet is cancelled; a plain wheel is not', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })

  const dispatchWheel = (selector, ctrlKey) =>
    page.evaluate(
      ({ selector, ctrlKey }) => {
        const el = document.querySelector(selector)
        const e = new WheelEvent('wheel', {
          ctrlKey,
          cancelable: true,
          bubbles: true,
          deltaY: -100,
        })
        el.dispatchEvent(e)
        return e.defaultPrevented
      },
      { selector, ctrlKey },
    )

  expect(await dispatchWheel('.hb-gfx-view-canvas', true)).toBe(true)
  expect(await dispatchWheel('.hb-gfx-view-canvas', false)).toBe(false)
})

test('plain wheel still scrolls the GFX view and does not touch zoom', async ({ page }) => {
  // A small viewport plus the ceiling zoom guarantees real vertical
  // overflow - at the default (larger) viewport, 8x (1024x512) barely
  // overflowed horizontally and not at all vertically, so scrollTop never
  // moved for a reason that had nothing to do with the wheel handling.
  await page.setViewportSize({ width: 260, height: 220 })
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)

  const view = page.locator('.hb-gfx-view')
  // A point inside the VIEW's own (viewport-sized) box, never the canvas's -
  // once zoomed, the canvas is far bigger than the viewport and can scroll
  // to where its own boundingBox() center sits outside the visible area,
  // which would move the mouse somewhere Playwright can't actually hit.
  const viewBox = await view.boundingBox()
  const pointX = viewBox.x + viewBox.width / 2
  const pointY = viewBox.y + viewBox.height / 2

  // Zoom to the ceiling first so the canvas is tall enough to overflow the
  // view and actually need scrolling.
  await page.mouse.move(pointX, pointY)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -2000)
  await page.keyboard.up('Control')
  await afterWheel(page)
  await expect(page.locator('[data-control="zoom-indicator"]')).toHaveText('800%')

  const overflowY = await view.evaluate(el => el.scrollHeight - el.clientHeight)
  expect(overflowY).toBeGreaterThan(10) // the setup itself must produce overflow
  const scrollBefore = await view.evaluate(el => el.scrollTop)
  await page.mouse.move(pointX, pointY)
  await page.mouse.wheel(0, 400) // no Control held
  await page.waitForTimeout(200)

  const scrollAfter = await view.evaluate(el => el.scrollTop)
  expect(scrollAfter).toBeGreaterThan(scrollBefore)
  expect(await page.locator('[data-control="zoom-indicator"]').textContent()).toBe('800%')
})

/** Same boundary list as the hook, recomputed here from first principles. */
function expectedStarts(cell, count, dpr, extentDev) {
  return Array.from({ length: count }, (_, i) =>
    Math.min(Math.round(i * cell * dpr), extentDev - 1),
  )
}

/** A grid line is checked against pixels, not just the hook. */
function expectGridGeometry(g, cellContent, zoom, widthContent) {
  const cell = cellContent * zoom
  expect(g.cell).toBe(cell)
  // The first line sits on the content's origin: a one-cell shift fails here.
  expect(g.x[0]).toBe(0)
  expect(g.y[0]).toBe(0)
  expect(g.x.length).toBeGreaterThan(2)
  // Spacing is cell * zoom for EVERY neighbour, not just the first.
  expect(new Set(g.x.slice(1).map((v, i) => v - g.x[i]))).toEqual(new Set([cell]))
  // Ends exactly at the content edge.
  expect(g.x[g.x.length - 1]).toBe(widthContent * zoom)
  // Constant 1 device px, really painted, including the last of each axis.
  expect(new Set([...g.xLines, ...g.yLines].map(l => l.size))).toEqual(new Set([1]))
  expect(g.vLine).toBeGreaterThan(0)
  expect(g.vLast).toBeGreaterThan(0)
  expect(g.hLine).toBeGreaterThan(0)
  expect(g.hLast).toBeGreaterThan(0)
  expect(g.mid).toBe(0)
  // Every horizontal line runs the full width of the sheet.
  expect(g.yLines.every(l => l.to - l.from === g.canvasW)).toBe(true)
  // The pixels along the first cell's middle row ARE the vertical lines, no more, no fewer.
  expect(g.rowHits).toEqual(expectedStarts(cell, g.x.length, g.dpr, g.canvasW))
}

test('the grid toggle shows an 8px-cell overlay that tracks zoom, and hides again', async ({
  page,
}) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)
  const root = '.hb-gfx-view'
  const sheetPixels = () =>
    page
      .locator('.hb-gfx-view-canvas')
      .evaluate(c =>
        Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data).join(','),
      )

  const toggle = page.locator(`${root} [data-control="grid-toggle"]`)
  expect(await readGrid(page, root)).toBeNull() // off by default
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('title', 'Show grid')

  const contentBefore = await sheetPixels()
  const sheetWidth = await page.locator('.hb-gfx-view-canvas').evaluate(c => c.width)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('title', 'Hide grid')
  const zooms = []
  for (let step = 0; step < 2; step++) {
    if (step > 0) await page.locator('[data-control="zoom-in"]').click()
    await page.waitForTimeout(200)
    const zoom =
      parseInt(await page.locator('[data-control="zoom-indicator"]').textContent(), 10) / 100
    zooms.push(zoom)
    expectGridGeometry(await readGrid(page, root), 8, zoom, sheetWidth)
  }
  expect(zooms[1]).toBeGreaterThan(zooms[0])

  // A pure overlay: the sheet's own pixels are untouched.
  expect(await sheetPixels()).toBe(contentBefore)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await readGrid(page, root)).toBeNull()
})

test('the GFX grid is one switch for every open GFX tab, like zoom', async ({ page }) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await gfxFileRow(page, 0).dblclick()
  await page.waitForSelector(`${gfxViewRoot(0)} .hb-gfx-view-canvas`, { timeout: 15000 })
  await revealGfx(page)
  await gfxFileRow(page, 1).dblclick()
  await page.waitForSelector(`${gfxViewRoot(1)} .hb-gfx-view-canvas`, { timeout: 15000 })

  await page.locator(`${gfxViewRoot(1)} [data-control="grid-toggle"]`).click()
  expect(await readGrid(page, gfxViewRoot(1))).not.toBeNull()
  // The other tab, brought to the front, shows it already on.
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, 'hackbench.gfx-view:0')
  await page.waitForTimeout(400)
  expect(await readGrid(page, gfxViewRoot(0))).not.toBeNull()
  await expect(page.locator(`${gfxViewRoot(0)} [data-control="grid-toggle"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await page.locator(`${gfxViewRoot(0)} [data-control="grid-toggle"]`).click()
  expect(await readGrid(page, gfxViewRoot(0))).toBeNull()
})

/**
 * HiDPI: the overlay is backed at device resolution, so a line is exactly ONE
 * device pixel at a fractional or doubled display scale, where a canvas
 * stretched by the browser would smear it across two.
 */
for (const dpr of [1.5, 2]) {
  test.describe(`at device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr })

    test('every grid line is exactly one device pixel wide, on the right pixel', async ({
      page,
    }) => {
      await loadGfx(page, path.join(tmp, 'MyHack'))
      await revealGfx(page)
      await firstGfxFileRow(page).click()
      await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
      await page.locator('.hb-gfx-view [data-control="grid-toggle"]').click()
      await page.waitForTimeout(300)
      expect(await page.evaluate(() => window.devicePixelRatio)).toBe(dpr)

      const g = await readGrid(page, '.hb-gfx-view')
      expect(g.dpr).toBe(dpr)
      expect(g.canvasW).toBe(Math.round(g.cssW * dpr))
      // Positions come from the cell, not from the hook's own claim.
      expect(g.rowHits).toEqual(expectedStarts(g.cell, g.x.length, dpr, g.canvasW))
      // No two hits are adjacent: each line is one device pixel, not two.
      expect(g.rowHits.every((v, i) => i === 0 || v - g.rowHits[i - 1] > 1)).toBe(true)
      expect(g.colHits.every((v, i) => i === 0 || v - g.colHits[i - 1] > 1)).toBe(true)
      expect(g.colHits).toEqual(expectedStarts(g.cell, g.y.length, dpr, g.canvasH))
    })
  })
}

/**
 * The grid must be visible in the COMPOSITED page, not just painted: a canvas
 * stacked below the sheet draws every pixel the hook claims and shows none of
 * them. Two real screenshots, grid off then on, compared numerically.
 */
test('the grid shows in a real screenshot: line pixels change, no other pixel does', async ({
  page,
}) => {
  await loadGfx(page, path.join(tmp, 'MyHack'))
  await revealGfx(page)
  await firstGfxFileRow(page).click()
  await page.waitForSelector('.hb-gfx-view-canvas', { timeout: 15000 })
  await page.waitForTimeout(300)
  await page.mouse.move(2, 2)
  const toggle = page.locator('.hb-gfx-view [data-control="grid-toggle"]')

  const off = await shootCanvas(page, '.hb-gfx-view-canvas')
  await toggle.click()
  await page.mouse.move(2, 2)
  await page.waitForTimeout(300)
  const grid = await readGrid(page, '.hb-gfx-view')
  const on = await shootCanvas(page, '.hb-gfx-view-canvas')
  const d = await compositedGridDiff(page, off, on, grid)

  expect([d.bW, d.bH]).toEqual([d.W, d.H])
  expect(d.lineTotal).toBeGreaterThan(100)
  expect(d.lineChanged / d.lineTotal).toBeGreaterThan(0.95)
  expect(d.otherChanged).toBe(0)
})
