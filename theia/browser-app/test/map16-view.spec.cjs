/**
 * The Map16 view, end to end against the shell: the tree row, the composited
 * 512-block sheet, the inspector, and cross-view recoloring.
 *
 * Modelled on gfx-view.spec.cjs. The failure mode this guards against is the
 * same one that spec calls out: a canvas that renders but shows nothing
 * real, or a "recolor" claim that never actually reads the new pixels back.
 *
 * One Theia BACKEND process serves every test in this file (only the
 * frontend page/context is fresh per test, via Playwright's default `page`
 * fixture). Two things about that are worth naming rather than silently
 * working around:
 *
 * - Every backend `*ServiceImpl` (Map16, Gfx, Palette) is a DI singleton
 *   whose `WorkingCopyNotifier` holds exactly ONE client, overwritten by
 *   whichever connection registered most recently (working-copy-notifier.ts,
 *   gfx-server.ts, map16-server.ts, palette-server.ts). That is a real,
 *   pre-existing limitation - two genuine browser tabs on the same project
 *   would have the same problem, only the most recently opened tab would
 *   ever receive a push - not something introduced or fixed here. It does
 *   NOT explain this file's own flakiness, though: every widget's push
 *   handler filters by `manifestPath === this.options?.manifestPath` before
 *   acting, and each test's project has a distinct manifest path, so even a
 *   stale registration from an earlier test's page cannot make THIS test's
 *   view react to the wrong project's edit.
 * - `WorkingRomRegistry`'s cache is keyed by manifest path and never evicts,
 *   so it accumulates one entry per test for the life of the backend
 *   process. Paths differ per test (fresh `tmp` dir each time), so entries
 *   never collide - this is memory growth over a long run, not a
 *   correctness bug, and not addressed here.
 *
 * The actual flake found in this file: `.check()` re-verifies the checked
 * state after clicking and, per Playwright's documented retry behaviour,
 * RE-CLICKS if that verification does not pass within its own polling
 * window. map16-view-widget.tsx's checkbox/select controls are genuinely
 * asynchronous (their committed value is a round trip away, even with the
 * `pendingEdits` optimistic overlay covering the common case) - under this
 * suite's slower full-file-run timing, `.check()`'s retry can land on an
 * already-checked box and toggle it back off before the assertion after it
 * ever gets to look. Every checkbox interaction below uses a plain
 * `.click()` (exactly one click, no re-click) followed by an
 * `expect(...).toBeChecked()` (which retries by re-reading, never
 * re-clicking) to wait out the round trip instead.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords } = require('./rom-words.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

/** MAP16_TOTAL_TILES in src/rom/Map16.ts: 64 bitmap bytes * 8 bits. */
const MAP16_TILE_COUNT = 512
const TILES_PER_ROW = 16
const DEFAULT_ZOOM = 2
const BLOCK_PX = 16

/**
 * Tile $130, tileset 0: TL subtile is charNum $30, palette 4 (CGRAM row 4,
 * "sprite_sets" group's "Shared" variant, i.e. StandardColors row 0 -
 * PaletteStockTables.ts). Confirmed by decoding the real ROM
 * (loadAllMap16(rom, 0)[0x130].tl and getCharPixels against loadVram(rom, 0))
 * that this subtile's pixels actually use palette INDEX 4, i.e. CGRAM row 4
 * column 4 - StandardColors' address $00B254, vanilla word $6318 - so
 * editing that exact address is guaranteed to move a pixel this tile draws,
 * not a column this depth/tile can never reach (the mistake noted in
 * gfx-view.spec.cjs's own edit-target comment).
 */
const TARGET_TILE_ID = 0x130
const TARGET_ADDR = 0x00b254
const TARGET_OLD_HEX = '$6318'
const TARGET_NEW_HEX = '$03E0'

/**
 * Character-animation fixtures for FG tileset 0, confirmed by decoding the
 * real ROM (decodeMap16Sheet's own charAnimation.animatedBlockIds): block
 * $000 animates (a common animated tile - ? block/coin/similar), block
 * $001 does not, and TARGET_TILE_ID ($130, used for the palette-edit tests
 * above) also does not. Picked from real data, not assumed, per the same
 * "measure, don't guess" rule as TARGET_TILE_ID's own comment.
 */
const ANIMATED_BLOCK_ID = 0x000
const STATIC_BLOCK_ID = 0x001

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

async function revealGfx(page) {
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.gfx-explorer')
  })
  await page.waitForTimeout(800)
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-map16-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

/**
 * Every test in this file opens the Map16 view through a single click,
 * which always resolves through PreviewTabs.preview - one widget, id
 * `${MAP16_VIEW_ID}:preview` (preview-tabs.ts's `previewId`). Playwright
 * gives each test a fresh page/context already (the default `page` fixture,
 * same as gfx-view.spec.cjs and palette-view.spec.cjs), so this is not
 * needed for frontend isolation; it is closed anyway to keep the ONE shared
 * Theia backend process this file's tests all run against (see this file's
 * own note on WorkingRomRegistry/WorkingCopyNotifier below) from
 * accumulating an open RPC subscription and a live widget per test for the
 * whole spec-file run.
 */
async function closeMap16View(page) {
  await page.evaluate(async () => {
    try {
      await getSvc('ApplicationShell').closeWidget('hackbench.map16-view:preview')
    } catch {
      /* nothing open to close - fine */
    }
  })
}

test.afterEach(async ({ page }) => {
  await closeMap16View(page)
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

/** Opens the Map16 row from the (already-loaded) Graphics explorer. */
async function openMap16(page) {
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').first().click()
  await page.waitForSelector('.hb-map16-canvas', { timeout: 15000 })
  await page.waitForTimeout(500)
}

async function loadGfxExplorer(page, dir) {
  const project = await createProject(page, dir)
  await revealGfx(page)
  await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(manifestPath)
  }, project.manifestPath)
  return project
}

/** Reads the Map16 canvas back: native-resolution pixel data (zoom is CSS only). */
async function readCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('.hb-map16-canvas')
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const distinct = new Set()
    let checksum = 0
    for (let i = 0; i < data.length; i += 4) {
      distinct.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`)
      checksum = (checksum + data[i] * 7 + data[i + 1] * 13 + data[i + 2] * 17 + data[i + 3]) >>> 0
    }
    return { width: canvas.width, height: canvas.height, distinctColors: distinct.size, checksum }
  })
}

/** Whether the 16x16 region for `tileId` contains a pixel matching `rgb` (opaque). */
async function blockHasColor(page, tileId, rgb) {
  return page.evaluate(
    ({ tileId, rgb, tilesPerRow, blockPx }) => {
      const canvas = document.querySelector('.hb-map16-canvas')
      const ctx = canvas.getContext('2d')
      const col = tileId % tilesPerRow
      const row = Math.floor(tileId / tilesPerRow)
      const data = ctx.getImageData(col * blockPx, row * blockPx, blockPx, blockPx).data
      for (let i = 0; i < data.length; i += 4) {
        if (
          data[i] === rgb[0] &&
          data[i + 1] === rgb[1] &&
          data[i + 2] === rgb[2] &&
          data[i + 3] > 0
        ) {
          return true
        }
      }
      return false
    },
    { tileId, rgb, tilesPerRow: TILES_PER_ROW, blockPx: BLOCK_PX },
  )
}

/** Same expansion palette-color-format.ts's bgr555HexToCssHex uses. */
function bgr555ToRgbTriplet(word) {
  const r5 = word & 0x1f
  const g5 = (word >> 5) & 0x1f
  const b5 = (word >> 10) & 0x1f
  const expand = c5 => (c5 << 3) | (c5 >> 2)
  return [expand(r5), expand(g5), expand(b5)]
}

/** Clicks the block at `tileId` on the canvas, at the view's default zoom. */
async function clickBlock(page, tileId) {
  const cellPx = BLOCK_PX * DEFAULT_ZOOM
  const col = tileId % TILES_PER_ROW
  const row = Math.floor(tileId / TILES_PER_ROW)
  await page
    .locator('.hb-map16-canvas')
    .click({ position: { x: col * cellPx + cellPx / 2, y: row * cellPx + cellPx / 2 } })
  await page.waitForTimeout(300)
}

/** Clicks a corner button ("Top-left", "Top-right", ...) by its exact label. */
async function selectCorner(page, label) {
  await page.getByRole('button', { name: label, exact: true }).click()
  await page.waitForTimeout(150)
}

/**
 * Reads the currently-selected subtile's fields straight from the DOM, in
 * the fixed order map16-view-widget.tsx's renderSubtileFields renders them:
 * the one number input (char number), the one select (palette row), then
 * three checkboxes (priority, flipX, flipY).
 */
async function readSubtileFields(page) {
  return page.evaluate(() => {
    const charInput = document.querySelector('.hb-map16-fields input[type="number"]')
    const paletteSelect = document.querySelector('.hb-map16-fields select')
    const checkboxes = [...document.querySelectorAll('.hb-map16-fields input[type="checkbox"]')]
    return {
      charNum: Number(charInput.value),
      palette: Number(paletteSelect.value),
      priority: checkboxes[0].checked,
      flipX: checkboxes[1].checked,
      flipY: checkboxes[2].checked,
    }
  })
}

test('the Map16 row sits above the GFX files and opens a real 512-block sheet', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  const rows = await page.evaluate(async () => {
    const w = await getWidget('hackbench.gfx-explorer')
    return (w.model.root.children || []).map(n => ({ kind: n.kind, name: n.name }))
  })
  expect(rows[0].kind).toBe('map16')
  expect(rows[0].name).toBe('Map16')
  expect(rows.slice(1).every(r => r.kind === 'file')).toBe(true)

  await openMap16(page)
  const info = await readCanvas(page)
  expect(info.width).toBeGreaterThan(0)
  expect(info.height).toBeGreaterThan(0)
  // 512 blocks, 16 per row, 16x16px each.
  expect(info.width).toBe(TILES_PER_ROW * BLOCK_PX)
  expect(info.height).toBe((MAP16_TILE_COUNT / TILES_PER_ROW) * BLOCK_PX)
  // Real tile art, not a blank or single-color sheet.
  expect(info.distinctColors).toBeGreaterThan(1)

  const summary = await page.locator('.hb-map16-summary-dims').textContent()
  expect(summary).toContain(`${MAP16_TILE_COUNT} blocks`)
})

test('clicking a block shows its four subtiles and the real ROM addresses of each', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  await clickBlock(page, TARGET_TILE_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  const headerText = await page.locator('.hb-map16-inspector-header').innerText()
  expect(headerText).toMatch(/\$130/i)
  expect(headerText).toMatch(/\$[0-9A-F]{6}/) // the block's own ROM address

  const addrLine = await page.locator('.hb-map16-addr-line').textContent()
  expect(addrLine).toMatch(/\$[0-9A-F]{6}/) // the selected subtile's own word address

  // Default corner on a fresh selection is top-left.
  const selectedCorner = await page.locator('.hb-map16-corner-selected').textContent()
  expect(selectedCorner).toBe('Top-left')
})

test('editing a subtile field writes a real op and repaints the block', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  await loadGfxExplorer(page, dir)
  await openMap16(page)
  await clickBlock(page, TARGET_TILE_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  const before = await readCanvas(page)

  // A plain click, not `.check()`: the checkbox is CONTROLLED by a value
  // that only becomes final once map16-server.ts's response lands
  // (map16-view-widget.tsx's `pendingEdits` shows the click's effect right
  // away, but the definitive value is still one round trip away). `.check()`
  // re-verifies the checked state and, per Playwright's own documented
  // retry semantics, RE-CLICKS if that verification does not pass inside
  // its own polling window - which, under this suite's slower full-file-run
  // timing, can land its retry click on an already-optimistically-checked
  // box and toggle it back off. `.click()` performs exactly one click; the
  // `expect(...).toBeChecked()` below is what waits for (and retries
  // reading, never re-clicking) the eventually-consistent server state.
  const flipX = page.getByLabel('Flip X')
  await expect(flipX).not.toBeChecked()
  await flipX.click()
  await expect(flipX).toBeChecked({ timeout: 10000 })

  // Poll the CANVAS, not the checkbox. The checkbox now flips optimistically,
  // before the round trip, so it goes checked while the repaint is still in
  // flight; waiting on it and reading the canvas immediately is a race.
  await expect
    .poll(async () => (await readCanvas(page)).checksum, { timeout: 10000 })
    .not.toBe(before.checksum)

  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles.length).toBeGreaterThan(0)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[opFiles.length - 1]), 'utf8'))
  // A Map16 op carries `mask` (bit 15 is real data here) - the one thing
  // that distinguishes it from a palette op at the JSON level.
  expect(layer.ops[0].mask).toBe(0xffff)
})

/**
 * The feature's headline cross-view claim: a PALETTE edit made through
 * PaletteService visibly recolors an ALREADY-OPEN Map16 view, with no
 * manual reload - the same push path gfx-view.spec.cjs proves for GFX
 * sheets, now proved for Map16 too (map16-server.ts subscribes to the same
 * WorkingRom, per working-copy-notifier.ts).
 *
 * The edited address/color ($00B254, StandardColors row 0 col 4) was
 * chosen because tile $130's TL subtile (charNum $30, palette 4) was
 * decoded from the real ROM and confirmed to actually use palette index 4 -
 * see this file's TARGET_* constants and their comment. A col this tile's
 * pixels can never reach would pass "the canvas didn't change" for the
 * wrong reason, the exact mistake gfx-view.spec.cjs's own comment warns
 * about for a 3bpp sheet's unreachable columns.
 */
test('a palette edit visibly recolors an already-open Map16 view, with no manual reload', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  const newRgb = bgr555ToRgbTriplet(parseInt(TARGET_NEW_HEX.slice(1), 16))
  const oldRgb = bgr555ToRgbTriplet(parseInt(TARGET_OLD_HEX.slice(1), 16))

  expect(await blockHasColor(page, TARGET_TILE_ID, oldRgb)).toBe(true)
  expect(await blockHasColor(page, TARGET_TILE_ID, newRgb)).toBe(false)
  const before = await readCanvas(page)

  // Edit through PaletteService directly - the Palette VIEW is not open at
  // all, so this is unambiguously the push path, not a coincidental shared
  // reference the widget already held.
  const setColorResult = await page.evaluate(
    async ({ manifestPath, addr, oldHex, newHex }) => {
      const svc = getSvc('Symbol(PaletteService)')
      return svc.setColor(manifestPath, addr, oldHex, newHex)
    },
    {
      manifestPath: project.manifestPath,
      addr: TARGET_ADDR,
      oldHex: TARGET_OLD_HEX,
      newHex: TARGET_NEW_HEX,
    },
  )
  expect(setColorResult.status).toBe('ok')

  // No call to w.load/w.reload here: the push is what must repaint this.
  await page.waitForTimeout(500)

  const after = await readCanvas(page)
  expect(after.checksum).not.toBe(before.checksum)
  expect(await blockHasColor(page, TARGET_TILE_ID, newRgb)).toBe(true)
  expect(await blockHasColor(page, TARGET_TILE_ID, oldRgb)).toBe(false)
})

/**
 * The reverse direction and the brief's own extra requirement: a Map16 edit
 * made through THIS view must repaint correctly too, without looping or
 * fighting the selection - since map16-server.ts's own write fires the same
 * working-copy-changed event this view listens to for other views' edits.
 *
 * Uses a plain `.click()`, not `.check()` - see the matching comment in
 * "editing a subtile field writes a real op and repaints the block" above
 * for why `.check()`'s built-in re-click-on-failed-verification can race a
 * genuinely async, server-controlled checkbox under load.
 */
test("editing this view's own field does not clear or fight the current selection", async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)
  await clickBlock(page, TARGET_TILE_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  const priority = page.getByLabel('Priority (draws over sprites)')
  await expect(priority).not.toBeChecked()
  await priority.click()

  // Still the same block/corner selected - refresh(), not load(), on a change.
  const header = await page.locator('.hb-map16-inspector-header').innerText()
  expect(header).toMatch(/\$130/i)
  await expect(priority).toBeChecked({ timeout: 10000 })
})

test('switching tileset re-decodes the sheet, not just its label', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  const before = await readCanvas(page)
  await page.selectOption('#hb-map16-tileset-select', '1')
  await page.waitForTimeout(500)
  const after = await readCanvas(page)

  expect(after.checksum).not.toBe(before.checksum)
})

/**
 * The first gap the owner's Mesen/map-editor diff found: FG and BG are two
 * separate 512-block tables. Values decoded independently from vanilla
 * bytes at offset 0x69100 (SNES $0D9100, no copier header on this cart),
 * column-major words (w0 tl, w1 bl, w2 tr, w3 br) - see this file's header
 * comment and Map16.romAddress.test.ts's BG section for the address proof.
 * tl differing from the FG table's own $100 (char=$182 pal=2, this file's
 * TARGET_TILE_ID) also proves the Table selector actually switched tables,
 * not just relabelled the same data.
 */
test('the BG table selector shows the global Layer 2 table with its own real values', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)

  await clickBlock(page, 0x100)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  let fields = await readSubtileFields(page) // default corner: top-left
  expect(fields.charNum).toBe(0x0fd)
  expect(fields.palette).toBe(1)

  await selectCorner(page, 'Top-right')
  fields = await readSubtileFields(page)
  expect(fields.charNum).toBe(0x106)
  expect(fields.palette).toBe(1)

  await selectCorner(page, 'Bottom-left')
  fields = await readSubtileFields(page)
  expect(fields.charNum).toBe(0x0fd)
  expect(fields.palette).toBe(1)

  await selectCorner(page, 'Bottom-right')
  fields = await readSubtileFields(page)
  expect(fields.charNum).toBe(0x107)
  expect(fields.palette).toBe(1)
})

/**
 * Flip flags specifically, which a presence-only check (e.g. "the char
 * number is right") would not catch: tl and tr share the same character
 * ($100) but are horizontal mirrors of each other.
 */
test('BG block $101 renders tl/tr as horizontal mirrors of the same character', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)
  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)

  await clickBlock(page, 0x101)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  const tl = await readSubtileFields(page)
  expect(tl.charNum).toBe(0x100)
  expect(tl.flipX).toBe(false)

  await selectCorner(page, 'Top-right')
  const tr = await readSubtileFields(page)
  expect(tr.charNum).toBe(0x100)
  expect(tr.flipX).toBe(true)
})

/**
 * Reversed guidance from the owner: the BG block TABLE does not vary with
 * tileset, but the RENDERED PIXELS still do (readGfxAssignment differs
 * across tilesets in the fg3/an1 slots the BG table heavily uses - measured
 * at 64.0% of its subtiles). Tileset 0 -> 3 is the largest single swing
 * (fg3 file $25 -> $12). Goes red if anyone re-disables the tileset control
 * on BG, or drops tileset from the BG VRAM path.
 */
test('switching tileset while BG is selected still changes the rendered pixels', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)
  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)

  await expect(page.locator('#hb-map16-tileset-select')).toBeEnabled()
  const before = await readCanvas(page)
  await page.selectOption('#hb-map16-tileset-select', '3')
  await page.waitForTimeout(500)
  const after = await readCanvas(page)

  expect(after.checksum).not.toBe(before.checksum)
})

/**
 * Second gap from the owner's review: which palette control can affect a
 * sheet's pixels must be derived from the LOADED TABLE (citedPaletteRows),
 * never assumed from which layer is selected. Vanilla measurement (owner's
 * histogram, identical on all 6 corpus carts): the BG table cites CGRAM
 * rows {0,1,4,7} only - zero subtiles on rows 2-3, which the FG palette
 * control feeds - so on BG that control genuinely cannot change a pixel.
 * The FG common table cites both row pairs, so on FG both controls stay
 * enabled.
 */
test('the FG palette control disables itself on BG (no subtile there cites rows 2-3); both stay enabled on FG', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  await expect(page.locator('#hb-map16-bg-variant-select')).toBeEnabled()
  await expect(page.locator('#hb-map16-fg-variant-select')).toBeEnabled()

  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)

  await expect(page.locator('#hb-map16-bg-variant-select')).toBeEnabled()
  await expect(page.locator('#hb-map16-fg-variant-select')).toBeDisabled()

  const fgLabel = page.locator('label.hb-map16-control:has(#hb-map16-fg-variant-select)')
  await expect(fgLabel).toHaveAttribute('title', /no subtile.*foreground/i)
})

/**
 * The tileset control stays ENABLED on both layers (the owner's reversed
 * guidance - it still changes real pixels on BG), so only its label may
 * differ; a human needs to see why the same control means something
 * different once BG is selected.
 */
test('the tileset control label explains it is graphics-only when BG is selected', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  const fgLabel = await page
    .locator('label.hb-map16-control:has(#hb-map16-tileset-select)')
    .innerText()
  expect(fgLabel).toMatch(/^Tileset/)
  expect(fgLabel.toLowerCase()).not.toContain('graphics only')

  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)

  const bgLabel = await page
    .locator('label.hb-map16-control:has(#hb-map16-tileset-select)')
    .innerText()
  expect(bgLabel.toLowerCase()).toContain('graphics only')
  await expect(page.locator('#hb-map16-tileset-select')).toBeEnabled()
})

/**
 * There are now SEVEN independent pieces of view state (table, tileset, BG
 * palette variant, FG palette variant, zoom, grid, playing) plus the
 * selection. This is the class of bug that has cost the most time on this
 * view: changing any one of them must preserve the selected block and must
 * not reset any of the others. Walks all seven, checking both properties
 * after each change - extended in place rather than duplicated, per the
 * owner's own instruction, when grid/playing were added.
 */
test('changing table/tileset/BG palette/FG palette/zoom/grid/playing each preserves the selection and never resets the others', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)
  await clickBlock(page, TARGET_TILE_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })

  const stillSelected = async () => {
    const header = await page.locator('.hb-map16-inspector-header').innerText()
    expect(header).toMatch(/\$130/i)
  }
  const controlValues = async () => ({
    layer: await page.locator('#hb-map16-layer-select').inputValue(),
    tileset: await page.locator('#hb-map16-tileset-select').inputValue(),
    bg: await page.locator('#hb-map16-bg-variant-select').inputValue(),
    fg: await page.locator('#hb-map16-fg-variant-select').inputValue(),
    zoom: await page.locator('#hb-map16-zoom-indicator').textContent(),
    grid: (await page.locator('#hb-map16-grid-toggle').getAttribute('aria-pressed')) === 'true',
    playing: (await page.locator('#hb-map16-play-toggle').getAttribute('aria-pressed')) === 'true',
  })

  // Zoom: purely a view preference, touches no server state at all.
  let before = await controlValues()
  // Step to maximum rather than clicking a fixed number of times: zoom
  // starts at DEFAULT_ZOOM (2), and the button DISABLES at the top of
  // ZOOM_OPTIONS, so a fixed count overshoots onto a disabled control and
  // hangs. Driving it to the clamp asserts the clamp as well.
  const zoomIn = page.locator('#hb-map16-zoom-in')
  while (await zoomIn.isEnabled()) await zoomIn.click()
  await page.waitForTimeout(200)
  await stillSelected()
  let after = await controlValues()
  expect(after.zoom).toBe('4x')
  expect({ ...after, zoom: before.zoom }).toEqual(before)

  // BG palette variant.
  before = await controlValues()
  await page.selectOption('#hb-map16-bg-variant-select', '7')
  await page.waitForTimeout(300)
  await stillSelected()
  after = await controlValues()
  expect(after.bg).toBe('7')
  expect({ ...after, bg: before.bg }).toEqual(before)

  // FG palette variant.
  before = await controlValues()
  await page.selectOption('#hb-map16-fg-variant-select', '3')
  await page.waitForTimeout(300)
  await stillSelected()
  after = await controlValues()
  expect(after.fg).toBe('3')
  expect({ ...after, fg: before.fg }).toEqual(before)

  // Tileset.
  before = await controlValues()
  await page.selectOption('#hb-map16-tileset-select', '5')
  await page.waitForTimeout(300)
  await stillSelected()
  after = await controlValues()
  expect(after.tileset).toBe('5')
  expect({ ...after, tileset: before.tileset }).toEqual(before)

  // Grid: local overlay only, no reload.
  before = await controlValues()
  await page.locator('#hb-map16-grid-toggle').click()
  await page.waitForTimeout(150)
  await stillSelected()
  after = await controlValues()
  expect(after.grid).toBe(true)
  expect({ ...after, grid: before.grid }).toEqual(before)

  // Playing: client-side timer only, no reload.
  before = await controlValues()
  await page.locator('#hb-map16-play-toggle').click()
  await page.waitForTimeout(150)
  await stillSelected()
  after = await controlValues()
  expect(after.playing).toBe(true)
  expect({ ...after, playing: before.playing }).toEqual(before)
  await page.locator('#hb-map16-play-toggle').click() // stop, so the next axis starts from a clean state
  await page.waitForTimeout(150)

  // Table (fg -> bg): the selected id/corner must survive even though the
  // content AT that id is now a completely different block.
  before = await controlValues()
  await page.selectOption('#hb-map16-layer-select', 'bg')
  await page.waitForTimeout(300)
  await stillSelected()
  after = await controlValues()
  expect(after.layer).toBe('bg')
  expect({ ...after, layer: before.layer }).toEqual(before)
})

/**
 * Grid is a pure overlay (map16-view-widget.tsx's own doc comment on
 * paintCanvas): toggling it must repaint the SAME decoded pixels with lines
 * drawn on top, then repaint the identical pixels again with them removed -
 * never a re-decode, and never a residual line left behind.
 */
test('toggling grid draws an overlay and removes it cleanly, without changing the underlying sheet', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  const before = await readCanvas(page)
  await page.locator('#hb-map16-grid-toggle').click()
  await page.waitForTimeout(150)
  const withGrid = await readCanvas(page)
  expect(withGrid.checksum).not.toBe(before.checksum) // lines were actually drawn

  await page.locator('#hb-map16-grid-toggle').click()
  await page.waitForTimeout(150)
  const gridOff = await readCanvas(page)
  expect(gridOff.checksum).toBe(before.checksum) // exact same pixels once removed
})

/**
 * Play/stop, the headline claim of this feature: pressing play must
 * actually advance through DIFFERENT composited frames over time (not just
 * flip an icon), using the cart's own native interval - and stopping must
 * leave a stable, re-readable frame rather than a canvas frozen mid-tick.
 */
test('play cycles the canvas through real animation frames at the native interval; stop leaves it stable', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  const playButton = page.locator('#hb-map16-play-toggle')
  await expect(playButton).toBeEnabled() // vanilla always has char animation - see Map16Decode.test.ts
  await expect(playButton).toHaveAttribute('title', 'Play animation')

  const frame0 = await readCanvas(page)
  await playButton.click()
  await expect(playButton).toHaveAttribute('title', 'Stop animation')
  await expect(playButton).toHaveClass(/hb-map16-icon-btn-on/)

  // Native interval is ~133ms on vanilla (AnimationLoader.loadAnimationData);
  // poll rather than sleep a fixed guess, since exactly how many ticks land
  // in a given wait is timing-sensitive under load.
  await expect
    .poll(async () => (await readCanvas(page)).checksum, { timeout: 5000 })
    .not.toBe(frame0.checksum)

  await playButton.click()
  await expect(playButton).toHaveAttribute('title', 'Play animation')
  const stopped1 = await readCanvas(page)
  await page.waitForTimeout(400) // several native intervals' worth
  const stopped2 = await readCanvas(page)
  expect(stopped2.checksum).toBe(stopped1.checksum) // no drift once stopped
})

/**
 * The frame strip: an animating block gets 4 labelled, real (non-identical)
 * frames; a non-animating block says so plainly instead of showing four
 * copies of the same thumbnail - the exact "looks functional, proves
 * nothing" shape CLAUDE.md's oracle-discipline section warns about.
 */
test('the frame strip shows 4 real frames for an animating block, and an explicit message for one that does not animate', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  await clickBlock(page, ANIMATED_BLOCK_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })
  await expect(page.locator('.hb-map16-frame-strip-empty')).toHaveCount(0)
  const frameCanvases = page.locator('.hb-map16-frame-canvas')
  await expect(frameCanvases).toHaveCount(4)
  const labels = await page.locator('.hb-map16-frame-label').allTextContents()
  expect(labels).toEqual(['0', '1', '2', '3'])

  // Read each strip canvas back - real animation must produce at least one
  // frame that differs from frame 0, not four renders of the same bitmap.
  const stripChecksums = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll('.hb-map16-frame-canvas')]
    return canvases.map(c => {
      const ctx = c.getContext('2d')
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4)
        sum = (sum + data[i] * 7 + data[i + 1] * 13 + data[i + 2] * 17) >>> 0
      return sum
    })
  })
  expect(new Set(stripChecksums).size).toBeGreaterThan(1)

  // A block that does NOT animate: no strip, an explicit statement instead.
  await clickBlock(page, STATIC_BLOCK_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })
  await expect(page.locator('.hb-map16-frame-canvas')).toHaveCount(0)
  await expect(page.locator('.hb-map16-frame-strip-empty')).toHaveText(
    'This block does not animate.',
  )
})

/**
 * The large preview: shares the frame strip's own decoded source (map16-
 * view-widget.tsx's paintDetail decodes the block exactly once), so proving
 * it repaints for a different block and tracks the current phase while
 * playing is really proving that shared path works, not a separate one.
 */
test('the large block preview updates when the selection changes and tracks the current animation phase while playing', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page)

  await clickBlock(page, STATIC_BLOCK_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })
  const previewA = await page.evaluate(() => {
    const c = document.querySelector('.hb-map16-preview-canvas')
    return { w: c.width, h: c.height }
  })
  expect(previewA.w).toBeGreaterThan(16) // scaled up, not native 16x16
  expect(previewA.h).toBe(previewA.w) // square

  const readPreviewChecksum = () =>
    page.evaluate(() => {
      const c = document.querySelector('.hb-map16-preview-canvas')
      const ctx = c.getContext('2d')
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let sum = 0
      for (let i = 0; i < data.length; i += 4)
        sum = (sum + data[i] * 7 + data[i + 1] * 13 + data[i + 2] * 17) >>> 0
      return sum
    })
  const staticChecksum = await readPreviewChecksum()

  await clickBlock(page, ANIMATED_BLOCK_ID)
  await page.waitForSelector('.hb-map16-fields', { timeout: 5000 })
  const animatedChecksum = await readPreviewChecksum()
  expect(animatedChecksum).not.toBe(staticChecksum) // a different block, a different preview

  await page.locator('#hb-map16-play-toggle').click()
  await expect.poll(readPreviewChecksum, { timeout: 5000 }).not.toBe(animatedChecksum) // advances with the sheet's own animation phase
})

test('the Map16 view speaks of ROMs, never cartridges', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'Words'))
  await openMap16(page)
  const words = await shownWords(page, '.hb-map16-body')
  expect(words).toMatch(/Tileset/)
  expect(words).not.toMatch(CART)
})
