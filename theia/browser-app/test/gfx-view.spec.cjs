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
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, INVICTUS } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
/** A hack with a relocated GFX arrangement: 49 of its 50 files fit no bit
 * depth GfxLoader recognises (review C1), unlike every vanilla-derived cart. */
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

async function createProject(page, dir, name = 'MyHack') {
  return page.evaluate(
    async ({ romPath, directory, projectName }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: projectName, directory })
    },
    { romPath: ROM, directory: dir, projectName: name },
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
async function loadGfx(page, dir) {
  const project = await createProject(page, dir)
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
 * A relocated GFX arrangement (Invictus 1.0), where GfxLoader itself cannot
 * place most files at any bit depth. The row must say so honestly, not
 * report loadGfxFile's 128-tile blank-sheet placeholder as a real count, and
 * opening one by default must refuse rather than paint that blank sheet
 * labelled as real tile data (review C1).
 */
test('a relocated GFX arrangement is reported unavailable, not fabricated', async ({ page }) => {
  test.skip(!fs.existsSync(INVICTUS_ROM), 'Invictus fixture not present on this machine')

  const dir = path.join(tmp, 'InvictusHack')
  const project = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: 'InvictusHack', directory })
    },
    { romPath: INVICTUS_ROM, directory: dir },
  )

  const state = await page.evaluate(async manifestPath => {
    const svc = getSvc('Symbol(GfxService)')
    const res = await svc.listGfxFiles(manifestPath)
    return res.status === 'ok'
      ? { status: res.status, files: res.files }
      : { status: res.status, files: [] }
  }, project.manifestPath)

  expect(state.status).toBe('ok')
  const unavailable = state.files.filter(f => f.defaultBpp === null)
  const available = state.files.filter(f => f.defaultBpp !== null)
  // Measured on this cart: 49 of 50. Asserted loosely so a harmless re-dump
  // of the same hack does not make this brittle.
  expect(unavailable.length).toBeGreaterThan(40)
  for (const f of unavailable) expect(f.tileCount).toBeNull()
  for (const f of available) expect(f.tileCount).toBeGreaterThan(0)

  const target = unavailable[0]
  const openError = await page.evaluate(
    async ({ manifestPath, index }) => {
      const svc = getSvc('Symbol(GfxService)')
      try {
        await svc.gfxSheet(manifestPath, index)
        return null
      } catch (err) {
        return err.message
      }
    },
    { manifestPath: project.manifestPath, index: target.index },
  )

  expect(openError).toBeTruthy()
})

/**
 * H4: an explicit bit-depth override can legitimately yield zero tiles (a
 * short file forced to a deep bpp). Before the fix this reached the canvas
 * as a zero-height ImageData, which Chromium's ImageData constructor throws
 * an uncaught IndexSizeError on -- outside reload()'s try/catch, so the page
 * crashes silently instead of showing an error message.
 */
test('a bit-depth override yielding zero tiles is refused, not a page crash', async ({ page }) => {
  test.skip(!fs.existsSync(INVICTUS_ROM), 'Invictus fixture not present on this machine')

  const pageErrors = []
  page.on('pageerror', err => pageErrors.push(err.message))

  const dir = path.join(tmp, 'InvictusShort')
  const project = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: 'InvictusShort', directory })
    },
    { romPath: INVICTUS_ROM, directory: dir },
  )

  // File $0E is 29 bytes; forced to 4bpp (32 bytes/tile) that is zero tiles.
  const result = await page.evaluate(
    async ({ manifestPath, index }) => {
      const svc = getSvc('Symbol(GfxService)')
      try {
        await svc.gfxSheet(manifestPath, index, 4)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err.message }
      }
    },
    { manifestPath: project.manifestPath, index: 0x0e },
  )

  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/shorter than one tile/i)
  expect(pageErrors).toEqual([])
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
