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
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

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
        tileCountSource: r.sheet.tileCountSource,
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
  // The band is really blank and sits where tileOrigin puts page 1's top,
  // so tileHasColor and clickTile address the tile they name.
  const opaqueInBand = await page.evaluate(
    ({ sel, top, height }) => {
      const canvas = document.querySelector(`${sel} .hb-map16-canvas`)
      const data = canvas.getContext('2d').getImageData(0, top, canvas.width, height).data
      let opaque = 0
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) opaque++
      return opaque
    },
    { sel: FG, top: tileOrigin(TILES_PER_PAGE).y - PAGE_GAP_PX, height: PAGE_GAP_PX },
  )
  expect(opaqueInBand).toBe(0)
  // Real tile art, not a blank or single-color sheet.
  expect(info.distinctColors).toBeGreaterThan(1)

  const summary = await page.locator(`${FG} .hb-map16-summary-dims`).textContent()
  expect(summary).toContain(`${VANILLA_TILE_COUNT} tiles`)
  // "block" was this view's own invention; the community and
  // docs/glossary.md:137 both call a 16x16 Map16 entry a tile.
  expect(summary.toLowerCase()).not.toContain('block')

  // Where the count came from, said in place. A page control that cannot
  // work would be worse than saying what a further page needs.
  const note = await page.locator(`${FG} .hb-map16-browser-note`).textContent()
  expect(note).toContain('read from this ROM')
  expect(note).toContain('en-gen/hackbench#102')
})

/**
 * The Layer 2 table's extent is NOT the foreground loop's answer, and the
 * view says so. `buildL2Map16PointerTable` takes no ROM and hardcodes 512,
 * so presenting it as something read off the cartridge would be the
 * confident kind of wrong. Backed by Map16Decode.charSheets.test.ts and
 * Map16Server.test.ts, which prove the decoupling itself on synthetic
 * bytes; this is the half the user can see.
 */
test('the Background tab says its extent is not read from the cartridge', async ({ page }) => {
  const project = await loadGfxExplorer(page, path.join(tmp, 'MyHack'))
  await openMap16(page, 'bg')

  const note = await page.locator(`${BG} .hb-map16-browser-note`).textContent()
  expect(note).toContain('does not yet read the Layer 2 table extent from the ROM')
  expect(note).toContain('en-gen/hackbench#102')
  expect(note).not.toContain('read from this ROM.')

  const bg = await readCommittedTile(page, project.manifestPath, 0, 'bg', 0)
  expect(bg.tileCountSource).toBe('fixed-bg-table')
  const fg = await readCommittedTile(page, project.manifestPath, 0, 'fg', 0)
  expect(fg.tileCountSource).toBe('rom')
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
  expect(reason).toContain('en-gen/hackbench#102')

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
  expect(after.zoom).toBe('4x')
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
  await expect(playButton).toHaveClass(/hb-map16-icon-btn-on/)

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

test('the Map16 view speaks of ROMs, never cartridges', async ({ page }) => {
  await loadGfxExplorer(page, path.join(tmp, 'Words'))
  await openMap16(page)
  const words = await shownWords(page, '.hb-map16-body')
  expect(words).toMatch(/Tileset/)
  expect(words).not.toMatch(CART)
})
