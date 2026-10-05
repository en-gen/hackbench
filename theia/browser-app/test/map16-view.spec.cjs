/**
 * The Map16 tile editor, end to end against the shell: the two tree rows,
 * the two independent widgets, the tile preview, the edit pane it opens on
 * request, the character palettes and the tile browser strip.
 *
 * Every assertion here is on BEHAVIOUR. A presence check passes for a blank
 * editor, and two defects in this repo's shell spike rendered perfectly and
 * did nothing. So picking a character is proved by the quadrant's PIXELS
 * changing AND by the committed word being read back from the service; a
 * color-row change is proved by the pixels changing WHILE every character
 * number stays put; the hover affordance is proved by the overlay becoming
 * visible AND by every bounding box around it staying exactly where it was.
 *
 * Three things this file gets right that its drag-era predecessor did not,
 * each of which made a real test fail for a reason that had nothing to do
 * with the product:
 *
 * - Only the ACTIVE tab of a dock area is rendered. With both tables open,
 *   the other one's canvases have no layout box, so every click on them
 *   waits for actionability and times out. `activate` is therefore called
 *   before touching either widget, and that is also what the user does.
 * - `checksum` mixes the pixel's OFFSET in. The old helper summed channel
 *   values with no positional term, so a horizontal mirror of an image
 *   hashed identically to the image: the assertion that tile $101 draws
 *   tl/tr as mirrors could not have failed, and did not pass either.
 * - A Theia RPC proxy is a `Proxy` whose `get` trap answers EVERY property
 *   with a freshly built RPC closure (proxy-factory.js:188). Assigning
 *   `svc.loadMap16 = ...` writes to the target and changes nothing, so the
 *   old refusal test's canned response was never returned. The refusal is
 *   now driven from a real cartridge whose fill-loop bound this file
 *   patches, which proves the backend gate rather than the renderer.
 *
 * One Theia BACKEND process serves every test in this file (only the
 * frontend page/context is fresh per test, via Playwright's default `page`
 * fixture). Two things about that are worth naming rather than silently
 * working around:
 *
 * - Every backend `*ServiceImpl` (Map16, Gfx, Palette) is a DI singleton
 *   whose `WorkingCopyNotifier` holds exactly ONE client, overwritten by
 *   whichever connection registered most recently. That is a real,
 *   pre-existing limitation - two genuine browser tabs on the same project
 *   would have the same problem - not something introduced or fixed here.
 *   It does NOT explain this file's own flakiness, though: every widget's
 *   push handler filters by `manifestPath === this.options?.manifestPath`
 *   before acting, and each test's project has a distinct manifest path.
 * - `WorkingRomRegistry`'s cache is keyed by manifest path and never evicts,
 *   so it accumulates one entry per test for the life of the backend
 *   process. Paths differ per test (fresh `tmp` dir each time), so entries
 *   never collide - memory growth over a long run, not a correctness bug.
 *
 * Tabs are PINNED (double click) rather than previewed, so each widget has
 * the stable dom id `hackbench.map16-view:<layer>` and a test can scope its
 * queries to one of the two tables even with both open.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords } = require('./rom-words.cjs')
const { expectCheckerboard } = require('./pixel-canvas.cjs')
const { parseRgbTriplet } = require('./palette-color.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, GPW2 } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

/** What vanilla holds. The view READS its count (readMap16TileCount); this
 *  is the cross-check, never the view's own default. */
const VANILLA_TILE_COUNT = 512
const TILES_PER_ROW = 16
const DEFAULT_ZOOM = 2
const TILE_PX = 16
/**
 * TILES_PER_PAGE / PAGE_GAP_PX in map16-view-widget.tsx: the strip is drawn as
 * 256-tile pages with a blank 6px band between them, so every tile past the
 * first page sits PAGE_GAP_PX lower per page than row * TILE_PX would put it.
 */
const TILES_PER_PAGE = 256
const PAGE_GAP_PX = 6

/** Mirrors the widget's tileOrigin: a tile's top-left in natural canvas px. */
function tileOrigin(tileId) {
  const page = Math.floor(tileId / TILES_PER_PAGE)
  const within = tileId % TILES_PER_PAGE
  return {
    x: (within % TILES_PER_ROW) * TILE_PX,
    y:
      Math.floor(within / TILES_PER_ROW) * TILE_PX +
      page * (TILES_PER_PAGE / TILES_PER_ROW) * TILE_PX +
      page * PAGE_GAP_PX,
  }
}

/** Widget dom ids, one per layer - map16WidgetId() in map16-view-model.ts. */
const FG = '#hackbench\\.map16-view\\:fg'
const BG = '#hackbench\\.map16-view\\:bg'
const ROOT = { fg: FG, bg: BG }

/**
 * One control, INSIDE one widget.
 *
 * Scoped by the widget root rather than by a global id, and that matters
 * for a reason measured on `ccb66b4`: a double click opened a preview
 * widget and a pinned one of the SAME layer, so every global `#id`
 * resolved to two elements and 21 of 26 cases died on strict mode. The
 * widgets no longer emit ids at all (see the duplicate-id case below), but
 * the lesson stands on its own - a lookup that can only work while ids
 * happen to be globally unique breaks again the moment two widgets
 * coexist, which the shell allows at any time.
 */
function ctl(base, layer = 'fg') {
  return `${ROOT[layer]} ${within(base)}`
}

/** The same control with no root, for use inside `:has()`, whose argument
 * is relative to the element it qualifies rather than to the document. */
function within(base) {
  return `[data-control="${base}"]`
}

/** CELL_PX in map16-char-palettes.tsx: CHAR_PX (8) * CHAR_SCALE (4). */
const CELL_PX = 32
const CHARS_PER_ROW = 8

/**
 * Tile $130, tileset 0: TL character is $30 on CGRAM row 4 ("sprite_sets"
 * Shared variant, i.e. StandardColors row 0 - PaletteStockTables.ts).
 * Confirmed by decoding the real ROM (loadAllMap16(rom, 0)[0x130].tl and
 * getCharPixels against loadVram(rom, 0)) that this character's pixels
 * actually use palette INDEX 4, i.e. CGRAM row 4 column 4 - StandardColors'
 * address $00B254, vanilla word $6318 - so editing that exact address is
 * guaranteed to move a pixel this tile draws, not a column this depth/tile
 * can never reach.
 */
const TARGET_TILE_ID = 0x130
const TARGET_ADDR = 0x00b254
const TARGET_OLD_HEX = '$6318'
const TARGET_NEW_HEX = '$03E0'

/**
 * Character-animation fixtures for FG tileset 0, confirmed by decoding the
 * real ROM (decodeMap16Sheet's own charAnimation.animatedTileIds): tile
 * $000 animates, tile $001 does not, and TARGET_TILE_ID ($130) also does
 * not. Picked from real data, not assumed.
 */
const ANIMATED_TILE_ID = 0x000
const STATIC_TILE_ID = 0x001
const VANILLA_FRAME_COUNT = 4

/**
 * The Map16 pointer-fill loop's tail, `bank_05.asm:229-237`:
 * ADC.W #$0008 / STA.B _0 / INX / INX / CPX.W #imm / BNE -. `null` is a
 * wildcard. Mirrors MAP16_COUNT_PATTERN in src/rom/Map16.ts; duplicated
 * here because a spec may not import the extension's TypeScript, and the
 * hit COUNT is asserted below so a drift would fail loudly rather than
 * silently patch nothing.
 */
const FILL_LOOP = [0x69, 0x08, 0x00, 0x85, null, 0xe8, 0xe8, 0xe0, null, null, 0xd0]
const FILL_LOOP_SITES = 3
const COPIER_HEADER = 512

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
 * Closed after every test to keep the ONE shared Theia backend process from
 * accumulating an open RPC subscription and a live widget per test. Both
 * pinned ids and both preview ids, since a single click and a double click
 * produce different widgets.
 */
async function closeMap16Views(page) {
  await page.evaluate(async () => {
    const shell = getSvc('ApplicationShell')
    for (const id of [
      'hackbench.map16-view:fg',
      'hackbench.map16-view:bg',
      'hackbench.map16-view:preview:layer=fg',
      'hackbench.map16-view:preview:layer=bg',
    ]) {
      try {
        await shell.closeWidget(id)
      } catch {
        /* nothing open under that id - fine */
      }
    }
  })
}

test.afterEach(async ({ page }) => {
  await closeMap16Views(page)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function createProject(page, dir, name = 'MyHack', romPath = ROM) {
  return page.evaluate(
    async ({ romPath, directory, projectName }) => {
      const svc = getSvc('Symbol(ProjectService)')
      return svc.createProject({ romPath, name: projectName, directory })
    },
    { romPath, directory: dir, projectName: name },
  )
}

async function loadGfxExplorer(page, dir, romPath = ROM) {
  const project = await createProject(page, dir, 'MyHack', romPath)
  await revealGfx(page)
  await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.gfx-explorer')
    await w.load(manifestPath)
  }, project.manifestPath)
  return project
}

/** Row 0 is Map16 Foreground, row 1 is Map16 Background. */
const ROW_OF = { fg: 0, bg: 1 }

/**
 * Brings one table's tab to the front.
 *
 * Only the ACTIVE tab of a dock area is laid out, so a canvas in the other
 * one has no box and every click on it waits for actionability until it
 * times out. Three of this file's tests used to fail for exactly that.
 */
async function activate(page, layer = 'fg') {
  await page.evaluate(async id => {
    // The result is DISCARDED on the page side on purpose: activateWidget
    // resolves to the Widget, and returning it makes Playwright try to
    // serialize a Lumino object graph across the boundary, which fails with
    // "object reference chain is too long" rather than with anything about
    // the widget.
    await getSvc('ApplicationShell').activateWidget(id)
  }, `hackbench.map16-view:${layer}`)
  await page.waitForTimeout(300)
}

/** Opens one Map16 table as a PINNED tab, so its widget id is stable. */
async function openMap16(page, layer = 'fg') {
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').nth(ROW_OF[layer]).dblclick()
  await page.waitForSelector(`${ROOT[layer]} .hb-map16-preview-canvas`, { timeout: 15000 })
  await page.waitForTimeout(500)
}

/**
 * The browser strip, read back at native resolution (zoom is CSS only).
 *
 * `checksum` mixes the pixel's OFFSET in, so two images made of the same
 * pixels in a different arrangement hash differently. The previous helper
 * did not, which made every mirror/flip assertion in this file unable to
 * fail.
 */
async function readCanvas(page, root = FG) {
  return page.evaluate(sel => {
    const canvas = document.querySelector(`${sel} .hb-map16-canvas`)
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const distinct = new Set()
    for (let i = 0; i < data.length; i += 4) {
      distinct.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`)
    }
    return {
      width: canvas.width,
      height: canvas.height,
      distinctColors: distinct.size,
      checksum: checksumOf(data),
    }
  }, root)
}

/** Any canvas, by selector: preview, frame quadrant or palette sheet. */
async function readCanvasChecksum(page, selector) {
  return page.evaluate(sel => {
    const c = document.querySelector(sel)
    if (!c) return null
    const ctx = c.getContext('2d')
    return checksumOf(ctx.getImageData(0, 0, c.width, c.height).data)
  }, selector)
}

/**
 * A copy of `src` whose Map16 pointer-fill loop claims `tiles` tiles.
 *
 * Nothing in the corpus carries Lunar Magic's expanded Map16 - all 6 carts
 * hold exactly 512 - so the only honest way to exercise the refusal end to
 * end is to make a cartridge that says otherwise. This reads the owner's
 * ROM at run time and writes the patched copy into the test's own tmp dir;
 * no ROM-derived bytes are committed.
 */
function romClaimingTileCount(src, dest, tiles) {
  const buf = fs.readFileSync(src)
  const base = buf.length % 1024 === COPIER_HEADER ? COPIER_HEADER : 0
  const sites = []
  for (let at = base; at <= buf.length - FILL_LOOP.length; at++) {
    let ok = true
    for (let k = 0; k < FILL_LOOP.length; k++) {
      if (FILL_LOOP[k] !== null && buf[at + k] !== FILL_LOOP[k]) {
        ok = false
        break
      }
    }
    if (ok) sites.push(at)
  }
  for (const at of sites) buf.writeUInt16LE(tiles * 2, at + 8)
  fs.writeFileSync(dest, buf)
  return sites.length
}

/** Whether the 16x16 region for `tileId` contains a pixel matching `rgb`. */
async function tileHasColor(page, tileId, rgb, root = FG) {
  const { x, y } = tileOrigin(tileId)
  return page.evaluate(
    ({ x, y, rgb, tilePx, sel }) => {
      const canvas = document.querySelector(`${sel} .hb-map16-canvas`)
      const ctx = canvas.getContext('2d')
      const data = ctx.getImageData(x, y, tilePx, tilePx).data
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
    { x, y, rgb, tilePx: TILE_PX, sel: root },
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

/** Clicks the tile at `tileId` on the browser strip, at the default zoom. */
async function clickTile(page, tileId, root = FG) {
  const { x, y } = tileOrigin(tileId)
  const center = TILE_PX / 2
  await page
    .locator(`${root} .hb-map16-canvas`)
    .click({ position: { x: (x + center) * DEFAULT_ZOOM, y: (y + center) * DEFAULT_ZOOM } })
  await page.waitForTimeout(300)
}

/**
 * Opens the edit pane the way a user does: hover the preview, which dims it
 * and surfaces the affordance, then press it.
 */
async function openEditPane(page, layer = 'fg') {
  await page.locator(`${ROOT[layer]} .hb-map16-preview`).hover()
  await page.locator(ctl('edit-toggle', layer)).click()
  await page.waitForSelector(`${ROOT[layer]} .hb-map16-edit-pane`, { timeout: 5000 })
  await page.waitForTimeout(300)
}

async function selectQuadrant(page, key, layer = 'fg') {
  await page
    .locator(
      `${ROOT[layer]} .hb-map16-frame[data-frame="0"] .hb-map16-quad[data-quadrant="${key}"]`,
    )
    .click()
  await page.waitForTimeout(200)
}

function quadrantCanvas(key, layer = 'fg', frame = 0) {
  return `${ROOT[layer]} .hb-map16-frame[data-frame="${frame}"] .hb-map16-quad[data-quadrant="${key}"] .hb-map16-quad-canvas`
}

/** Expands one palette section and waits for its characters to paint. */
async function expandSheet(page, slot, layer = 'fg') {
  const head = page.locator(
    `${ROOT[layer]} .hb-map16-sheet[data-slot="${slot}"] [data-control="sheet-head"]`,
  )
  if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
  await page.waitForSelector(`${ROOT[layer]} .hb-map16-sheet[data-slot="${slot}"] canvas`, {
    timeout: 5000,
  })
  await page.waitForTimeout(300)
}

/**
 * The editor's own displayed values for the selected quadrant, read out of
 * the DOM - the character number is read-only TEXT, not an input.
 */
async function readQuadrantUi(page, layer = 'fg') {
  return page.evaluate(sel => {
    const scope = document.querySelector(sel)
    const charText = scope.querySelector('.hb-map16-char-number').textContent
    const row = scope.querySelector('.hb-map16-rowpick-row-on')
    const toggle = label =>
      scope
        .querySelector(`.hb-map16-toggle[aria-label="${label}"]`)
        .getAttribute('aria-pressed') === 'true'
    return {
      charNum: parseInt(charText.replace('$', ''), 16),
      colorRow: row ? Number(row.getAttribute('data-row')) : null,
      source: scope.querySelector('.hb-map16-char-source').textContent,
      flipX: toggle('Flip X'),
      flipY: toggle('Flip Y'),
      priority: toggle('Priority'),
    }
  }, ROOT[layer])
}

/**
 * The COMMITTED word for one tile, read back through Map16Service itself.
 *
 * The strongest available oracle for "picking a character changed the
 * character field and nothing else": it reads what is actually in the
 * working copy, not what the editor is displaying. Projected down inside
 * the page because a whole sheet DTO carries several hundred KB of base64
 * atlases.
 */
async function readCommittedTile(page, manifestPath, tileset, layer, tileId) {
  return page.evaluate(
    async a => {
      const svc = getSvc('Symbol(Map16Service)')
      const r = await svc.loadMap16(a.manifestPath, a.tileset, a.layer, { bg: 0, fg: 0 })
      if (r.status !== 'ok') return { status: r.status, reason: r.reason }
      const t = r.sheet.tiles[a.tileId]
      const pick = q => ({
        charNum: q.charNum,
        colorRow: q.colorRow,
        priority: q.priority,
        flipX: q.flipX,
        flipY: q.flipY,
      })
      return {
        status: 'ok',
        tileCount: r.sheet.tiles.length,
        charLabels: r.sheet.charSheets.map(s => `${s.slot} - ${s.fileLabel}`),
        tl: pick(t.tl),
        tr: pick(t.tr),
        bl: pick(t.bl),
        br: pick(t.br),
      }
    },
    { manifestPath, tileset, layer, tileId },
  )
}

/** The accordion's section headers, as the user reads them. */
async function readSheetHeaders(page, layer = 'fg') {
  return page.evaluate(sel => {
    const heads = [...document.querySelectorAll(`${sel} .hb-map16-sheet-head`)]
    return heads.map(h => ({
      slot: h.querySelector('.hb-map16-sheet-slot').textContent,
      file: h.querySelector('.hb-map16-sheet-file').textContent,
      animated: !!h.querySelector('.hb-map16-sheet-anim'),
      expanded: h.getAttribute('aria-expanded') === 'true',
    }))
  }, ROOT[layer])
}

// -- The two rows and the two widgets ------------------------------------

test('the Graphics tree lists BOTH Map16 tables above the GFX files', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })

  const rows = await page.evaluate(async () => {
    const w = await getWidget('hackbench.gfx-explorer')
    return (w.model.root.children || []).map(n => ({ kind: n.kind, name: n.name, layer: n.layer }))
  })
  // One row called "Map16" showed only the FG table, which is how the BG
  // table went unnoticed entirely.
  expect(rows[0]).toMatchObject({ kind: 'map16', name: 'Map16 Foreground', layer: 'fg' })
  expect(rows[1]).toMatchObject({ kind: 'map16', name: 'Map16 Background', layer: 'bg' })
  expect(rows.slice(2).every(r => r.kind === 'file')).toBe(true)
})

test('opening a row shows a real sheet of the count the cartridge reports', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const info = await readCanvas(page)
  expect(info.width).toBe(TILES_PER_ROW * TILE_PX)
  // Every row of tiles, plus the blank band between each pair of pages.
  const pages = Math.ceil(VANILLA_TILE_COUNT / TILES_PER_PAGE)
  expect(info.height).toBe(
    (VANILLA_TILE_COUNT / TILES_PER_ROW) * TILE_PX + (pages - 1) * PAGE_GAP_PX,
  )
  // The band is one solid color and sits where tileOrigin puts page 1's top,
  // so tileHasColor and clickTile address the tile they name. Solid, not
  // clear: a clear band would show the transparency checkerboard and read
  // as part of a page.
  const band = await page.evaluate(
    ({ sel, top, height }) => {
      const canvas = document.querySelector(`${sel} .hb-map16-canvas`)
      const ctx = canvas.getContext('2d')
      const colors = (y, h) => {
        const data = ctx.getImageData(0, y, canvas.width, h).data
        const set = new Set()
        for (let i = 0; i < data.length; i += 4) {
          set.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`)
        }
        return [...set]
      }
      return { inBand: colors(top, height), below: colors(top + height, 1) }
    },
    { sel: FG, top: tileOrigin(TILES_PER_PAGE).y - PAGE_GAP_PX, height: PAGE_GAP_PX },
  )
  expect(band.inBand).toHaveLength(1)
  expect(band.inBand[0].endsWith(',255')).toBe(true)
  // Page 1's first row is tile art, not more band.
  expect(band.below).not.toEqual(band.inBand)
  // Real tile art, not a blank or single-color sheet.
  expect(info.distinctColors).toBeGreaterThan(1)

  const summary = await page.locator(`${FG} .hb-map16-summary-dims`).textContent()
  expect(summary).toContain(`${VANILLA_TILE_COUNT} tiles`)
  // "block" was this view's own invention; the community and
  // docs/glossary.md:137 both call a 16x16 Map16 entry a tile.
  expect(summary.toLowerCase()).not.toContain('block')
})

/**
 * A copy of `src` whose L2 (background) fill loop no longer ends in the PLP
 * that marks the level loader's copy (bank_05.asm:239), so the loop cannot
 * be located. Returns how many sites were patched.
 */
function romWithoutL2FillLoop(src, dest) {
  const buf = fs.readFileSync(src)
  const tail = [0x00, 0x04, 0xd0, 0xec, 0x28, 0x60]
  const sites = []
  for (let at = 0; at <= buf.length - tail.length; at++) {
    if (tail.every((b, k) => buf[at + k] === b)) sites.push(at)
  }
  for (const at of sites) buf[at + 4] = 0xea
  fs.writeFileSync(dest, buf)
  return sites.length
}

test('a Background table the ROM does not locate is refused, and Foreground still renders', async ({
  page,
}) => {
  const patched = path.join(tmp, 'no-l2-loop.sfc')
  expect(romWithoutL2FillLoop(ROM, patched), 'the L2 loop tail must match once').toBe(1)

  await loadGfxExplorer(page, path.join(tmp, 'MyHack'), patched)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').nth(ROW_OF.bg).dblclick()
  const refusal = page.locator(`${BG} .hb-map16-unavailable`)
  await expect(refusal).toBeVisible({ timeout: 15000 })
  expect(await refusal.textContent()).toContain('L2 (background)')
  await expect(page.locator(`${BG} .hb-map16-canvas`)).toHaveCount(0)
  await expect(page.locator(`${BG} .hb-map16-edit-pane`)).toHaveCount(0)

  await openMap16(page, 'fg')
  await expect(page.locator(`${FG} .hb-map16-canvas`)).toHaveCount(1, { timeout: 15000 })
})

/**
 * The two tables are two WIDGETS, not one widget with a mode switch. Both
 * open at once, each with its own selection, and neither has a Table
 * dropdown: the tab IS the table.
 */
test('Foreground and Background are separate widgets with independent selections', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await openMap16(page, 'bg')

  await expect(page.locator(FG)).toHaveCount(1)
  await expect(page.locator(BG)).toHaveCount(1)

  // The Table dropdown is gone from both.
  await expect(page.locator('#hb-map16-layer-select')).toHaveCount(0)
  // Each widget carries its own controls, addressed within its own root.
  for (const base of ['tileset-select', 'zoom-in', 'grid-toggle', 'browser-toggle']) {
    await expect(page.locator(ctl(base, 'fg'))).toHaveCount(1)
    await expect(page.locator(ctl(base, 'bg'))).toHaveCount(1)
  }

  await activate(page, 'fg')
  await clickTile(page, 0x130, FG)
  await activate(page, 'bg')
  await clickTile(page, 0x101, BG)

  expect(await page.locator(`${FG} .hb-map16-editor-tile-id`).textContent()).toMatch(/\$130/i)
  expect(await page.locator(`${BG} .hb-map16-editor-tile-id`).textContent()).toMatch(/\$101/i)

  // Selecting in one must not move the other.
  await activate(page, 'fg')
  await clickTile(page, 0x005, FG)
  expect(await page.locator(`${FG} .hb-map16-editor-tile-id`).textContent()).toMatch(/\$005/i)
  expect(await page.locator(`${BG} .hb-map16-editor-tile-id`).textContent()).toMatch(/\$101/i)
})

/**
 * A double click fires a single click FIRST, so the tree runs two handlers
 * for one gesture: one opens the preview tab, the other pins the row's own
 * widget and retires that preview.
 *
 * On `ccb66b4` the second looked before the first had attached anything,
 * found nothing, and left TWO attached widgets of the same layer rendering
 * the same controls. Every global `#id` then resolved to two elements and
 * 21 of 26 cases in this file died on strict mode.
 *
 * Two assertions, because either alone passes for the wrong reason: the
 * gesture leaves exactly one widget per layer, and no element id appears
 * twice anywhere in the document. The second is the invariant that actually
 * broke, and it holds however many widgets the shell decides to keep.
 */
test('a double click leaves ONE widget per layer, and no duplicate element ids', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await openMap16(page, 'bg')

  const widgets = await page.evaluate(() =>
    getSvc('ApplicationShell')
      .widgets.map(w => w.id)
      .filter(wid => wid.startsWith('hackbench.map16-view')),
  )
  expect(widgets.sort()).toEqual(['hackbench.map16-view:bg', 'hackbench.map16-view:fg'])

  // Every id in the document, not just this view's: a duplicate is invalid
  // HTML wherever it comes from, and getElementById answers with whichever
  // element attached first.
  const duplicates = await page.evaluate(() => {
    const seen = new Map()
    for (const el of document.querySelectorAll('[id]')) {
      seen.set(el.id, (seen.get(el.id) || 0) + 1)
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([elId, n]) => `${elId} x${n}`)
  })
  expect(duplicates).toEqual([])
})

// -- Preview and the edit pane -------------------------------------------

/**
 * The view opens on the PREVIEW. Hovering dims it and surfaces the
 * affordance, and - per docs/ui-conventions.md - moves no layout at all:
 * emphasis never shifts the page.
 *
 * Both halves matter. "Nothing moved" passes trivially for an affordance
 * that never appears, so the overlay's own opacity is asserted alongside
 * the boxes.
 */
test('the edit pane is absent until asked for, and the hover affordance moves no layout', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)

  await expect(page.locator(`${FG} .hb-map16-edit-pane`)).toHaveCount(0)
  await expect(page.locator(`${FG} .hb-map16-palettes`)).toHaveCount(0)
  await expect(page.locator(`${FG} .hb-map16-preview-canvas`)).toHaveCount(1)

  /**
   * EVERY box below the preview, not a sample: the elements the edit pane
   * adds are exactly the ones a reflow would push around, and measuring
   * only the closed state never sees them.
   *
   * Positions are measured in the WIDGET's own content space, not in
   * viewport coordinates. `getBoundingClientRect` alone cannot tell a
   * reflow from a scroll, and it reported one: opening the edit pane
   * scrolled its content into view, so six independent boxes each moved by
   * exactly 1030.0px with every width and height byte-identical. That is a
   * scroll, and the oracle called it a reflow. Adding back the scroll
   * offset of every ancestor up to the widget root removes the scrolling
   * degree of freedom while keeping sub-pixel precision, which
   * `offsetTop`/`offsetWidth` would have rounded away.
   */
  const boxes = async () =>
    page.evaluate(sel => {
      const root = document.querySelector(sel)
      const rootBox = root.getBoundingClientRect()
      const round = n => Math.round(n * 100) / 100
      const pick = q => {
        const el = document.querySelector(`${sel} ${q}`)
        if (!el) return null
        const b = el.getBoundingClientRect()
        let sx = 0
        let sy = 0
        for (let n = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
          sx += n.scrollLeft
          sy += n.scrollTop
        }
        return [
          round(b.x - rootBox.x + sx),
          round(b.y - rootBox.y + sy),
          round(b.width),
          round(b.height),
        ]
      }
      const overlay = document.querySelector(`${sel} .hb-map16-preview-overlay`)
      return {
        preview: pick('.hb-map16-preview-canvas'),
        caption: pick('.hb-map16-preview-caption'),
        browser: pick('.hb-map16-browser'),
        editPane: pick('.hb-map16-edit-pane'),
        frames: pick('.hb-map16-frames'),
        firstFrame: pick('.hb-map16-frame[data-frame="0"]'),
        fields: pick('.hb-map16-quad-fields'),
        palettes: pick('.hb-map16-palettes'),
        firstSheet: pick('.hb-map16-sheet'),
        overlayOpacity: Number(getComputedStyle(overlay).opacity),
      }
    }, FG)

  const unhover = async () => {
    await page.locator(`${FG} .hb-map16-browser-head`).hover()
    await page.waitForTimeout(250)
  }

  const beforeClosed = await boxes()
  expect(beforeClosed.overlayOpacity).toBe(0)

  await page.locator(`${FG} .hb-map16-preview`).hover()
  await page.waitForTimeout(250)
  const afterClosed = await boxes()

  // The affordance really did appear...
  expect(afterClosed.overlayOpacity).toBeGreaterThan(0.9)
  await expect(page.locator(ctl('edit-toggle'))).toBeVisible()
  // ...and nothing moved by so much as a pixel.
  expect(afterClosed).toEqual({ ...beforeClosed, overlayOpacity: afterClosed.overlayOpacity })

  await openEditPane(page)
  await expect(page.locator(`${FG} .hb-map16-edit-pane`)).toHaveCount(1)
  await expect(page.locator(ctl('edit-toggle'))).toHaveAttribute('aria-pressed', 'true')

  // Again with the pane OPEN, which is when there is something below the
  // preview for a reflow to move.
  await expandSheet(page, 'fg3')
  await unhover()
  const beforeOpen = await boxes()
  expect(beforeOpen.overlayOpacity).toBe(0)
  expect(beforeOpen.frames).not.toBeNull()
  expect(beforeOpen.palettes).not.toBeNull()

  await page.locator(`${FG} .hb-map16-preview`).hover()
  await page.waitForTimeout(250)
  const afterOpen = await boxes()
  expect(afterOpen.overlayOpacity).toBeGreaterThan(0.9)
  expect(afterOpen).toEqual({ ...beforeOpen, overlayOpacity: afterOpen.overlayOpacity })

  // -- and now prove this oracle can fail -------------------------------
  //
  // The version of this check that shipped before could not: it compared
  // viewport coordinates, so it fired on a scroll and said nothing about a
  // reflow. Rather than assert that in a comment, plant a REAL reflow - a
  // hover rule that changes layout instead of painting - and watch the same
  // comparison catch it, in this run, on this machine.
  const plantedStyle = await page.addStyleTag({
    content: `${FG} .hb-map16-preview:hover { padding-bottom: 24px; }`,
  })
  await unhover()
  const beforePlanted = await boxes()
  await page.locator(`${FG} .hb-map16-preview`).hover()
  await page.waitForTimeout(250)
  const afterPlanted = await boxes()
  expect(
    afterPlanted,
    'the planted reflow must move something, or this oracle proves nothing',
  ).not.toEqual({ ...beforePlanted, overlayOpacity: afterPlanted.overlayOpacity })
  // Everything BELOW the preview moved down by the planted padding, and the
  // preview canvas itself did not: that is the signature of a reflow, and
  // the signature a scroll cannot produce.
  expect(afterPlanted.preview).toEqual(beforePlanted.preview)
  expect(afterPlanted.caption[1] - beforePlanted.caption[1]).toBe(24)
  expect(afterPlanted.frames[1] - beforePlanted.frames[1]).toBe(24)

  // Remove it and the boxes come back, which also proves the planted style
  // was what moved them rather than anything else this test did. Removed by
  // its own handle, not by picking the last <style> in the document, which
  // is only the planted one until something else appends one.
  await plantedStyle.evaluate(el => el.remove())
  await unhover()
  await page.locator(`${FG} .hb-map16-preview`).hover()
  await page.waitForTimeout(250)
  const afterRemoval = await boxes()
  expect(afterRemoval).toEqual({ ...beforeOpen, overlayOpacity: afterRemoval.overlayOpacity })
})

/**
 * Frames are derived from what the TILE does, never from a slot name. The
 * earlier design was going to call `an1` the animated slot and freeze it;
 * measured on all 15 tilesets of all 6 corpus ROMs, animated characters
 * land in fg1/fg2 and never in an1.
 */
test('a tile that cites no animated character shows ONE frame, one that does shows four', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  await clickTile(page, STATIC_TILE_ID)
  await openEditPane(page)
  await expect(page.locator(`${FG} .hb-map16-frame`)).toHaveCount(1)
  expect(await page.locator(`${FG} .hb-map16-frames-note`).textContent()).toMatch(
    /nothing this tile cites animates/i,
  )

  await clickTile(page, ANIMATED_TILE_ID)
  await expect(page.locator(`${FG} .hb-map16-frame`)).toHaveCount(VANILLA_FRAME_COUNT)
  expect(await page.locator(`${FG} .hb-map16-frame-label`).allTextContents()).toEqual([
    '0',
    '1',
    '2',
    '3',
  ])

  // Four GENUINELY different frames, not four copies of one thumbnail
  // standing in for "we don't know".
  const checksums = []
  for (let f = 0; f < VANILLA_FRAME_COUNT; f++) {
    checksums.push(await readCanvasChecksum(page, quadrantCanvas('tl', 'fg', f)))
  }
  expect(new Set(checksums).size).toBeGreaterThan(1)
})

// -- The character palettes ----------------------------------------------

/**
 * The constraint that shapes the whole feature: a quadrant can only say
 * "character N", so the accordion offers exactly the four sheets this
 * tileset has LOADED. Fifty GFX files would let the user pick a character
 * that is not in VRAM, and it would render as whatever actually sits at
 * that address.
 */
test('the accordion shows exactly four sheets, headed by slot and the file this tileset loads', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)

  const heads = await readSheetHeaders(page)
  expect(heads.map(h => h.slot)).toEqual(['fg1', 'fg2', 'fg3', 'an1'])
  for (const h of heads) expect(h.file).toMatch(/^GFX[0-9A-F]{2}$/)

  // The headers must name the files the service actually resolved from
  // OBJECTGFXLIST - Map16Decode.charSheets.test.ts pins that DTO against
  // readGfxAssignment directly, so this is the wiring half of that claim.
  const committed = await readCommittedTile(page, project.manifestPath, 0, 'fg', 0)
  expect(heads.map(h => `${h.slot} - ${h.file}`)).toEqual(committed.charLabels)

  await expandSheet(page, 'fg3')
  await expect(
    page.locator(`${FG} .hb-map16-sheet[data-slot="fg3"] .hb-map16-char`).first(),
  ).toBeVisible()
})

/** Same checkerboard as the GFX view, on a character sheet and the strip. */
test('color 0 shows a transparency checkerboard', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await expandSheet(page, 'fg3')
  await expectCheckerboard(
    expect,
    page,
    `${FG} .hb-map16-sheet[data-slot="fg3"] .hb-map16-sheet-canvas`,
  )
  await expectCheckerboard(expect, page, `${FG} .hb-map16-canvas`)
})

/**
 * The quad's outline is drawn over its canvas: the canvas's checkerboard
 * once painted over the quad's own inset shadow, and only aria-pressed
 * still said which quadrant was selected.
 */
test('the selected quadrant shows its outline on screen', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await selectQuadrant(page, 'tr')
  const focus = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--theia-focusBorder, #5b9cf6)'
    document.body.appendChild(probe)
    const c = getComputedStyle(probe).color
    probe.remove()
    return c
  })
  // One pixel in from the left edge, halfway down: inside the 2px outline.
  const edgePixel = async key => {
    const quad = page.locator(
      `${FG} .hb-map16-frame[data-frame="0"] .hb-map16-quad[data-quadrant="${key}"]`,
    )
    const box = await quad.boundingBox()
    const clip = { x: box.x + 1, y: box.y + Math.floor(box.height / 2), width: 1, height: 1 }
    const png = (await page.screenshot({ clip })).toString('base64')
    return page.evaluate(async b64 => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
    }, png)
  }
  expect(await edgePixel('tr')).toEqual(parseRgbTriplet(focus))
  expect(await edgePixel('tl')).not.toEqual(parseRgbTriplet(focus))
})

/** The page bands are a theme color baked into the bitmap, so a theme switch repaints them. */
test('the strip page bands follow a theme switch', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  const top = tileOrigin(TILES_PER_PAGE).y - PAGE_GAP_PX
  const band = () =>
    page.evaluate(
      ({ sel, y }) => {
        const c = document.querySelector(`${sel} .hb-map16-canvas`)
        return Array.from(c.getContext('2d').getImageData(0, y, 1, 1).data.slice(0, 3))
      },
      { sel: FG, y: top },
    )
  const editorBackground = () =>
    page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--theia-editor-background)'
      document.body.appendChild(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    })
  const setTheme = async id => {
    await page.evaluate(t => getSvc('ThemeService').setCurrentTheme(t, false), id)
    await page.waitForTimeout(600)
  }
  const original = await page.evaluate(() => getSvc('ThemeService').getCurrentTheme().id)
  try {
    await setTheme('light')
    const light = await band()
    expect(light).toEqual(parseRgbTriplet(await editorBackground()))
    await setTheme('dark')
    const dark = await band()
    expect(dark).toEqual(parseRgbTriplet(await editorBackground()))
    expect(dark).not.toEqual(light)
  } finally {
    await setTheme(original)
  }
})

test('switching tileset changes both the sheet headers and the rendered characters', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  // fg3 is a slot that VARIES by tileset (file $25 on tileset 0, $12 on 3).
  await expandSheet(page, 'fg3')

  const headsBefore = await readSheetHeaders(page)
  const pixelsBefore = await readCanvasChecksum(
    page,
    `${FG} .hb-map16-sheet[data-slot="fg3"] .hb-map16-sheet-canvas`,
  )

  await page.selectOption(ctl('tileset-select'), '3')
  await page.waitForTimeout(800)

  const headsAfter = await readSheetHeaders(page)
  const pixelsAfter = await readCanvasChecksum(
    page,
    `${FG} .hb-map16-sheet[data-slot="fg3"] .hb-map16-sheet-canvas`,
  )

  expect(headsAfter.map(h => h.file)).not.toEqual(headsBefore.map(h => h.file))
  // Pixels too, not just labels: a palette that relabels without
  // re-decoding is exactly the confidently-wrong case this feature exists
  // to avoid.
  expect(pixelsAfter).not.toBe(pixelsBefore)
})

/**
 * The handles are transparent boxes laid over one canvas that paints every
 * character at once, so the grid geometry and the canvas geometry have to
 * agree exactly or a click lands on a neighbour. Both are sized from
 * CELL_PX in map16-char-palettes.tsx; this asserts the result rather than
 * the constant, which is the half a stylesheet edit could break.
 */
test('a character handle sits exactly over the character it paints', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await expandSheet(page, 'fg3')

  const geometry = await page.evaluate(
    ({ sel, perRow }) => {
      const section = document.querySelector(`${sel} .hb-map16-sheet[data-slot="fg3"]`)
      const canvas = section.querySelector('.hb-map16-sheet-canvas').getBoundingClientRect()
      const handles = [...section.querySelectorAll('.hb-map16-char')]
      const base = Number(handles[0].dataset.char)
      const probe = handles.map((h, i) => {
        const b = h.getBoundingClientRect()
        return {
          index: i,
          dx: Math.round(b.x - canvas.x),
          dy: Math.round(b.y - canvas.y),
          w: Math.round(b.width),
          h: Math.round(b.height),
          col: i % perRow,
          row: Math.floor(i / perRow),
        }
      })
      return { base, count: handles.length, canvasW: Math.round(canvas.width), probe }
    },
    { sel: FG, perRow: CHARS_PER_ROW },
  )

  expect(geometry.count).toBeGreaterThan(CHARS_PER_ROW)
  expect(geometry.canvasW).toBe(CHARS_PER_ROW * CELL_PX)
  // Every handle, not a sampled one: an off-by-one row would show up only
  // past the first row.
  for (const p of geometry.probe) {
    expect({ dx: p.dx, dy: p.dy, w: p.w, h: p.h }).toEqual({
      dx: p.col * CELL_PX,
      dy: p.row * CELL_PX,
      w: CELL_PX,
      h: CELL_PX,
    })
  }
})

/**
 * The palettes are frozen at the cartridge's frame 0. A click target that
 * changes four times a second is not a click target - while the tile
 * surfaces keep animating, which the browser-strip poll proves, so this
 * cannot pass for the wrong reason (a frozen app).
 */
test('the character palettes do not animate while playback is running', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, ANIMATED_TILE_ID)
  await openEditPane(page)

  const heads = await readSheetHeaders(page)
  const animated = heads.find(h => h.animated)
  expect(animated, 'vanilla tileset 0 animates characters in at least one slot').toBeTruthy()
  // Measured on all 15 tilesets of all 6 corpus ROMs: never an1.
  expect(animated.slot).not.toBe('an1')

  await expandSheet(page, animated.slot)
  const sheetSel = `${FG} .hb-map16-sheet[data-slot="${animated.slot}"] .hb-map16-sheet-canvas`
  const sheetBefore = await readCanvasChecksum(page, sheetSel)
  const stripBefore = await readCanvas(page)

  await page.locator(ctl('play-toggle')).click()
  await expect
    .poll(async () => (await readCanvas(page)).checksum, { timeout: 5000 })
    .not.toBe(stripBefore.checksum)

  expect(await readCanvasChecksum(page, sheetSel)).toBe(sheetBefore)
  await page.locator(ctl('play-toggle')).click()
})

// -- Assigning a character -----------------------------------------------

/**
 * The headline gesture: select a quadrant, click a character. Three things
 * must be true at once, and a check of any one alone would pass for a
 * broken editor:
 *
 * 1. the quadrant's RENDERED PIXELS change,
 * 2. the committed word's character field becomes the clicked number,
 * 3. NOTHING ELSE in that word, or in the other three quadrants, moves.
 *
 * (3) is why picking a character does not also take a color row: that
 * would change two fields from one gesture, and the palette's colors come
 * from the selected quadrant's row rather than from the character itself.
 */
test('selecting a quadrant and clicking a character changes its pixels and only its character field', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await selectQuadrant(page, 'tr')

  const before = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)
  expect(before.status).toBe('ok')
  const quadBefore = await readCanvasChecksum(page, quadrantCanvas('tr'))

  await expandSheet(page, 'fg3')

  // A character the quadrant does NOT already hold: picking the same one
  // would prove nothing about the pixels.
  const candidate = await page.evaluate(
    ({ sel, avoid }) => {
      const handles = [
        ...document.querySelectorAll(`${sel} .hb-map16-sheet[data-slot="fg3"] .hb-map16-char`),
      ]
      return handles.map(h => Number(h.dataset.char)).find(c => c !== avoid)
    },
    { sel: FG, avoid: before.tr.charNum },
  )
  expect(candidate).toBeGreaterThanOrEqual(0)

  await page.locator(`${FG} .hb-map16-char[data-char="${candidate}"]`).click()

  // Poll the COMMITTED word: the click is a round trip, and the optimistic
  // display would satisfy a DOM-only check before the write landed.
  await expect
    .poll(
      async () =>
        (await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)).tr.charNum,
      { timeout: 10000 },
    )
    .toBe(candidate)

  const after = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)
  // Every other field of the quadrant, unchanged.
  expect({ ...after.tr, charNum: before.tr.charNum }).toEqual(before.tr)
  // And the other three quadrants, untouched.
  expect(after.tl).toEqual(before.tl)
  expect(after.bl).toEqual(before.bl)
  expect(after.br).toEqual(before.br)

  // The picture, not just the number.
  expect(await readCanvasChecksum(page, quadrantCanvas('tr'))).not.toBe(quadBefore)

  // The read-only number beside the picture verifies the choice and names
  // where the character came from.
  const ui = await readQuadrantUi(page)
  expect(ui.charNum).toBe(candidate)
  expect(ui.source).toMatch(/^(fg1|fg2|fg3|an1) - GFX[0-9A-F]{2}$/)

  // A real op layer on disk, with the full-word mask a Map16 write needs.
  const opsDir = path.join(tmp, 'MyHack', 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles.length).toBeGreaterThan(0)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[opFiles.length - 1]), 'utf8'))
  expect(layer.ops[0].mask).toBe(0xffff)
})

test('no control anywhere accepts a typed character number', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await expandSheet(page, 'fg3')

  // The interface the owner rejected: "I don't like that interface,
  // especially having to just type in a char number."
  await expect(page.locator(`${FG} input`)).toHaveCount(0)
  await expect(page.locator(`${FG} [contenteditable="true"]`)).toHaveCount(0)
  // The number is still on screen, as text: recognition comes from the
  // picture, verification from the number.
  await expect(page.locator(`${FG} .hb-map16-char-number`)).toHaveText(/^\$[0-9A-F]{3}$/)
})

// -- Color rows ----------------------------------------------------------

/**
 * Changing the color row must recolor the tile and leave every character
 * number exactly where it was. The picker offers only rows the sheet's own
 * characters cite, and only as many swatches as the SELECTED character's
 * own sheet can index - a 3bpp sheet never reaches 8-15, so offering them
 * would invite an edit that renders wrong.
 */
test('choosing a different color row recolors the tile and moves no character number', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await selectQuadrant(page, 'tl')

  const before = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)
  const quadBefore = await readCanvasChecksum(page, quadrantCanvas('tl'))

  const rows = await page.evaluate(sel => {
    const buttons = [...document.querySelectorAll(`${sel} .hb-map16-rowpick-row`)]
    return buttons.map(b => ({
      row: Number(b.getAttribute('data-row')),
      swatches: b.querySelectorAll('.hb-map16-swatch').length,
      on: b.classList.contains('hb-map16-rowpick-row-on'),
    }))
  }, FG)

  // Real swatch strips, built from the CGRAM the sheet was composited with.
  expect(rows.length).toBeGreaterThan(1)
  for (const r of rows) {
    expect(r.row).toBeGreaterThanOrEqual(0)
    // 3 bits: rows 8-15 are unreachable from a quadrant's color-row field.
    expect(r.row).toBeLessThan(8)
    expect(r.swatches).toBeGreaterThan(0)
    expect(r.swatches).toBeLessThanOrEqual(16)
  }

  const target = rows.find(r => !r.on)
  await page.locator(`${FG} .hb-map16-rowpick-row[data-row="${target.row}"]`).click()

  await expect
    .poll(
      async () =>
        (await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)).tl.colorRow,
      { timeout: 10000 },
    )
    .toBe(target.row)

  const after = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)
  // Every character number in the tile, unchanged.
  expect([after.tl.charNum, after.tr.charNum, after.bl.charNum, after.br.charNum]).toEqual([
    before.tl.charNum,
    before.tr.charNum,
    before.bl.charNum,
    before.br.charNum,
  ])
  // And the colors on screen actually moved.
  expect(await readCanvasChecksum(page, quadrantCanvas('tl'))).not.toBe(quadBefore)
})

test('the flip and priority toggles each move exactly their own bit', async ({ page }) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)
  await selectQuadrant(page, 'tl')

  const before = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)

  const flipX = page.locator(`${FG} .hb-map16-toggle[aria-label="Flip X"]`)
  await expect(flipX).toHaveAttribute('aria-pressed', String(before.tl.flipX))
  await flipX.click()
  await expect
    .poll(
      async () =>
        (await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)).tl.flipX,
      { timeout: 10000 },
    )
    .toBe(!before.tl.flipX)

  // Only that bit: a toggle that also reset a flip or the color row would
  // be two edits from one gesture.
  const after = await readCommittedTile(page, project.manifestPath, 0, 'fg', TARGET_TILE_ID)
  expect({ ...after.tl, flipX: before.tl.flipX }).toEqual(before.tl)
  // The pressed state must be readable without a hover or a tooltip, and
  // the read-only line beside it must agree with the toggle.
  await expect(flipX).toHaveAttribute('aria-pressed', String(!before.tl.flipX))
  await expect(flipX).toHaveClass(/hb-map16-toggle-on/)
})

// -- Refusals ------------------------------------------------------------

/**
 * A cartridge whose Map16 this view cannot present IN FULL is refused with
 * a reason, never truncated to two pages.
 *
 * Driven by a REAL cartridge: the corpus holds no expanded Map16 (all 6
 * carts hold exactly 512), so this copies the owner's ROM into the test's
 * tmp dir and rewrites the three `CPX #imm` bounds of the pointer-fill loop
 * to claim 2048. No ROM-derived bytes are committed; the bytes are read at
 * run time from the cart the suite already needs.
 *
 * The site count is asserted, so a pattern that stopped matching fails
 * loudly instead of silently patching nothing and testing the vanilla path.
 */
test('a Map16 the view cannot present in full is refused with a reason, not truncated', async ({
  page,
}) => {
  const patched = path.join(tmp, 'expanded.sfc')
  const sites = romClaimingTileCount(ROM, patched, 2048)
  expect(sites, 'the fill-loop pattern must still match all three sites').toBe(FILL_LOOP_SITES)

  await loadGfxExplorer(page, path.join(tmp, 'MyHack'), patched)
  await page.waitForSelector('#hackbench\\.gfx-explorer .theia-TreeNode', { timeout: 15000 })
  await page.locator('#hackbench\\.gfx-explorer .theia-TreeNode').nth(ROW_OF.fg).dblclick()

  const refusal = page.locator(`${FG} .hb-map16-unavailable`)
  await expect(refusal).toBeVisible({ timeout: 15000 })
  const reason = await refusal.textContent()
  expect(reason).toContain('2048')
  expect(reason).toContain('512')
  expect(reason).toContain('en-gen/hackbench#41')

  // Nothing plausible-looking rendered in its place. Two pages of an
  // expanded table would look exactly right and be wrong.
  await expect(page.locator(`${FG} .hb-map16-canvas`)).toHaveCount(0)
  await expect(page.locator(`${FG} .hb-map16-preview-canvas`)).toHaveCount(0)
  await expect(page.locator(`${FG} .hb-map16-edit-pane`)).toHaveCount(0)
})

// -- The BG table's own values -------------------------------------------

/**
 * FG and BG are two separate tables. Values decoded independently from
 * vanilla bytes at offset 0x69100 (SNES $0D9100, no copier header on this
 * cart), column-major words (w0 tl, w1 bl, w2 tr, w3 br) - see
 * Map16.romAddress.test.ts's BG section for the address proof. tl differing
 * from the FG table's own $100 (character $182, row 2) proves the BG tab is
 * reading a different table, not relabelling the same data.
 */
test('the Background tab shows the global Layer 2 table with its own real values', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'bg')
  await clickTile(page, 0x100, BG)

  const tile = await readCommittedTile(page, project.manifestPath, 0, 'bg', 0x100)
  expect(tile.tl).toMatchObject({ charNum: 0x0fd, colorRow: 1 })
  expect(tile.tr).toMatchObject({ charNum: 0x106, colorRow: 1 })
  expect(tile.bl).toMatchObject({ charNum: 0x0fd, colorRow: 1 })
  expect(tile.br).toMatchObject({ charNum: 0x107, colorRow: 1 })

  // And the editor is showing those values, not some other tile's.
  await openEditPane(page, 'bg')
  await selectQuadrant(page, 'tr', 'bg')
  expect((await readQuadrantUi(page, 'bg')).charNum).toBe(0x106)
})

/**
 * Flip flags specifically, which a character-number-only check would not
 * catch: tile $101's tl and tr both hold character $100, and tr is its
 * horizontal mirror (words $0500 and $4500 at 0x69108, read off the
 * cartridge).
 *
 * This is the assertion the old positional-blind checksum could not make:
 * a mirror is the same pixels in a different order, so a hash with no
 * positional term returns the same number for both and the comparison can
 * neither pass nor fail honestly.
 */
test('BG tile $101 renders tl/tr as horizontal mirrors of the same character', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'bg')
  await clickTile(page, 0x101, BG)
  await openEditPane(page, 'bg')

  await selectQuadrant(page, 'tl', 'bg')
  const tl = await readQuadrantUi(page, 'bg')
  expect(tl.charNum).toBe(0x100)
  expect(tl.flipX).toBe(false)

  await selectQuadrant(page, 'tr', 'bg')
  const tr = await readQuadrantUi(page, 'bg')
  expect(tr.charNum).toBe(0x100)
  expect(tr.flipX).toBe(true)

  // Same character, mirrored: the PIXELS must differ, or the flip bit is
  // being displayed and not applied.
  const tlPixels = await readCanvasChecksum(page, quadrantCanvas('tl', 'bg'))
  const trPixels = await readCanvasChecksum(page, quadrantCanvas('tr', 'bg'))
  expect(trPixels).not.toBe(tlPixels)

  // ...and the two really are made of the same pixels, so what differs is
  // the ARRANGEMENT. A quadrant painted from the wrong character would
  // also fail the check above, for the wrong reason.
  const histograms = await page.evaluate(
    ({ tlSel, trSel }) => {
      const histogram = sel => {
        const c = document.querySelector(sel)
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        const counts = {}
        for (let i = 0; i < data.length; i += 4) {
          const key = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`
          counts[key] = (counts[key] || 0) + 1
        }
        return counts
      }
      return { tl: histogram(tlSel), tr: histogram(trSel) }
    },
    { tlSel: quadrantCanvas('tl', 'bg'), trSel: quadrantCanvas('tr', 'bg') },
  )
  expect(histograms.tr).toEqual(histograms.tl)
})

/**
 * The BG TILE TABLE does not vary with tileset, but the RENDERED PIXELS
 * still do: readGfxAssignment differs across tilesets in the fg3/an1 slots
 * the BG table heavily uses (64.0% of its characters, measured). Goes red
 * if anyone disables the tileset control on BG or drops tileset from the BG
 * VRAM path.
 */
test('switching tileset on the Background tab still changes the rendered pixels', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'bg')

  await expect(page.locator(ctl('tileset-select', 'bg'))).toBeEnabled()
  const before = await readCanvas(page, BG)
  await page.selectOption(ctl('tileset-select', 'bg'), '3')
  await page.waitForTimeout(600)
  expect((await readCanvas(page, BG)).checksum).not.toBe(before.checksum)
})

/**
 * Which palette control can affect a sheet's pixels is derived from the
 * LOADED TABLE (citedColorRows), never assumed from which layer this is.
 * Vanilla measurement (identical on all 6 corpus carts): the BG table cites
 * CGRAM rows {0,1,4,7} only - zero characters on rows 2-3, which the FG
 * palette control feeds - so there that control genuinely cannot change a
 * pixel. The FG common table cites both pairs.
 */
test('the FG palette control disables itself on the Background tab and stays live on Foreground', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await expect(page.locator(ctl('bg-variant-select'))).toBeEnabled()
  await expect(page.locator(ctl('fg-variant-select'))).toBeEnabled()

  await openMap16(page, 'bg')
  await expect(page.locator(ctl('bg-variant-select', 'bg'))).toBeEnabled()
  await expect(page.locator(ctl('fg-variant-select', 'bg'))).toBeDisabled()

  const fgLabel = page.locator(`${BG} label.hb-map16-control:has(${within('fg-variant-select')})`)
  await expect(fgLabel).toHaveAttribute('title', /no character.*foreground/i)
})

test('the tileset control says it is graphics-only on the Background tab', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  const fgLabel = await page
    .locator(`${FG} label.hb-map16-control:has(${within('tileset-select')})`)
    .innerText()
  expect(fgLabel).toMatch(/^Tileset/)
  expect(fgLabel.toLowerCase()).not.toContain('graphics only')

  await openMap16(page, 'bg')
  const bgLabel = await page
    .locator(`${BG} label.hb-map16-control:has(${within('tileset-select')})`)
    .innerText()
  expect(bgLabel.toLowerCase()).toContain('graphics only')
  await expect(page.locator(ctl('tileset-select', 'bg'))).toBeEnabled()
})

// -- Cross-view push, view state, animation ------------------------------

/**
 * A PALETTE edit made through PaletteService visibly recolors an
 * ALREADY-OPEN Map16 view, with no manual reload - the push path
 * map16-push-client.ts and WorkingCopyNotifier exist for.
 *
 * The edited address/color ($00B254, StandardColors row 0 col 4) was chosen
 * because tile $130's TL character ($30, color row 4) was decoded from the
 * real ROM and confirmed to actually use palette index 4. A column this
 * tile's pixels can never reach would pass "the canvas didn't change" for
 * the wrong reason.
 */
test('a palette edit visibly recolors an already-open Map16 view, with no manual reload', async ({
  page,
}) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const newRgb = bgr555ToRgbTriplet(parseInt(TARGET_NEW_HEX.slice(1), 16))
  const oldRgb = bgr555ToRgbTriplet(parseInt(TARGET_OLD_HEX.slice(1), 16))

  expect(await tileHasColor(page, TARGET_TILE_ID, oldRgb)).toBe(true)
  expect(await tileHasColor(page, TARGET_TILE_ID, newRgb)).toBe(false)
  const before = await readCanvas(page)

  // Edited through PaletteService directly - the Palette view is not open
  // at all, so this is unambiguously the push path.
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
  expect(await tileHasColor(page, TARGET_TILE_ID, newRgb)).toBe(true)
  expect(await tileHasColor(page, TARGET_TILE_ID, oldRgb)).toBe(false)
})

/**
 * Seven independent pieces of view state (tileset, BG palette variant, FG
 * palette variant, zoom, grid, playing, the edit pane) plus the selection.
 * This is the class of bug that has cost the most time on this view:
 * changing any one must preserve the selected tile and must not reset any
 * of the others.
 */
test('changing tileset/palettes/zoom/grid/playing preserves the selection and the others', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  await openEditPane(page)

  const stillSelected = async () => {
    const tileId = await page.locator(`${FG} .hb-map16-editor-tile-id`).textContent()
    expect(tileId).toMatch(/\$130/i)
    // The pane stays open across every axis change: closing it would throw
    // away the user's place in a way nothing asked for.
    await expect(page.locator(`${FG} .hb-map16-edit-pane`)).toHaveCount(1)
  }
  const controlValues = async () => ({
    tileset: await page.locator(ctl('tileset-select')).inputValue(),
    bg: await page.locator(ctl('bg-variant-select')).inputValue(),
    fg: await page.locator(ctl('fg-variant-select')).inputValue(),
    zoom: await page.locator(ctl('zoom-indicator')).textContent(),
    grid: (await page.locator(ctl('grid-toggle')).getAttribute('aria-pressed')) === 'true',
    playing: (await page.locator(ctl('play-toggle')).getAttribute('aria-pressed')) === 'true',
  })

  // Zoom: purely a view preference, touches no server state. Driven to the
  // clamp rather than a fixed count, which would overshoot onto a disabled
  // button and hang; that also asserts the clamp.
  let before = await controlValues()
  const zoomIn = page.locator(ctl('zoom-in'))
  while (await zoomIn.isEnabled()) await zoomIn.click()
  await page.waitForTimeout(200)
  await stillSelected()
  let after = await controlValues()
  expect(after.zoom).toBe('400%')
  expect({ ...after, zoom: before.zoom }).toEqual(before)

  before = await controlValues()
  await page.selectOption(ctl('bg-variant-select'), '7')
  await page.waitForTimeout(400)
  await stillSelected()
  after = await controlValues()
  expect(after.bg).toBe('7')
  expect({ ...after, bg: before.bg }).toEqual(before)

  before = await controlValues()
  await page.selectOption(ctl('fg-variant-select'), '3')
  await page.waitForTimeout(400)
  await stillSelected()
  after = await controlValues()
  expect(after.fg).toBe('3')
  expect({ ...after, fg: before.fg }).toEqual(before)

  before = await controlValues()
  await page.selectOption(ctl('tileset-select'), '5')
  await page.waitForTimeout(400)
  await stillSelected()
  after = await controlValues()
  expect(after.tileset).toBe('5')
  expect({ ...after, tileset: before.tileset }).toEqual(before)

  before = await controlValues()
  await page.locator(ctl('grid-toggle')).click()
  await page.waitForTimeout(150)
  await stillSelected()
  after = await controlValues()
  expect(after.grid).toBe(true)
  expect({ ...after, grid: before.grid }).toEqual(before)

  before = await controlValues()
  await page.locator(ctl('play-toggle')).click()
  await page.waitForTimeout(150)
  await stillSelected()
  after = await controlValues()
  expect(after.playing).toBe(true)
  expect({ ...after, playing: before.playing }).toEqual(before)
  await page.locator(ctl('play-toggle')).click()
})

/**
 * Grid is a pure overlay (paintCanvas's own doc comment): toggling it
 * repaints the SAME decoded pixels with lines on top, then the identical
 * pixels again with them removed - never a re-decode, never a residue.
 */
test('toggling grid draws an overlay and removes it cleanly', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const before = await readCanvas(page)
  await page.locator(ctl('grid-toggle')).click()
  await page.waitForTimeout(150)
  expect((await readCanvas(page)).checksum).not.toBe(before.checksum)

  await page.locator(ctl('grid-toggle')).click()
  await page.waitForTimeout(150)
  expect((await readCanvas(page)).checksum).toBe(before.checksum)
})

test('the tile browser strip collapses and expands', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const toggle = page.locator(ctl('browser-toggle'))
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator(`${FG} .hb-map16-canvas`)).toHaveCount(0)
  // The preview is still there with the strip put away.
  await expect(page.locator(`${FG} .hb-map16-preview-canvas`)).toHaveCount(1)

  await toggle.click()
  await expect(page.locator(`${FG} .hb-map16-canvas`)).toHaveCount(1)
})

/**
 * Play/stop: pressing play advances through DIFFERENT composited frames
 * over time (not just an icon flip), at the cart's own native interval, and
 * stopping leaves a stable frame rather than a canvas frozen mid-tick.
 */
test('play cycles the sheet through real animation frames; stop leaves it stable', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const playButton = page.locator(ctl('play-toggle'))
  await expect(playButton).toBeEnabled() // vanilla always has char animation
  await expect(playButton).toHaveAttribute('title', 'Play animation')

  const frame0 = await readCanvas(page)
  await playButton.click()
  await expect(playButton).toHaveAttribute('title', 'Stop animation')
  await expect(playButton).toHaveClass(/hb-icon-btn-on/)

  // Native interval is ~133ms on vanilla; poll rather than sleep a guess.
  await expect
    .poll(async () => (await readCanvas(page)).checksum, { timeout: 5000 })
    .not.toBe(frame0.checksum)

  await playButton.click()
  await expect(playButton).toHaveAttribute('title', 'Play animation')
  const stopped1 = await readCanvas(page)
  await page.waitForTimeout(400) // several native intervals' worth
  expect((await readCanvas(page)).checksum).toBe(stopped1.checksum)
})

/**
 * The preview shares the browser strip's decoded source (paintDetail crops
 * the same atlas), so proving it repaints for a different tile and tracks
 * the current phase while playing proves that shared path works.
 */
test('the preview follows the selection and the current animation phase', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const previewSel = `${FG} .hb-map16-preview-canvas`

  await clickTile(page, STATIC_TILE_ID)
  const size = await page.evaluate(sel => {
    const c = document.querySelector(sel)
    return { w: c.width, h: c.height }
  }, previewSel)
  expect(size.w).toBeGreaterThan(16) // scaled up, not native 16x16
  expect(size.h).toBe(size.w)
  const staticChecksum = await readCanvasChecksum(page, previewSel)

  await clickTile(page, ANIMATED_TILE_ID)
  const animatedChecksum = await readCanvasChecksum(page, previewSel)
  expect(animatedChecksum).not.toBe(staticChecksum)

  await page.locator(ctl('play-toggle')).click()
  await expect
    .poll(() => readCanvasChecksum(page, previewSel), { timeout: 5000 })
    .not.toBe(animatedChecksum)
  await page.locator(ctl('play-toggle')).click()
})

/** The RGBA bytes of one tile's 16x16 region of the strip. */
async function tilePixels(page, tileId) {
  const { x, y } = tileOrigin(tileId)
  return page.evaluate(
    ({ x, y, tilePx, sel }) => {
      const canvas = document.querySelector(`${sel} .hb-map16-canvas`)
      return Array.from(canvas.getContext('2d').getImageData(x, y, tilePx, tilePx).data)
    },
    { x, y, tilePx: TILE_PX, sel: FG },
  )
}

/**
 * `selector`'s resolved text color, a plain `.hb-map16-note`'s color for
 * comparison, and the WCAG contrast ratio against the element's effective
 * (nearest non-transparent ancestor) background.
 */
async function errorContrast(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel)
    const probe = document.createElement('span')
    probe.className = 'hb-map16-note'
    el.parentElement.appendChild(probe)
    const noteColor = getComputedStyle(probe).color
    probe.remove()
    const color = getComputedStyle(el).color
    let bgNode = el
    let bgColor = 'rgba(0, 0, 0, 0)'
    while (bgNode) {
      bgColor = getComputedStyle(bgNode).backgroundColor
      if (!/^(rgba\(0, ?0, ?0, ?0\)|transparent)$/.test(bgColor)) break
      bgNode = bgNode.parentElement
    }
    const parse = s =>
      s
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
    const luminance = ([r, g, b]) =>
      [r, g, b]
        .map(c => c / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0)
    const [l1, l2] = [luminance(parse(color)), luminance(parse(bgColor))]
    const [lighter, darker] = l1 > l2 ? [l1, l2] : [l2, l1]
    return { color, noteColor, ratio: (lighter + 0.05) / (darker + 0.05) }
  }, selector)
}

/**
 * A ROM whose level JSL at $00A2A5 no longer reaches CODE_05BB39 still has
 * real stock animation data, so the view composites it (unverified) and
 * shows a visible error, instead of blanking those characters. Built from
 * vanilla so it runs without the hacks.
 */
test('a ROM that skips its own animation code still shows stock frames, with a visible error', async ({
  page,
}) => {
  const QUESTION_BLOCK = 0x11f // all four quadrants cite $060-$063
  const patched = path.join(tmp, 'own-anim.sfc')
  const buf = fs.readFileSync(ROM)
  const base = buf.length % 1024 === COPIER_HEADER ? COPIER_HEADER : 0
  expect([...buf.subarray(base + 0x22a5, base + 0x22a9)]).toEqual([0x22, 0x39, 0xbb, 0x05])
  buf.set([0x22, 0x77, 0xac, 0x13], base + 0x22a5)
  fs.writeFileSync(patched, buf)

  await loadGfxExplorer(page, path.join(tmp, 'Stock'))
  await openMap16(page, 'fg')
  await expect(page.locator(`${FG} [data-note="animation"]`)).toHaveCount(0)
  const stockBlock = await tilePixels(page, QUESTION_BLOCK)
  const stockStatic = await tilePixels(page, STATIC_TILE_ID)
  await closeMap16Views(page)

  await loadGfxExplorer(page, path.join(tmp, 'OwnAnim'), patched)
  await openMap16(page, 'fg')
  const error = page.locator(`${FG} [data-note="animation"]`)
  await expect(error).toBeVisible()
  const errorText = await error.textContent()
  expect(errorText).toContain("couldn't be loaded")
  expect(errorText).toContain('$13AC77')
  expect(errorText).not.toMatch(CART)
  await expect(page.locator(ctl('play-toggle'))).toBeDisabled()

  const contrast = await errorContrast(page, `${FG} [data-note="animation"]`)
  expect(contrast.color).not.toBe(contrast.noteColor)
  expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)

  // Composited from the same stock data the routine would have used, matching the Stock ROM's own frame 0 pixel for pixel.
  expect(await tilePixels(page, QUESTION_BLOCK)).toEqual(stockBlock)
  expect(await tilePixels(page, STATIC_TILE_ID)).toEqual(stockStatic)
})

/**
 * A ROM whose level GFX call goes through Lunar Magic's ExGFX hook picks files
 * per level from a list this view does not read, so the sheet is drawn from
 * the stock assignment and marked. Needs the GPW2 corpus ROM.
 */
test('a ROM that picks GFX per level is drawn and marked; a stock ROM is not marked', async ({
  page,
}) => {
  test.skip(!fs.existsSync(romPath(GPW2)), 'needs the GPW2 corpus ROM')
  await loadGfxExplorer(page, path.join(tmp, 'StockMark'))
  await openMap16(page, 'fg')
  await expect(page.locator(`${FG} [data-note="gfx-assignment"]`)).toHaveCount(0)
  await closeMap16Views(page)

  await loadGfxExplorer(page, path.join(tmp, 'HookMark'), romPath(GPW2))
  await openMap16(page, 'fg')
  const note = page.locator(`${FG} [data-note="gfx-assignment"]`)
  await expect(note).toBeVisible()
  expect(await note.textContent()).toContain("Lunar Magic's list")
  expect(await note.textContent()).not.toMatch(CART)
  const contrast = await errorContrast(page, `${FG} [data-note="gfx-assignment"]`)
  expect(contrast.ratio).toBeGreaterThanOrEqual(4.5)
  // Drawn, not blanked: the static tile has opaque pixels.
  const pixels = await tilePixels(page, STATIC_TILE_ID)
  expect(pixels.some((v, i) => i % 4 === 3 && v > 0)).toBe(true)
})

test('the Map16 view speaks of ROMs, never cartridges', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'Words'))
  await openMap16(page)
  const words = await shownWords(page, '.hb-map16-body')
  expect(words).toMatch(/Tileset/)
  expect(words).not.toMatch(CART)
})

/**
 * #574: the tile inspector shows one toggle per switch (blue/silver
 * P-switch, ON/OFF) that changes the SELECTED tile's own art. Ids confirmed on
 * the real ROM by Map16Switches.corpus.test.ts, tileset 0: $02B follows blue
 * and is not hidden; $025 no switch touches.
 */
const BLUE_SWITCH_TILE_ID = 0x02b
const NO_SWITCH_TILE_ID = 0x025
const SILVER_SWITCH_TILE_ID = 0x12f
const ONOFF_SWITCH_TILE_ID = 0x112
const HIDDEN_TILE_ID = 0x027
/** SNES $01:A1B0 under LoROM is file offset $A1B0: the CMP #$3E PSwitchButtonArt.ts gates on. */
const PSWITCH_DISPATCH_FILE_OFFSET = 0xa1b0

const switchToggle = kind => `${FG} [data-control="switch-toggle"][data-switch="${kind}"]`

/** A copy of the ROM whose sprite-stun dispatch no longer compares sprite $3E. */
function romWithoutPSwitchArt(name) {
  const patched = path.join(tmp, name)
  const buf = fs.readFileSync(ROM)
  const base = buf.length % 1024 === COPIER_HEADER ? COPIER_HEADER : 0
  expect(buf[base + PSWITCH_DISPATCH_FILE_OFFSET]).toBe(0xc9) // CMP #imm, the opcode gated on
  buf[base + PSWITCH_DISPATCH_FILE_OFFSET] = 0xea
  fs.writeFileSync(patched, buf)
  return patched
}

test('selecting a switched tile shows its toggle beside the preview, and flipping it repaints both', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'SwitchToggle'))
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)

  const toggle = page.locator(switchToggle('blue'))
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-label', 'Blue P-switch')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // Only the one switch this tile actually has - never every switch kind.
  await expect(page.locator(`${FG} [data-control="switch-toggle"]`)).toHaveCount(1)

  // Visible without scrolling in the default layout: inside .hb-map16-main's viewport.
  const main = page.locator(`${FG} .hb-map16-main`)
  expect(await main.evaluate(el => el.scrollTop)).toBe(0)
  const mainBox = await main.boundingBox()
  const firstBox = await toggle.boundingBox()
  expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(mainBox.y + mainBox.height)

  const previewSel = `${FG} .hb-map16-preview-canvas`
  const buttonSel = `${switchToggle('blue')} canvas`
  await toggle.scrollIntoViewIfNeeded()
  const boxBefore = await toggle.boundingBox()
  const previewOff = await readCanvasChecksum(page, previewSel)
  const buttonOff = await readCanvasChecksum(page, buttonSel)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await readCanvasChecksum(page, previewSel)).not.toBe(previewOff)
  expect(await readCanvasChecksum(page, buttonSel)).not.toBe(buttonOff)
  expect(await toggle.boundingBox()).toEqual(boxBefore)

  // Flipping back restores the earlier pixels: a toggle is view state, not an edit.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await readCanvasChecksum(page, previewSel)).toBe(previewOff)
})

/**
 * The pressed P-switch keeps the ROM's own +8 Y offset, so it sits on the
 * BOTTOM edge of its 16x16 frame: its top half stays transparent.
 */
test("the P-switch button's pressed picture sits on the bottom edge, never centered", async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'SwitchButtonSeat'))
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)

  const canvasSel = `${switchToggle('blue')} canvas`
  const readRows = async () =>
    page.evaluate(sel => {
      const c = document.querySelector(sel)
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const rowOpaque = []
      for (let y = 0; y < c.height; y++) {
        let opaque = false
        for (let x = 0; x < c.width && !opaque; x++) opaque = data[(y * c.width + x) * 4 + 3] > 0
        rowOpaque.push(opaque)
      }
      return rowOpaque
    }, canvasSel)

  const offRows = await readRows()
  await page.locator(switchToggle('blue')).click()
  const onRows = await readRows()

  const half = onRows.length / 2
  expect(onRows.slice(0, half).some(Boolean)).toBe(false)
  expect(onRows.slice(half).some(Boolean)).toBe(true)
  expect(offRows[offRows.length - 1]).toBe(true)
  expect(onRows[onRows.length - 1]).toBe(true)
})

/**
 * A picture-less button falls back to its text label, with the reason in the
 * tooltip, in exactly the footprint of an image button (the ON/OFF one, whose
 * art this patch does not touch), and its label is not clipped.
 */
test('a P-switch button with no readable art falls back to its text label, same size as an image button', async ({
  page,
}) => {
  const patched = romWithoutPSwitchArt('no-pswitch-art.sfc')
  await loadGfxExplorer(page, path.join(tmp, 'NoPSwitchArt'), patched)
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)

  const toggle = page.locator(switchToggle('blue'))
  await expect(toggle).toBeVisible()
  await expect(toggle.locator('canvas')).toHaveCount(0)
  await expect(toggle).toHaveText('Blue P-switch')
  expect(await toggle.getAttribute('title')).toContain('CMP #$3E')
  const overflows = await toggle
    .locator('.hb-pixel-button-fallback')
    .evaluate(el => el.scrollWidth > el.clientWidth)
  expect(overflows).toBe(false)
  const fallbackBox = await toggle.boundingBox()

  await clickTile(page, ONOFF_SWITCH_TILE_ID)
  const imageButton = page.locator(switchToggle('onOff'))
  await expect(imageButton.locator('canvas')).toHaveCount(1)
  const imageBox = await imageButton.boundingBox()
  expect(fallbackBox.width).toBe(imageBox.width)
  expect(fallbackBox.height).toBe(imageBox.height)
})

test('selecting a tile no switch affects shows no switch toggle', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'NoSwitchToggle'))
  await openMap16(page, 'fg')
  await clickTile(page, NO_SWITCH_TILE_ID)

  await expect(page.locator(`${FG} [data-control="switch-toggle"]`)).toHaveCount(0)
  await expect(page.locator(`${FG} [data-note="switch-unavailable"]`)).toHaveCount(0)
})

test('switching the selected tile clears the previous toggle rather than carrying it over', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'SwitchReset'))
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)
  await page.locator(switchToggle('blue')).click()

  await clickTile(page, NO_SWITCH_TILE_ID)
  await expect(page.locator(`${FG} [data-control="switch-toggle"]`)).toHaveCount(0)

  await clickTile(page, BLUE_SWITCH_TILE_ID)
  await expect(page.locator(switchToggle('blue'))).toHaveAttribute('aria-pressed', 'false')
})

/**
 * A toggle left on must not outlive a reload that takes the switch away. Measured on
 * vanilla: $094 follows ON/OFF in tileset 2 and no switch in tileset 0.
 */
const TILESET_SWITCHED_TILE_ID = 0x094

test('a tileset change that takes a switch away drops its toggle state', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'SwitchTilesetReload'))
  await openMap16(page, 'fg')
  await page.selectOption(ctl('tileset-select'), '2')
  await clickTile(page, TILESET_SWITCHED_TILE_ID)

  const toggle = page.locator(switchToggle('onOff'))
  const previewSel = `${FG} .hb-map16-preview-canvas`
  const off = await readCanvasChecksum(page, previewSel)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  await page.selectOption(ctl('tileset-select'), '0')
  await expect(page.locator(`${FG} [data-control="switch-toggle"]`)).toHaveCount(0)
  await page.selectOption(ctl('tileset-select'), '2')

  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(await readCanvasChecksum(page, previewSel)).toBe(off)
})

for (const [kind, tileId] of [
  ['silver', SILVER_SWITCH_TILE_ID],
  ['onOff', ONOFF_SWITCH_TILE_ID],
]) {
  test(`the ${kind} switch button repaints when flipped`, async ({ page }) => {
    await loadGfxExplorer(page, path.join(tmp, `${kind}ButtonArt`))
    await openMap16(page, 'fg')
    await clickTile(page, tileId)

    const toggle = page.locator(switchToggle(kind))
    await expect(toggle).toBeVisible()
    const canvasSel = `${switchToggle(kind)} canvas`
    const before = await readCanvasChecksum(page, canvasSel)
    await toggle.click()
    expect(await readCanvasChecksum(page, canvasSel)).not.toBe(before)
  })
}

/** A drawn tile pixel's alpha matches the soft screen door: full where x + y is even, ~25% where odd. */
const expectScreenDoor = (alpha, x, y) => {
  if ((x + y) % 2 === 0) expect(alpha, `(${x}, ${y}) full`).toBe(255)
  else {
    expect(alpha, `(${x}, ${y}) dim`).toBeGreaterThanOrEqual(56) // 25% of 255 is ~64
    expect(alpha, `(${x}, ${y}) dim`).toBeLessThanOrEqual(72)
  }
}

/**
 * A hidden tile ($027, blank off-art but real on-art) draws its on-art in the
 * soft screen door while its toggle is off, rather than nothing, and solid once
 * on. Checked on pixel alpha at the center of every tile pixel.
 */
test('a hidden tile previews its on-art in the soft screen door while switched off', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'HiddenTilePreview'))
  await openMap16(page, 'fg')
  await clickTile(page, HIDDEN_TILE_ID)

  const previewSel = `${FG} .hb-map16-preview-canvas`
  // One alpha per tile pixel, sampled at its center on the scaled canvas.
  const readTileAlphas = () =>
    page.evaluate(
      ({ sel, n }) => {
        const c = document.querySelector(sel)
        const scale = c.width / n
        const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
        const out = []
        for (let y = 0; y < n; y++)
          for (let x = 0; x < n; x++) {
            const cx = Math.floor((x + 0.5) * scale)
            const cy = Math.floor((y + 0.5) * scale)
            out.push(data[(cy * c.width + cx) * 4 + 3])
          }
        return out
      },
      { sel: previewSel, n: TILE_PX },
    )

  const off = await readTileAlphas()
  await page.locator(switchToggle('blue')).click()
  const on = await readTileAlphas()

  const parities = new Set()
  for (let i = 0; i < off.length; i++) {
    if (on[i] === 0) {
      expect(off[i]).toBe(0)
      continue
    }
    const x = i % TILE_PX
    const y = Math.floor(i / TILE_PX)
    parities.add((x + y) % 2)
    expect(on[i]).toBe(255)
    expectScreenDoor(off[i], x, y)
  }
  // Both squares of the checkerboard, so a flat alpha at either strength fails.
  expect(parities.size).toBe(2)
})

// -- Layout: the preview column sits right of the tile grid (#623) -------

/**
 * Viewport boxes of the grid, its column, the preview column and what it
 * holds. `scroll` is the view's own scrollers, none of which may scroll
 * sideways; `strip` is the grid's strip, which may, when the grid is wider
 * than the column left for it.
 */
async function layoutOf(page, root = FG) {
  return page.evaluate(sel => {
    const rootEl = document.querySelector(sel)
    const q = s => rootEl.querySelector(s)
    const box = el => (el ? el.getBoundingClientRect().toJSON() : null)
    const scroller = el =>
      el && { top: el.scrollTop, left: el.scrollLeft, overflowX: el.scrollWidth - el.clientWidth }
    // The grid with its strip's scroll added back. A click on a tile outside
    // the strip's viewport scrolls the strip to it, which moves the canvas
    // rect by exactly the scroll while the layout stays put; measured raw,
    // that read as a 191px jump.
    const strip = q('.hb-map16-canvas-wrap')
    const grid = box(q('.hb-map16-canvas'))
    if (grid) {
      for (const k of ['x', 'left', 'right']) grid[k] += strip.scrollLeft
      for (const k of ['y', 'top', 'bottom']) grid[k] += strip.scrollTop
    }
    return {
      root: box(rootEl),
      grid,
      browser: box(q('.hb-map16-browser')),
      main: box(q('.hb-map16-main')),
      preview: box(q('.hb-map16-preview')),
      toggle: box(q('[data-control="switch-toggle"]')),
      editPane: box(q('.hb-map16-edit-pane')),
      palettes: box(q('.hb-map16-palettes')),
      scroll: {
        root: scroller(rootEl),
        body: scroller(q('.hb-map16-body')),
        panes: scroller(q('.hb-map16-panes')),
        main: scroller(q('.hb-map16-main')),
      },
      strip: scroller(strip),
    }
  }, root)
}

/** Whether `inner` lies wholly inside `outer`, to within a sub-pixel. */
function contains(outer, inner) {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.right <= outer.right + 0.5 &&
    inner.bottom <= outer.bottom + 0.5
  )
}

/** Right of the grid's column, starting in the same row band rather than below it. */
function besideGrid(l) {
  return l.preview.x >= l.browser.right && Math.abs(l.preview.y - l.grid.y) < l.preview.height
}

function expectNoSidewaysScroll(l) {
  for (const [name, s] of Object.entries(l.scroll)) {
    expect({ name, overflowX: s.overflowX }).toEqual({ name, overflowX: 0 })
  }
}

/** Applies a planted stylesheet for the length of `fn`, then removes it. */
async function withPlanted(page, css, fn) {
  const tag = await page.addStyleTag({ content: css })
  try {
    return await fn()
  } finally {
    await tag.evaluate(el => el.remove())
  }
}

/** The first cut of #623: the row wrapped, so a grid too wide to share it
 * pushed the preview column onto a second line, below a full-height grid. */
const PLANT_WRAP = `
  ${FG} .hb-map16-panes { flex-wrap: wrap; overflow-y: auto; }
  ${FG} .hb-map16-browser { max-width: 100%; max-height: 100%; }
  ${FG} .hb-map16-main { flex: 1 1 20em; min-width: 0; max-height: 100%; }`
/** develop before #623: the preview column stacked above the grid, here sized by its content. */
const PLANT_STACKED = `
  ${FG} .hb-map16-panes { flex-direction: column; }
  ${FG} .hb-map16-main { order: -1; flex: none; }`
/** The preview column LEFT of the grid, as wide as its content. */
const PLANT_CONTENT_LEFT = `${FG} .hb-map16-main { order: -1; flex: none; }`

test('the preview sits right of the tile grid, and a new selection moves no part of the grid', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'Layout'))
  await openMap16(page, 'fg')
  await clickTile(page, NO_SWITCH_TILE_ID)

  const first = await layoutOf(page)
  expect(first.toggle).toBeNull()
  expect(besideGrid(first)).toBe(true)

  const previewSel = `${FG} .hb-map16-preview-canvas`
  const pixelsBefore = await readCanvasChecksum(page, previewSel)
  await clickTile(page, BLUE_SWITCH_TILE_ID)
  const second = await layoutOf(page)
  // The right column really changed: new pixels, and a switch toggle it did not have.
  expect(await readCanvasChecksum(page, previewSel)).not.toBe(pixelsBefore)
  expect(second.toggle).not.toBeNull()
  // ...and the grid stayed exactly where it was.
  expect(second.grid).toEqual(first.grid)
  expect(second.browser).toEqual(first.browser)
  expect(besideGrid(second)).toBe(true)

  // Prove both checks can fail. A content-sized column beside the grid moves
  // it on the same two selections...
  await withPlanted(page, PLANT_CONTENT_LEFT, async () => {
    await clickTile(page, NO_SWITCH_TILE_ID)
    const before = (await layoutOf(page)).grid
    await clickTile(page, BLUE_SWITCH_TILE_ID)
    expect((await layoutOf(page)).grid, 'the planted layout must move the grid').not.toEqual(before)
  })
  // ...and the stacked layout develop drew is not beside the grid.
  await withPlanted(page, PLANT_STACKED, async () => {
    expect(besideGrid(await layoutOf(page)), 'a stacked layout must fail this check').toBe(false)
  })
  expect(await layoutOf(page)).toEqual(second)
})

test('at 1280x720 the grid, the preview and the switch toggles are all in view without scrolling', async ({
  page,
}) => {
  // Bound to the size the claim is about, rather than whatever the default is.
  await page.setViewportSize({ width: 1280, height: 720 })
  await loadGfxExplorer(page, path.join(tmp, 'LayoutDefault'))
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)

  const l = await layoutOf(page)
  expect(besideGrid(l)).toBe(true)
  expect(contains(l.root, l.preview)).toBe(true)
  expect(contains(l.root, l.toggle)).toBe(true)
  // The grid is taller than the view and scrolls inside its own strip, so
  // its full WIDTH and its top edge are what must be on screen. At this
  // size and the default zoom the strip does not scroll sideways either.
  expect(l.grid.right).toBeLessThanOrEqual(l.browser.right)
  expect(l.grid.y).toBeGreaterThanOrEqual(l.root.y)
  expect(l.grid.y).toBeLessThan(l.root.bottom)
  for (const [name, s] of Object.entries({ ...l.scroll, strip: l.strip })) {
    expect({ name, ...s }).toEqual({ name, top: 0, left: 0, overflowX: 0 })
  }

  // Prove the containment checks can fail: wrap the preview column onto its
  // own line and both it and the toggle leave the view.
  await withPlanted(page, `${PLANT_WRAP} ${FG} .hb-map16-main { flex-basis: 100%; }`, async () => {
    const p = await layoutOf(page)
    expect(contains(p.root, p.preview), 'a wrapped preview must read as out of view').toBe(false)
    expect(contains(p.root, p.toggle), 'a wrapped toggle must read as out of view').toBe(false)
  })
})

/**
 * Where the grid cannot share the row at its full width, the row still does
 * not wrap: the grid's column gives way and the grid strip scrolls sideways
 * inside it. That strip is the ONLY thing allowed to scroll sideways.
 */
for (const { name, width, zoomIns } of [
  { name: 'at 760x720', width: 760, zoomIns: 0 },
  { name: 'at 1280x720 zoomed to 3x', width: 1280, zoomIns: 1 },
  { name: 'at 1280x720 zoomed to 4x', width: 1280, zoomIns: 2 },
]) {
  test(`${name} the preview stays in view beside the grid column`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 })
    await loadGfxExplorer(page, path.join(tmp, 'LayoutTight'))
    await openMap16(page, 'fg')
    // Selected BEFORE zooming, since clickTile aims at the default zoom.
    await clickTile(page, BLUE_SWITCH_TILE_ID)
    for (let i = 0; i < zoomIns; i++) await page.locator(ctl('zoom-in')).click()
    await expect(page.locator(ctl('zoom-indicator'))).toHaveText(
      `${(DEFAULT_ZOOM + zoomIns) * 100}%`,
    )

    const l = await layoutOf(page)
    expect(contains(l.root, l.preview)).toBe(true)
    expect(contains(l.root, l.toggle)).toBe(true)
    expect(besideGrid(l)).toBe(true)
    expectNoSidewaysScroll(l)
    // Each size here is too tight for the grid at full width, and the strip
    // is where the difference goes: it scrolls sideways, the view does not.
    expect(l.strip.overflowX).toBeGreaterThan(0)

    // Prove it can fail: with the wrapping row, the preview lands below the grid, out of view.
    await withPlanted(page, PLANT_WRAP, async () => {
      const p = await layoutOf(page)
      expect(contains(p.root, p.preview), 'a wrapped preview must read as out of view').toBe(false)
    })
  })
}

test('collapsing the grid leaves a narrow bar, and expanding it restores the layout', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'LayoutCollapse'))
  await openMap16(page, 'fg')
  await clickTile(page, BLUE_SWITCH_TILE_ID)
  const expanded = await layoutOf(page)

  const toggle = page.locator(ctl('browser-toggle'))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  const collapsed = await layoutOf(page)
  expect(collapsed.browser.width).toBeLessThan(80)
  expect(collapsed.main.x - collapsed.root.x).toBeLessThan(80)
  expect(contains(collapsed.root, collapsed.preview)).toBe(true)

  // Prove it can fail: a collapsed column that keeps a floor width is no bar.
  await withPlanted(page, `${FG} .hb-map16-browser { min-width: 200px; }`, async () => {
    expect((await layoutOf(page)).browser.width).toBeGreaterThanOrEqual(80)
  })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(await layoutOf(page)).toEqual(expanded)
})

test('the edit pane and the character palettes open under the preview, in the right column', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'LayoutEdit'))
  await openMap16(page, 'fg')
  await clickTile(page, TARGET_TILE_ID)
  const closed = await layoutOf(page)

  await openEditPane(page)
  await expandSheet(page, 'fg3')
  const open = await layoutOf(page)

  expect(open.editPane.x).toBeGreaterThanOrEqual(open.browser.right)
  expect(open.editPane.y).toBeGreaterThanOrEqual(open.preview.bottom)
  expect(open.palettes.x).toBeGreaterThanOrEqual(open.browser.right)
  expect(open.palettes.y).toBeGreaterThanOrEqual(open.preview.bottom)
  // Opening them grows the right column only: the grid did not move.
  expect(open.grid).toEqual(closed.grid)
  expectNoSidewaysScroll(open)

  // Prove the grid check can fail: stacked under a content-sized preview
  // column, closing the edit pane moves the grid.
  await withPlanted(page, PLANT_STACKED, async () => {
    const withPane = (await layoutOf(page)).grid
    await page.locator(`${FG} .hb-map16-preview`).hover()
    await page.locator(ctl('edit-toggle')).click()
    await expect(page.locator(`${FG} .hb-map16-edit-pane`)).toHaveCount(0)
    expect((await layoutOf(page)).grid, 'the planted layout must move the grid').not.toEqual(
      withPane,
    )
  })
})

/**
 * #621: a hidden tile ($027, blank until the blue P-switch) shows in the SHEET
 * in the soft screen door, still or playing, so it can be found; a blank tile no
 * switch touches ($025) stays transparent. Interior pixels only, and the
 * pointer kept off the sheet, so neither the grid nor the hover outline counts.
 */
test('hidden tiles show in the sheet in the soft screen door, playing or not; a blank tile stays blank', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'HiddenInSheet'))
  await openMap16(page, 'fg')
  await page.locator(`${FG} .hb-map16-browser-head`).hover()

  const interiorAlphas = px => {
    const alphas = []
    for (let y = 1; y < TILE_PX - 1; y++)
      for (let x = 1; x < TILE_PX - 1; x++) alphas.push({ x, y, a: px[(y * TILE_PX + x) * 4 + 3] })
    return alphas
  }
  const expectCells = async () => {
    const drawn = interiorAlphas(await tilePixels(page, HIDDEN_TILE_ID)).filter(p => p.a > 0)
    // Both squares of the checkerboard, so a flat alpha at either strength fails.
    expect(drawn.some(p => (p.x + p.y) % 2 === 0)).toBe(true)
    expect(drawn.some(p => (p.x + p.y) % 2 === 1)).toBe(true)
    for (const p of drawn) expectScreenDoor(p.a, p.x, p.y)
    expect(interiorAlphas(await tilePixels(page, NO_SWITCH_TILE_ID)).every(p => p.a === 0)).toBe(
      true,
    )
  }

  await expectCells()
  await page.locator(ctl('play-toggle')).click()
  await expect(page.locator(ctl('play-toggle'))).toHaveAttribute('aria-pressed', 'true')
  // Across more than one full 4-frame cycle (~133ms a frame): no phase drops the overlay,
  // and the animated $000 proves the phase really advanced between samples.
  const phases = new Set()
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(100)
    await expectCells()
    phases.add((await tilePixels(page, ANIMATED_TILE_ID)).join(','))
  }
  expect(phases.size).toBeGreaterThan(1)
})

test("turning an inspector switch on leaves the hidden tile's sheet cell unchanged", async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'HiddenSheetToggle'))
  await openMap16(page, 'fg')
  await clickTile(page, HIDDEN_TILE_ID)
  await page.locator(`${FG} .hb-map16-browser-head`).hover()
  const before = await tilePixels(page, HIDDEN_TILE_ID)

  const toggle = page.locator(switchToggle('blue'))
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.locator(`${FG} .hb-map16-browser-head`).hover()
  expect(await tilePixels(page, HIDDEN_TILE_ID)).toEqual(before)
})

/**
 * Ctrl + wheel over an on-screen zoom control (#651): it steps the SAME
 * indicator/canvas the toolbar buttons drive, it clamps exactly where the
 * buttons clamp, keeps the same canvas pixel under the cursor, is cancelled
 * everywhere in the shell (not just over a zoom control), and PLAIN wheel
 * is left doing what it always did (scrolling the strip).
 *
 * `page.mouse.wheel` dispatches a real `wheel` event with `ctrlKey` set
 * from whatever modifier keys are currently held, so `keyboard.down/up`
 * around it is what makes this Ctrl + wheel rather than a plain scroll -
 * exactly the distinction `ZoomController.bindWheel` gates on. The "never
 * page-zooms" case cannot be proven that way, though: a synthetic CDP wheel
 * does not drive Chromium's real page-zoom feature, so that assertion would
 * stay green even with no guard at all - see `assertCancelled` below, which
 * checks `defaultPrevented` on a dispatched event instead.
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
 * rather than re-measuring `locator`'s CURRENT box. An anchoring check needs
 * this: `.hb-map16-canvas-wrap`'s own page position can shift a few px
 * between one render and the next (unrelated to scroll or zoom), so
 * re-deriving the point from a fresh boundingBox() after that shift wheels
 * at a DIFFERENT point than the one the content-coordinate check compares
 * against - not a defect in the widget, a mismatch in the test. */
async function ctrlWheelAt(page, clientX, clientY, deltaY) {
  await page.mouse.move(clientX, clientY)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, deltaY)
  await page.keyboard.up('Control')
  await afterWheel(page)
}

/** Dispatches one wheel event on `selector` and returns whether it was
 * cancelled - the CtrlWheelGuardContribution/ZoomController contract. */
async function dispatchWheel(page, selector, ctrlKey) {
  return page.evaluate(
    ({ selector, ctrlKey }) => {
      const el = document.querySelector(selector)
      const e = new WheelEvent('wheel', { ctrlKey, cancelable: true, bubbles: true, deltaY: -100 })
      el.dispatchEvent(e)
      return e.defaultPrevented
    },
    { selector, ctrlKey },
  )
}

/** The client-space point's CONTENT coordinate on the Map16 strip, computed
 * from the canvas's own rendered box - not the wrap's padded one. */
async function map16ContentPointAt(page, canvasSel, clientX, clientY) {
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

test('Ctrl + wheel over the Map16 strip steps the zoom indicator and the canvas size', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  const wrap = page.locator(`${FG} .hb-map16-canvas-wrap`)
  const canvas = page.locator(`${FG} .hb-map16-canvas`)
  const widthBefore = await canvas.evaluate(el => el.getBoundingClientRect().width)
  expect(await page.locator(ctl('zoom-indicator')).textContent()).toBe(`${DEFAULT_ZOOM * 100}%`)

  // One notch (~100px of accumulated delta) is one step, same as one click
  // of the zoom-in button.
  await ctrlWheel(page, wrap, -120)

  await expect(page.locator(ctl('zoom-indicator'))).toHaveText(`${(DEFAULT_ZOOM + 1) * 100}%`)
  await expect
    .poll(() => canvas.evaluate(el => el.getBoundingClientRect().width))
    .toBeGreaterThan(widthBefore)
})

test('Ctrl + wheel clamps at the same limits as the zoom buttons', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  const wrap = page.locator(`${FG} .hb-map16-canvas-wrap`)

  // Zoom in far past the 4x ceiling with one big scroll.
  await ctrlWheel(page, wrap, -1000)
  await expect(page.locator(ctl('zoom-indicator'))).toHaveText('400%')
  await expect(page.locator(ctl('zoom-in'))).toBeDisabled()

  // And back down past the 1x floor.
  await ctrlWheel(page, wrap, 2000)
  await expect(page.locator(ctl('zoom-indicator'))).toHaveText('100%')
  await expect(page.locator(ctl('zoom-out'))).toBeDisabled()
})

/**
 * `.hb-map16-browser` sizes itself to its content (`flex: 0 1 auto`), so it
 * widens as the canvas widens with zoom, which can shift
 * `.hb-map16-canvas-wrap`'s own page position for reasons that have
 * nothing to do with the zoom step itself - measured against the tile
 * browser's header note before its removal (#651). `restoreAnchor()`
 * re-reads the canvas's box AFTER any such reflow rather than trusting
 * anything measured at wheel time (see zoom-controller.ts), so this spec
 * runs the real layout with no plant needed to suppress a reflow.
 */
test('Ctrl + wheel keeps the same canvas pixel under the cursor, in and out, within 1px', async ({
  page,
}) => {
  // Narrow enough that the strip overflows horizontally too at the default zoom.
  await page.setViewportSize({ width: 760, height: 720 })
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  const wrap = page.locator(`${FG} .hb-map16-canvas-wrap`)
  const canvasSel = `${FG} .hb-map16-canvas`

  // Scroll BOTH axes first - the padding/scroll offset this guards against
  // is invisible at (0, 0). A SMALL scroll plus a point near the wrap's
  // own corner, not its center: keeping the cursor's CONTENT coordinate
  // small keeps the scroll shift a step needs small too, well inside
  // whatever overflow this browser strip happens to have - a point at the
  // wrap's center over a wide sheet needed a shift bigger than the
  // horizontal overflow that zoom level actually had, which scroll-based
  // anchoring cannot exceed regardless of how correct the math is.
  await wrap.evaluate(el => {
    el.scrollLeft = 20
    el.scrollTop = 15
  })
  // Both offsets must have taken, or this is the unscrolled case in disguise.
  expect(await wrap.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual([20, 15])
  const box = await wrap.boundingBox()
  const clientX = box.x + 30
  const clientY = box.y + 30

  const before = await map16ContentPointAt(page, canvasSel, clientX, clientY)

  // ctrlWheelAt, not ctrlWheel(page, wrap, ...): re-deriving the wheel
  // point from a fresh boundingBox() after the widget re-renders could
  // wheel at a different point than clientX/clientY, which is what the
  // content-coordinate check below actually compares against.
  const zoomBefore = await canvasZoom(page, canvasSel)
  await ctrlWheelAt(page, clientX, clientY, -120) // one step in
  await expect.poll(() => canvasZoom(page, canvasSel)).toBeGreaterThan(zoomBefore)
  await afterWheel(page)
  const afterIn = await map16ContentPointAt(page, canvasSel, clientX, clientY)
  expect(Math.abs(afterIn.x - before.x)).toBeLessThan(1)
  expect(Math.abs(afterIn.y - before.y)).toBeLessThan(1)

  await ctrlWheelAt(page, clientX, clientY, 120) // one step back out
  await expect.poll(() => canvasZoom(page, canvasSel)).toBe(zoomBefore)
  await afterWheel(page)
  const afterOut = await map16ContentPointAt(page, canvasSel, clientX, clientY)
  expect(Math.abs(afterOut.x - before.x)).toBeLessThan(1)
  expect(Math.abs(afterOut.y - before.y)).toBeLessThan(1)
})

test('Ctrl + wheel is cancelled everywhere in the shell, not only over a zoom control', async ({
  page,
}) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')

  expect(await dispatchWheel(page, `${FG} .hb-map16-canvas-wrap`, true)).toBe(true)
  expect(await dispatchWheel(page, '#hackbench\\.gfx-explorer', true)).toBe(true)
  expect(await dispatchWheel(page, 'body', true)).toBe(true)

  // A plain wheel is untouched, on the sheet and off it alike.
  expect(await dispatchWheel(page, `${FG} .hb-map16-canvas-wrap`, false)).toBe(false)
  expect(await dispatchWheel(page, 'body', false)).toBe(false)
})

test('plain wheel still scrolls the Map16 strip and does not touch zoom', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'fg')
  const wrap = page.locator(`${FG} .hb-map16-canvas-wrap`)

  const scrollBefore = await wrap.evaluate(el => el.scrollTop)
  const box = await wrap.boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 400) // no Control held
  await page.waitForTimeout(200)

  const scrollAfter = await wrap.evaluate(el => el.scrollTop)
  expect(scrollAfter).toBeGreaterThan(scrollBefore)
  expect(await page.locator(ctl('zoom-indicator')).textContent()).toBe(`${DEFAULT_ZOOM * 100}%`)
})

test('a Map16 view waiting on a missing ROM repaints after Project Properties relocates it (#527)', async ({
  page,
}) => {
  // The project's only registered copy is deleted right after createProject
  // and before anything calls workingRoms.get (a cache hit never re-reads the
  // file), so the view opens in rom-not-located. The view is opened directly:
  // explorer rows do not exist while the ROM is missing.
  const gone = path.join(tmp, 'gone.sfc')
  fs.copyFileSync(ROM, gone)
  const project = await createProject(page, path.join(tmp, 'Revive'), 'Revive', gone)
  fs.rmSync(gone)
  await page.evaluate(async manifestPath => {
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map16-view', {
      layer: 'fg',
    })
    await w.open({ manifestPath, label: 'Map16 Foreground', layer: 'fg' })
    await getSvc('ApplicationShell').addWidget(w, { area: 'main' })
    await getSvc('ApplicationShell').activateWidget(w.id)
  }, project.manifestPath)
  await expect(page.locator(`${FG} .hb-map16-empty`)).toContainText('Locate')

  const moved = path.join(tmp, 'moved.sfc')
  fs.copyFileSync(ROM, moved)
  await page.evaluate(
    async ({ p, moved }) => {
      getSvc('ProjectContext').current = p
      const dlg = getSvc('ProjectPropertiesDialog')
      dlg.fileDialog.showOpenDialog = async () => ({ path: { fsPath: () => moved } })
      void getSvc('CommandRegistry').executeCommand('hackbench.project.properties')
    },
    { p: project, moved },
  )
  await page.waitForSelector('.hb-dialog-facts', { timeout: 15000 })
  await page.locator('.dialogBlock button:has-text("Browse...")').first().click()
  await expect
    .poll(() => page.locator('.dialogBlock input[readonly]').first().inputValue())
    .toBe(moved)
  await page.locator('.dialogBlock .theia-button.main').click()
  await page.waitForSelector(`${FG} .hb-map16-preview-canvas`, { timeout: 15000 })
})

/**
 * #573 (replaces #570's inside outline): hovering a strip tile shows a DOM
 * overlay OUTSIDE the tile, white line touching it and black line outside
 * that, 1 screen pixel each at every zoom, and never touches the bitmap.
 * Geometry is read from the overlay against the tile's on-screen rect; the
 * bitmap is read from canvas data. Corner tiles prove the outline is not
 * clipped at the sheet edge.
 */
test('hovering a tile shows a two-tone overlay outside it and leaves the canvas bitmap untouched', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla corpus ROM')
  await loadGfxExplorer(page, path.join(tmp, 'HoverOutline'))
  await openMap16(page, 'fg')
  const canvas = page.locator(`${FG} .hb-map16-canvas`)
  const overlay = page.locator(`${FG} .hb-map16-hover-outline`)
  const bitmap = () =>
    canvas.evaluate(c => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data))
  const unhover = async () => {
    await page.locator(`${FG} .hb-map16-browser-head`).hover()
    await page.waitForTimeout(100)
  }
  const SELECTED = 0x30
  await clickTile(page, SELECTED) // so the selection highlight is on screen
  await unhover()
  await expect(overlay).toBeHidden()

  for (const zoomIns of [-1, 3]) {
    const step = ctl(zoomIns < 0 ? 'zoom-out' : 'zoom-in')
    for (let i = 0; i < Math.abs(zoomIns); i++) await page.locator(step).click()
    const zoom = zoomIns < 0 ? 1 : 4
    await expect(page.locator(ctl('zoom-indicator'))).toHaveText(`${zoom * 100}%`)
    await unhover()
    const base = await bitmap()

    // Corners, an interior tile, and the tile next to the selection.
    for (const id of [0, TILES_PER_ROW - 1, 0x55, SELECTED + 1, 511 - (TILES_PER_ROW - 1), 511]) {
      const { x, y } = tileOrigin(id)
      await canvas.hover({ position: { x: (x + TILE_PX / 2) * zoom, y: (y + TILE_PX / 2) * zoom } })
      await expect(overlay).toBeVisible()
      const g = await page.evaluate(
        ({ sel, x, y, zoom, tilePx }) => {
          const c = document.querySelector(`${sel} .hb-map16-canvas`)
          const o = document.querySelector(`${sel} .hb-map16-hover-outline`)
          // The strip's whole scrollable content, not just the part in view.
          const w = c.parentElement
          const wr = w.getBoundingClientRect()
          const wrap = {
            left: wr.left - w.scrollLeft,
            top: wr.top - w.scrollTop,
            right: wr.left - w.scrollLeft + w.scrollWidth,
            bottom: wr.top - w.scrollTop + w.scrollHeight,
          }
          const cr = c.getBoundingClientRect()
          const or = o.getBoundingClientRect()
          const st = getComputedStyle(o)
          return {
            tile: { l: cr.left + x * zoom, t: cr.top + y * zoom, s: tilePx * zoom },
            o: { l: or.left, t: or.top, w: or.width, h: or.height },
            wrap: { l: wrap.left, t: wrap.top, r: wrap.right, b: wrap.bottom },
            border: [st.borderTopWidth, st.borderTopColor, st.borderLeftWidth],
            shadow: st.boxShadow,
          }
        },
        { sel: FG, x, y, zoom, tilePx: TILE_PX },
      )
      const near = (a, b, what) =>
        expect(Math.abs(a - b), `${what} (tile ${id}, ${zoom}x)`).toBeLessThanOrEqual(0.6)
      // Black line 2px out, white line 1px out: the box is the tile grown by 2 each side.
      near(g.o.l, g.tile.l - 2, 'left edge')
      near(g.o.t, g.tile.t - 2, 'top edge')
      near(g.o.w, g.tile.s + 4, 'width')
      near(g.o.h, g.tile.s + 4, 'height')
      expect(g.border).toEqual(['1px', 'rgb(0, 0, 0)', '1px'])
      expect(g.shadow).toMatch(/rgb\(255, 255, 255\) 0px 0px 0px 1px inset/)
      // Not clipped by the strip's scroll box at the sheet edge.
      expect(g.o.l).toBeGreaterThanOrEqual(g.wrap.l - 0.6)
      expect(g.o.t).toBeGreaterThanOrEqual(g.wrap.t - 0.6)
      expect(g.o.l + g.o.w).toBeLessThanOrEqual(g.wrap.r + 0.6)
      expect(g.o.t + g.o.h).toBeLessThanOrEqual(g.wrap.b + 0.6)
      expect(await bitmap(), `hover on tile ${id} changed the bitmap`).toEqual(base)
    }
    await unhover()
    await expect(overlay).toBeHidden()
    expect(await bitmap()).toEqual(base)
  }
})

/**
 * #573: the selection is an overlay too, never in the bitmap. Style A4 from
 * the tile outward: 1px black, 2px #4fc1ff, 1px black, so the box is the tile
 * grown by 4. Hovering a neighbor leaves both visible with the selection
 * above; hovering the selected tile itself shows only the selection.
 */
test('the selection is a 1px black, 2px blue, 1px black overlay outside the tile, above any hover, and not in the bitmap', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla corpus ROM')
  await loadGfxExplorer(page, path.join(tmp, 'SelectionOverlay'))
  await openMap16(page, 'fg')
  const canvas = page.locator(`${FG} .hb-map16-canvas`)
  const sel = page.locator(`${FG} .hb-map16-selection-outline`)
  const hov = page.locator(`${FG} .hb-map16-hover-outline`)
  const bitmap = () =>
    canvas.evaluate(c => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data))
  const unhover = async () => {
    await page.locator(`${FG} .hb-map16-browser-head`).hover()
    await page.waitForTimeout(100)
  }
  const at = (id, zoom) => {
    const { x, y } = tileOrigin(id)
    return { position: { x: (x + TILE_PX / 2) * zoom, y: (y + TILE_PX / 2) * zoom } }
  }
  const box = (locator, tileId, zoom) =>
    page.evaluate(
      ({ selector, x, y, zoom, tilePx }) => {
        const c = document.querySelector('[id="hackbench.map16-view:fg"] .hb-map16-canvas')
        const o = document.querySelector(selector)
        const w = c.parentElement
        const wr = w.getBoundingClientRect()
        const cr = c.getBoundingClientRect()
        const or = o.getBoundingClientRect()
        const st = getComputedStyle(o)
        return {
          dl: or.left - (cr.left + x * zoom),
          dt: or.top - (cr.top + y * zoom),
          w: or.width - tilePx * zoom,
          h: or.height - tilePx * zoom,
          inScroll:
            or.left >= wr.left - w.scrollLeft - 0.6 &&
            or.top >= wr.top - w.scrollTop - 0.6 &&
            or.right <= wr.left - w.scrollLeft + w.scrollWidth + 0.6 &&
            or.bottom <= wr.top - w.scrollTop + w.scrollHeight + 0.6,
          border: [st.borderTopWidth, st.borderTopColor],
          shadow: st.boxShadow,
        }
      },
      { selector: locator, ...tileOrigin(tileId), zoom, tilePx: TILE_PX },
    )
  const near = (a, b, what) => expect(Math.abs(a - b), what).toBeLessThanOrEqual(0.6)

  let reference
  for (const zoomIns of [-1, 3]) {
    const step = ctl(zoomIns < 0 ? 'zoom-out' : 'zoom-in')
    for (let i = 0; i < Math.abs(zoomIns); i++) await page.locator(step).click()
    const zoom = zoomIns < 0 ? 1 : 4
    await expect(page.locator(ctl('zoom-indicator'))).toHaveText(`${zoom * 100}%`)

    for (const id of [0x30, 0, 511]) {
      await canvas.click(at(id, zoom))
      await unhover()
      await expect(sel).toBeVisible()
      const g = await box('.hb-map16-selection-outline', id, zoom)
      const what = `selected ${id} at ${zoom}x`
      near(g.dl, -4, `${what} left`)
      near(g.dt, -4, `${what} top`)
      near(g.w, 8, `${what} width`)
      near(g.h, 8, `${what} height`)
      expect(g.border, what).toEqual(['1px', 'rgb(0, 0, 0)'])
      // Blue 2px over the inner black 1px, innermost first.
      expect(g.shadow, what).toMatch(
        /rgb\(79, 193, 255\) 0px 0px 0px 2px inset.*rgb\(0, 0, 0\) 0px 0px 0px 3px inset/,
      )
      expect(g.inScroll, `${what} clipped`).toBe(true)
      // The bitmap holds no selection: every selection and zoom reads the same.
      const px = await bitmap()
      reference ??= px
      expect(px, `${what} changed the bitmap`).toEqual(reference)
    }

    // Selected = 0x30. A neighbor's hover and the selection both show, the
    // selection later in the DOM so it draws above.
    await canvas.click(at(0x30, zoom))
    await canvas.hover(at(0x31, zoom))
    await expect(hov).toBeVisible()
    await expect(sel).toBeVisible()
    expect(
      await sel.evaluate(
        (s, h) => Boolean(h.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING),
        await hov.elementHandle(),
      ),
    ).toBe(true)
    // Hovering the selected tile itself: only the selection.
    await canvas.hover(at(0x30, zoom))
    await expect(sel).toBeVisible()
    await expect(hov).toBeHidden()
    expect(await bitmap()).toEqual(reference)
  }
})
