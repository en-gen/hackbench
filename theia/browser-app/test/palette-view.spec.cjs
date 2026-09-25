/**
 * The palette explorer and its group/variant tabs, end to end against the shell.
 *
 * Palettes lives in the left activity bar as a tree of the six stock groups
 * (`hackbench.palette-explorer`); a row opens a main-area tab
 * (`PaletteGroupViewWidget`, id `hackbench.palette-group-view:<groupId>[:<variant>]`)
 * showing the STOCK ROM TABLES loadRomPalettes() and PaletteStockTables.ts
 * read, not the composed runtime CGRAM a level or the overworld actually
 * loads. Theia's main-area tab bar does not render `title.iconClass` into
 * the tab's icon element (verified against Maps' own already-shipped
 * main-area widget), so the icon test checks the title's class rather than
 * the rendered tab.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords, makeUntitledAndUnlocated } = require('./rom-words.cjs')
const { bgr555ToRgbTriplet, parseRgbTriplet } = require('./palette-color.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const ROM = process.env.HB_ROM || romPath(VANILLA)

const { RomFile } = require('../../extension/lib/src/rom/RomFile')
const { loadBackAreaColors } = require('../../extension/lib/src/rom/PaletteLoader')
const { bgr555ToRgba } = require('../../extension/lib/src/rom/GraphicsDecoder')

/**
 * The group shape loadRomPalettes() (src/rom/PaletteLoader.ts) builds, read
 * from its own group definitions rather than guessed: bg/fg/sp_ef are each 8
 * variants of 2 CGRAM rows, sprite_sets is 1 variant of 10 rows, player is 4
 * variants of 1 row. Every row is 16 colours (COLORS_PER_ROW).
 */
const EXPECTED_GROUPS = [
  { id: 'player', variants: 4, rowsPerVariant: 1 },
  { id: 'sprite_sets', variants: 1, rowsPerVariant: 10 },
  { id: 'sp_ef', variants: 8, rowsPerVariant: 2 },
  { id: 'fg', variants: 8, rowsPerVariant: 2 },
  { id: 'bg', variants: 8, rowsPerVariant: 2 },
  // Its own group, last, after Layer 2 Background: 8 fixed colours, one
  // variant, one row of 8 - not a 16-wide CGRAM row (it has no CGRAM row
  // at all; PPU register $2132/COLDATA, not palette data).
  { id: 'back_area', variants: 1, rowsPerVariant: 1, cols: 8 },
]
const COLS = 16

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

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pal-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const EXPLORER = 'hackbench.palette-explorer'
const sel = id => '#' + id.replace(/[.:]/g, m => '\\' + m)

async function createProject(page, dir, romPath = ROM, name = 'MyHack') {
  return page.evaluate(
    async ({ romPath, directory, name }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
    { romPath, directory: dir, name },
  )
}

/** Opens a project in the shell the way File > Open does, so every palette widget reacts to it. */
async function openProject(page, dir, romPath) {
  const project = await createProject(page, dir, romPath)
  await page.evaluate(p => {
    getSvc('ProjectContext').current = p
  }, project)
  await page.waitForTimeout(500)
  return project
}

async function revealExplorer(page) {
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, EXPLORER)
  await page.waitForTimeout(800)
}

/**
 * load() clears `result` to undefined until the RPC settles (palette-explorer-widget.tsx),
 * so reading it with a single evaluate races a slow server. Wait for it to
 * actually land through the WidgetManager before reading it back.
 */
async function explorerResult(page) {
  await page.waitForFunction(id => {
    const w = getSvc('WidgetManager').tryGetWidget(id)
    return !!w && w.result !== undefined
  }, EXPLORER)
  return page.evaluate(id => getSvc('WidgetManager').tryGetWidget(id).result, EXPLORER)
}

/** Opens a group or variant tab through the contribution, returning its widget id. */
async function openTab(page, manifestPath, groupId, variant, pinned = true) {
  const id = await page.evaluate(
    async ({ manifestPath, groupId, variant, pinned }) => {
      const w = await getSvc('PaletteExplorerContribution').openGroup({
        manifestPath,
        groupId,
        variant: variant === null ? undefined : variant,
        pinned,
      })
      return w.id
    },
    { manifestPath, groupId, variant: variant ?? null, pinned },
  )
  await page.waitForSelector(`${sel(id)} .hb-palette-swatch`, { timeout: 15000 })
  return id
}

/** Mario's red: PlayerColors variant 0 ("Mario"), CGRAM row 8 col 9, first `.hb-palette-variant` section. */
async function selectMarioRedSwatch(page, id) {
  const swatch = page
    .locator(`${sel(id)} .hb-palette-variant`)
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
  await swatch.click()
  return swatch
}

test('Palettes is in the left activity bar and reveals a tree of the six groups in served order', async ({
  page,
}) => {
  const project = await openProject(page, path.join(tmp, 'MyHack'))
  const inLeft = await page.evaluate(
    id =>
      getSvc('ApplicationShell')
        .getWidgets('left')
        .some(w => w.id === id),
    EXPLORER,
  )
  expect(inLeft).toBe(true)
  await revealExplorer(page)
  const labels = await page.evaluate(
    s => [...document.querySelectorAll(`${s} .theia-TreeNode`)].map(n => n.textContent),
    sel(EXPLORER),
  )
  const r = await explorerResult(page)
  expect(r.palettes.groups.map(g => g.id)).toEqual(EXPECTED_GROUPS.map(g => g.id))
  for (const g of r.palettes.groups) expect(labels.some(l => l.includes(g.label))).toBe(true)
  expect(project.manifestPath).toBeTruthy()
})

test('single click previews a group in an italic tab, double click pins it', async ({ page }) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  await revealExplorer(page)
  const node = page.locator(`${sel(EXPLORER)} .theia-TreeNode`, { hasText: 'Shared Sprite Colors' })
  // Rendered style, not just the class: index.css styles .hb-preview-tab .theia-tab-icon-label.
  const tabStyles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.lm-TabBar-tab, .p-TabBar-tab')]
        .filter(t => (t.textContent || '').includes('Shared Sprite Colors'))
        .map(t => getComputedStyle(t.querySelector('.theia-tab-icon-label')).fontStyle),
    )
  await node.click()
  await page.waitForTimeout(500)
  expect(await tabStyles()).toEqual(['italic'])
  await node.dblclick()
  await page.waitForTimeout(500)
  expect(await tabStyles()).toEqual(['normal'])
})

test('a variant row opens a tab with exactly that one variant', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'bg', 3)
  const state = await page.evaluate(s => {
    const el = document.querySelector(s)
    return {
      sections: el.querySelectorAll('.hb-palette-variant').length,
      rows: el.querySelectorAll('.hb-palette-row').length,
    }
  }, sel(id))
  expect(state).toEqual({ sections: 1, rows: 2 })
  // Variant 3's own label is "Palette 3" (PaletteLoader.ts loadRomPalettes,
  // bgPairVariants: `label: \`Palette ${v}\``), not a generic "Variant 3" -
  // tabTitle only falls back to "Variant N" when a variant carries no label.
  expect(
    await page.evaluate(
      i => document.getElementById(i) && getSvc('ApplicationShell').getWidgetById(i).title.label,
      id,
    ),
  ).toBe('Layer 2 Background \u00b7 Palette 3')
})

test('column 0 is hatched in every Layer 2 variant and Back Area Colors draws 8 swatches at the same size', async ({
  page,
}) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const bg = await openTab(page, p.manifestPath, 'bg')
  const col0 = await page.evaluate(
    s =>
      [...document.querySelectorAll(`${s} .hb-palette-variant`)].map(v => {
        const swatch = v.querySelector('.hb-palette-swatch')
        return {
          unwritten: swatch.classList.contains('hb-palette-swatch-unwritten'),
          style: swatch.getAttribute('style') || '',
          title: swatch.getAttribute('title') || '',
        }
      }),
    sel(bg),
  )
  expect(col0.map(c => c.unwritten)).toEqual(Array(8).fill(true))
  // Hatched, not a fabricated colour: no inline background and no BGR555
  // reading in its tooltip (only a real table-read cell ever gets either).
  for (const c of col0) {
    expect(c.style).not.toContain('background')
    expect(c.title).not.toMatch(/BGR555/i)
  }
  const ref = await page
    .locator(`${sel(bg)} .hb-palette-swatch`)
    .first()
    .evaluate(e => e.getBoundingClientRect().width)
  const ba = await openTab(page, p.manifestPath, 'back_area')
  const swatches = page.locator(`${sel(ba)} .hb-palette-swatch`)
  expect(await swatches.count()).toBe(8)
  expect(await page.locator(`${sel(ba)} .hb-palette-row-gutter`).count()).toBe(0)
  expect(await swatches.first().evaluate(e => e.getBoundingClientRect().width)).toBe(ref)
})

test('a group tab dragged into a split keeps rendering and accepting edits', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  const p = await openProject(page, dir)
  const player = await openTab(page, p.manifestPath, 'player')
  const bg = await openTab(page, p.manifestPath, 'bg')
  await page.evaluate(
    ({ player, bg }) => {
      const shell = getSvc('ApplicationShell')
      shell.addWidget(shell.getWidgetById(player), {
        area: 'main',
        mode: 'split-right',
        ref: shell.getWidgetById(bg),
      })
    },
    { player, bg },
  )
  await page.waitForTimeout(500)
  const boxes = await page.evaluate(
    ids => ids.map(i => document.getElementById(i).getBoundingClientRect().left),
    [player, bg],
  )
  expect(boxes[0]).not.toBe(boxes[1]) // side by side, both visible
  await page
    .locator(`${sel(player)} .hb-palette-variant`)
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
    .click()
  const hex = page.locator(`${sel(player)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(400)
  const opFiles = fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'ops', opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })
})

test('an edit in a variant tab updates the same cell in an open group tab', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const group = await openTab(page, p.manifestPath, 'player')
  const variant = await openTab(page, p.manifestPath, 'player', 0)
  const groupSwatch = page
    .locator(`${sel(group)} .hb-palette-variant`)
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
  await page
    .locator(`${sel(variant)} .hb-palette-swatch`)
    .nth(9)
    .click()
  const hex = page.locator(`${sel(variant)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(600)
  expect(
    parseRgbTriplet(await groupSwatch.evaluate(e => getComputedStyle(e).backgroundColor)),
  ).toEqual(bgr555ToRgbTriplet(0x03e0))
})

test('the animated color plays in the preview, with its frames directly beneath', async ({
  page,
}) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  const r = await explorerResult(page)
  const t = r.palettes.animation.targets.find(x => x.cgramIdx === 0x64)
  expect(r.palettes.animation.available).toBe(true)
  expect(t.frames.length).toBeGreaterThan(1)
  // CGRAM $64 is Shared Sprite Colors row index 2 (CGRAM 6), column 4.
  const cell = page
    .locator(`${sel(id)} .hb-palette-row`)
    .nth(2)
    .locator('.hb-palette-swatch')
    .nth(4)
  await expect(cell).toHaveClass(/hb-palette-swatch-animated/)
  await cell.click()
  const samples = await page.evaluate(async s => {
    const el = document.querySelector(`${s} .hb-palette-preview`)
    const out = []
    const t0 = performance.now()
    while (performance.now() - t0 < 1600) {
      out.push({ t: performance.now() - t0, c: getComputedStyle(el).backgroundColor })
      await new Promise(r => setTimeout(r, 16))
    }
    return out
  }, sel(id))
  const distinct = new Set(samples.map(s => s.c))
  const expectedDistinct = new Set(t.frames.map(f => `${f.color.r},${f.color.g},${f.color.b}`)).size
  expect(distinct.size).toBe(expectedDistinct)
  // No frozen span: the color must change at least once in any 4 frame periods.
  let last = samples[0]
  let longest = 0
  for (const s of samples) {
    if (s.c !== last.c) {
      longest = Math.max(longest, s.t - last.t)
      last = s
    }
  }
  longest = Math.max(longest, samples[samples.length - 1].t - last.t)
  expect(longest).toBeLessThan(4 * t.intervalMs + 100)
  // Frames sit directly under the preview.
  const gap = await page.evaluate(s => {
    const pv = document.querySelector(`${s} .hb-palette-preview`).getBoundingClientRect()
    const fr = document.querySelector(`${s} .hb-palette-frames`).getBoundingClientRect()
    return fr.top - pv.bottom
  }, sel(id))
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThan(16)
})

test('editing a frame persists an op file and updates every linked frame', async ({ page }) => {
  const dir = path.join(tmp, 'MyHack')
  // File offset 0x2424 (headerless LoROM) is $00A424, the operand of the
  // kernel's `AND.B #$1C` at $00A423 (SMWDisX bank_00.asm:4669).
  // Vanilla's own mask ($1C) is contiguous, so $64's frame list
  // never repeats a ROM address and this test cannot tell "every linked
  // frame" apart from "the one frame clicked". Poke the kernel's AND
  // operand non-contiguous instead (bits 2,3,5 set -> repeated low-order
  // phase offsets 0,2,4,6,0,2,4,6,16,... across 16 phases), so more than one
  // frame index genuinely shares one ROM word.
  const romPath = path.join(tmp, 'framemask.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[0x2424] = 0x2c
  fs.writeFileSync(romPath, bytes)
  const p = await openProject(page, dir, romPath)
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  await page
    .locator(`${sel(id)} .hb-palette-row`)
    .nth(2)
    .locator('.hb-palette-swatch')
    .nth(4)
    .click()
  const frames = page.locator(`${sel(id)} .hb-palette-frames .hb-palette-swatch`)
  await frames.nth(0).click()
  const r = await explorerResult(page)
  const t = r.palettes.animation.targets.find(x => x.cgramIdx === 0x64)
  const addr = t.frames[0].romAddr
  const linked = t.frames.map((f, i) => (f.romAddr === addr ? i : -1)).filter(i => i >= 0)
  // Prove the fixture itself before trusting the assertions built on it.
  expect(linked.length).toBeGreaterThan(1)
  const hex = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  const old = await hex.inputValue()
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(600)
  for (const i of linked) {
    expect(
      parseRgbTriplet(await frames.nth(i).evaluate(e => getComputedStyle(e).backgroundColor)),
    ).toEqual(bgr555ToRgbTriplet(0x03e0))
  }
  const opFiles = fs.readdirSync(path.join(dir, 'ops')).filter(f => f.endsWith('.json'))
  const layer = JSON.parse(fs.readFileSync(path.join(dir, 'ops', opFiles[0]), 'utf8'))
  const a = '$' + addr.toString(16).toUpperCase().padStart(6, '0')
  expect(layer.ops).toContainEqual({ address: a, old: '$' + old, new: '$03E0' })
})

test('a ROM whose level animation routine is patched out shows the reason and no markers', async ({
  page,
}) => {
  // $00A418 poked to RTS: the routine is intact but never reaches its write (CLAUDE.md, "Existing is not the same as reached").
  const romPath = path.join(tmp, 'patched.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[0x2418] = 0x60
  fs.writeFileSync(romPath, bytes)
  const p = await openProject(page, path.join(tmp, 'Patched'), romPath)
  await revealExplorer(page)
  const r = await explorerResult(page)
  expect(r.palettes.animation.available).toBe(false)
  expect(r.palettes.animation.targets).toEqual([])
  // A specific reason, not just the generic banner: `notes` empty would
  // still let the banner alone read "unavailable: no reason given" and pass
  // a text-only match.
  expect(r.palettes.animation.notes.length).toBeGreaterThan(0)
  const text = await page.evaluate(s => document.querySelector(s).innerText, sel(EXPLORER))
  expect(text).toMatch(/Level palette animation unavailable/)
  expect(text).toContain(r.palettes.animation.notes[0])
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  expect(await page.locator(`${sel(id)} .hb-palette-swatch-animated`).count()).toBe(0)
})

test('switching projects closes palette tabs', async ({ page }) => {
  const a = await openProject(page, path.join(tmp, 'A'))
  const id = await openTab(page, a.manifestPath, 'player')
  await openProject(page, path.join(tmp, 'B'))
  expect(await page.evaluate(i => !!getSvc('ApplicationShell').getWidgetById(i), id)).toBe(false)
})

test('a stale refusal in one tab leaves its grid visible', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'player')
  await page
    .locator(`${sel(id)} .hb-palette-variant`)
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
    .click()
  // Real races are not a reliable oracle (the push refresh usually wins), so
  // the service answers this tab's edit with the refusal WorkingRom.append gives.
  await page.evaluate(i => {
    const w = getSvc('ApplicationShell').getWidgetById(i)
    const real = w.palettes
    w.palettes = {
      loadPalettes: mp => real.loadPalettes(mp),
      setColor: async () => ({ status: 'stale', reason: '$00B2CE no longer holds $391F' }),
    }
  }, id)
  const hex = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(400)
  await expect(page.locator(`${sel(id)} .hb-palette-inspector-from-error`)).toHaveText(
    /no longer holds/,
  )
  expect(await page.locator(`${sel(id)} .hb-palette-swatch`).count()).toBeGreaterThan(0)
})

test('a successful edit clears an earlier refusal on the same cell', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHackRecover'))
  const id = await openTab(page, p.manifestPath, 'player')
  const swatch = await selectMarioRedSwatch(page, id)
  // One refusal, as WorkingRom.append gives it, then the real service back.
  await page.evaluate(i => {
    const w = getSvc('ApplicationShell').getWidgetById(i)
    const real = w.palettes
    w.palettes = {
      loadPalettes: mp => real.loadPalettes(mp),
      setColor: async () => {
        w.palettes = real
        return { status: 'stale', reason: '$00B2CE no longer holds $391F' }
      },
    }
  }, id)
  const hex = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  await hex.fill('03E0')
  await hex.press('Enter')
  const err = page.locator(`${sel(id)} .hb-palette-inspector-from-error`)
  await expect(err).toHaveText(/no longer holds/)
  // The real write pushes a working-copy change, and the fetch it starts
  // supersedes this commit's own response; the error must clear anyway.
  await hex.fill('03E0')
  await hex.press('Enter')
  await page.waitForTimeout(600)
  await expect(err).toHaveCount(0)
  expect(parseRgbTriplet(await swatch.evaluate(e => getComputedStyle(e).backgroundColor))).toEqual(
    bgr555ToRgbTriplet(0x03e0),
  )
})

test('a narrow tab wraps the inspector below the grid', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  // CGRAM $64 is Shared Sprite Colors row index 2, column 4 - the animated
  // cell. An empty inspector never renders its preview, frame strip or edit
  // row at all, so an overflow check against it would pass regardless of
  // whether those elements actually fit a narrow tab.
  await page
    .locator(`${sel(id)} .hb-palette-row`)
    .nth(2)
    .locator('.hb-palette-swatch')
    .nth(4)
    .click()
  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(400)
  const pos = await page.evaluate(s => {
    const m = document.querySelector(`${s} .hb-palette-main`).getBoundingClientRect()
    const i = document.querySelector(`${s} .hb-palette-inspector`).getBoundingClientRect()
    const maxRight = Math.max(
      ...[
        ...document.querySelectorAll(`${s} .hb-palette-inspector, ${s} .hb-palette-inspector *`),
      ].map(el => el.getBoundingClientRect().right),
    )
    return {
      inspectorTop: i.top,
      gridBottom: m.bottom,
      maxRight,
      tabRight: document.querySelector(s).getBoundingClientRect().right,
    }
  }, sel(id))
  expect(pos.inspectorTop).toBeGreaterThanOrEqual(pos.gridBottom - 1)
  // No descendant of the inspector - preview, frame strip, hex field,
  // buttons - overflows the tab, not just the inspector's own box.
  expect(pos.maxRight).toBeLessThanOrEqual(pos.tabRight + 1)
})

test("a reloaded window's explorer still opens tabs", async ({ page }) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  await revealExplorer(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await openProject(page, path.join(tmp, 'Again'))
  await revealExplorer(page)
  await page.locator(`${sel(EXPLORER)} .theia-TreeNode`, { hasText: 'Player Palettes' }).dblclick()
  await page.waitForTimeout(600)
  expect(
    await page.evaluate(
      () =>
        !!document.querySelector('[id^="hackbench.palette-group-view:player"] .hb-palette-swatch'),
    ),
  ).toBe(true)
})

/**
 * The colour-accuracy oracle, rewritten against the address each cell
 * cites rather than the array PaletteLoader's own toDto call used to build
 * it: comparing a cell to the same data that produced it is a tautology
 * that cannot fail when a cell is attributed but never actually read from
 * where it claims. Column 1 cites the LDA #imm opcode address rather than a
 * colour's own address, so its bytes are read and gated separately.
 */
test("every written cell's colour matches the actual ROM bytes at the address it cites", async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  const r = await explorerResult(page)
  expect(r.status).toBe('ok')

  const rom = RomFile.load(ROM)
  const truth = loadBackAreaColors(rom)
  let checked = 0
  let checkedCol1 = 0

  for (const g of r.palettes.groups) {
    // Every row this view renders is a 16-wide CGRAM slice, except
    // back_area's own 8-wide COLDATA row (EXPECTED_GROUPS' cols:8).
    const expectedCols = g.id === 'back_area' ? 8 : COLS
    for (const v of g.variants) {
      for (const row of v.rows) {
        expect(row.length, `${g.id} row width`).toBe(expectedCols)
        for (const cell of row) {
          if (!cell.written) continue
          expect(cell.romAddr, `${g.id} ${cell.table} cell with no romAddr`).not.toBeNull()

          let expected
          if (cell.table === 'LoadPalette (LoadCol8Pal)') {
            const buf = rom.readAt(cell.romAddr, 3)
            expect(buf, `${g.id} opcode at $${cell.romAddr.toString(16)} unreadable`).not.toBeNull()
            expect(buf[0], `${g.id} opcode at $${cell.romAddr.toString(16)} is not LDA #imm`).toBe(
              0xa9,
            )
            expected = bgr555ToRgba(buf.readUInt16LE(1))
            checkedCol1++
          } else {
            const buf = rom.readAt(cell.romAddr, 2)
            expect(
              buf,
              `${g.id} ${cell.table} $${cell.romAddr.toString(16)} unreadable`,
            ).not.toBeNull()
            expected = bgr555ToRgba(buf.readUInt16LE(0))
          }
          expect(cell.color, `${g.id} ${cell.table} $${cell.romAddr.toString(16)}`).toEqual({
            r: expected[0],
            g: expected[1],
            b: expected[2],
            a: expected[3],
          })
          checked++
        }
      }
    }
  }
  // Back Area Colors independently against loadBackAreaColors' own truth
  // (COLDATA, not a CGRAM row read through the address-citation path above).
  const backArea = r.palettes.groups.find(g => g.id === 'back_area')
  backArea.variants[0].rows[0].forEach((cell, i) => {
    const [tr, tg, tb, ta] = truth[i]
    expect(cell, `back_area index ${i}`).toMatchObject({ color: { r: tr, g: tg, b: tb, a: ta } })
  })
  // Animation frames against the bytes at the address each one cites, read
  // here rather than trusted from the detector that computed the address.
  expect(r.palettes.animation.available).toBe(true)
  let checkedFrames = 0
  for (const t of r.palettes.animation.targets) {
    for (const f of t.frames) {
      const buf = rom.readAt(f.romAddr, 2)
      expect(buf, `frame word $${f.romAddr.toString(16)} unreadable`).not.toBeNull()
      const [er, eg, eb, ea] = bgr555ToRgba(buf.readUInt16LE(0))
      expect(f.color, `CGRAM $${t.cgramIdx.toString(16)} frame $${f.romAddr.toString(16)}`).toEqual(
        { r: er, g: eg, b: eb, a: ea },
      )
      checkedFrames++
    }
  }
  // Tripwire against a sweep that silently checks nothing, or checks one
  // swatch: both were real defects here before this fix.
  expect(checked).toBeGreaterThan(700)
  expect(checkedCol1).toBeGreaterThan(0)
  expect(checkedFrames).toBeGreaterThan(1)
})

test('a cartridge too short to hold the palette tables is reported unreadable, not rendered as a plausible grid', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Tiny')
  // Outside the project directory: createProject refuses a non-empty target.
  const tinyRomPath = path.join(tmp, 'tiny.sfc')
  // The adversarial review's own example: far too short to carry a LoROM
  // header (needs 32 KB+) or any palette table.
  fs.writeFileSync(tinyRomPath, Buffer.alloc(0x2000, 0xff))

  await openProject(page, dir, tinyRomPath)
  await revealExplorer(page)
  const r = await explorerResult(page)
  expect(r.status).toBe('unreadable')
  const text = await page.evaluate(s => document.querySelector(s).innerText, sel(EXPLORER))
  // The served reason itself, not just "some text exists" - a note that
  // renders any non-empty placeholder would still pass a length check.
  expect(text).toContain(r.reason)
  expect(await page.locator('.hb-palette-swatch').count()).toBe(0)
})

test('no project open shows an explicit empty state, not a blank panel', async ({ page }) => {
  await revealExplorer(page)
  const text = await page.evaluate(s => document.querySelector(s).innerText, sel(EXPLORER))
  expect(text.toLowerCase()).toContain('open a project to see its palettes')
})

test('the palette explorer is labelled and carries a real, defined codicon class', async ({
  page,
}) => {
  await revealExplorer(page)

  const found = await page.evaluate(id => !!document.getElementById(id), EXPLORER)
  expect(found, 'the widget itself should exist').toBe(true)

  const icon = await page.evaluate(async id => {
    const w = await getWidget(id)
    const iconClass = w.title.iconClass || ''
    const hasCodicon = iconClass
      .split(/\s+/)
      .some(c => c.startsWith('codicon-') && c !== 'codicon-')
    if (!hasCodicon) return { iconClass, hasCodicon: false }

    // A real, defined glyph exists for this class (not a typo'd codicon
    // name), checked against the stylesheet rather than a rendered node.
    const name = iconClass.split(/\s+/).find(c => c.startsWith('codicon-'))
    let hasGlyphRule = false
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.selectorText && rule.selectorText.includes(`.${name}::before`)) {
            hasGlyphRule = true
            break
          }
        }
      } catch {
        /* cross-origin sheet */
      }
      if (hasGlyphRule) break
    }
    return { iconClass, hasCodicon, hasGlyphRule }
  }, EXPLORER)

  expect(icon.hasCodicon, `iconClass was "${icon.iconClass}"`).toBe(true)
  expect(icon.hasGlyphRule, `no ::before rule found for ${icon.iconClass}`).toBe(true)

  const label = await page.evaluate(async id => (await getWidget(id)).title.label, EXPLORER)
  expect(label).toBe('Palettes')

  // Rendered: the activity-bar tab for this view carries the same label.
  const barLabel = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.p-TabBar-tab, .lm-TabBar-tab')].find(t =>
      (t.getAttribute('title') || t.textContent || '').includes('Palettes'),
    )
    return el ? el.getAttribute('title') || el.textContent : null
  })
  expect(barLabel).toContain('Palettes')
})

/**
 * The colour picker + OK flow. Picking (a native "input" event on the
 * colour field - Playwright cannot drive the real OS dialog) does NOT
 * write anything; only clicking OK does. This is the simplified model:
 * no preview layer while picking, so OK's `old` is always the currently
 * committed value and can never go stale from an earlier preview tick.
 */
test('picking a colour previews it locally; OK commits it and persists a real op file', async ({
  page,
}) => {
  const dir = path.join(tmp, 'MyHack2')
  const p = await openProject(page, dir)
  const id = await openTab(page, p.manifestPath, 'player')
  const swatch = await selectMarioRedSwatch(page, id)
  const before = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)

  await page.evaluate(s => {
    const el = document.querySelector(`${s} .hb-palette-inspector-color`)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#00ff00')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, sel(id))
  await page.waitForTimeout(200)

  // Picking alone must not write anything to disk yet.
  const opsDir = path.join(dir, 'ops')
  const opFilesBeforeOk = fs.existsSync(opsDir)
    ? fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
    : []
  expect(opFilesBeforeOk).toEqual([])

  const okButton = page.locator(`${sel(id)} .hb-palette-inspector-ok`)
  await expect(okButton).toBeEnabled()
  await okButton.click()
  await page.waitForTimeout(300)

  const after = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseRgbTriplet(after)).toEqual(bgr555ToRgbTriplet(0x03e0)) // #00ff00 -> BGR555 $03E0
  expect(after).not.toBe(before)

  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles).toHaveLength(1)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })
  await expect(okButton).toBeDisabled() // nothing left staged
})

test('Cancel (and Escape) abandon a pick without writing anything', async ({ page }) => {
  const dir = path.join(tmp, 'MyHackCancel')
  const p = await openProject(page, dir)
  const id = await openTab(page, p.manifestPath, 'player')
  const swatch = await selectMarioRedSwatch(page, id)
  const before = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)

  await page.evaluate(s => {
    const el = document.querySelector(`${s} .hb-palette-inspector-color`)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#00ff00')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, sel(id))
  await page.waitForTimeout(200)

  const cancelButton = page.locator(`${sel(id)} .hb-palette-inspector-cancel`)
  await expect(cancelButton).toBeEnabled()
  await cancelButton.click()
  await page.waitForTimeout(200)

  const afterCancel = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(afterCancel).toBe(before)

  const opsDir = path.join(dir, 'ops')
  expect(fs.existsSync(opsDir) ? fs.readdirSync(opsDir) : []).toEqual([])

  // Pick again, this time abandon it with Escape.
  await page.evaluate(s => {
    const el = document.querySelector(`${s} .hb-palette-inspector-color`)
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#0000ff')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, sel(id))
  await page.waitForTimeout(200)
  // Escape is scoped to the inspector (a document listener cancelled every
  // open tab's pick), so it has to be pressed from inside it, where focus
  // sits after a real color dialog closes.
  await page.locator(`${sel(id)} .hb-palette-inspector-color`).focus()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  const afterEscape = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(afterEscape).toBe(before)
  expect(fs.existsSync(opsDir) ? fs.readdirSync(opsDir) : []).toEqual([])
})

test('a stale response never overwrites a newer one', async ({ page }) => {
  // Real RPC timing is not a reliable oracle here, so the service is
  // stubbed with two synthetic responses on controlled delays: A resolves
  // LAST despite being called FIRST. Without a request token, A's late
  // arrival overwrites B's.
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'player')
  const state = await page.evaluate(
    async ({ id, manifestPath }) => {
      const w = getSvc('ApplicationShell').getWidgetById(id)
      const real = w.palettes
      // Replacing what w.palettes POINTS TO, not a method on the live object:
      // the live object is a JSON-RPC proxy whose `get` trap can keep
      // synthesising the real RPC call regardless of a property write on it.
      let call = 0
      w.palettes = {
        loadPalettes: async () => {
          call++
          if (call === 1) {
            await new Promise(r => setTimeout(r, 150)) // A: called first, resolves last
            return { status: 'unreadable', reason: 'STALE-A' }
          }
          await new Promise(r => setTimeout(r, 10)) // B: called second, resolves first
          return { status: 'unreadable', reason: 'CURRENT-B' }
        },
      }
      try {
        const a = w.open({ manifestPath, groupId: 'player' })
        const b = w.open({ manifestPath, groupId: 'player' })
        await Promise.all([a, b])
        return { error: w.error || null, reason: w.result ? w.result.reason : null }
      } finally {
        w.palettes = real
      }
    },
    { id, manifestPath: p.manifestPath },
  )

  expect(state.error, state.error).toBeNull()
  expect(state.reason).toBe('CURRENT-B')
})

test('a project whose cartridge is not on this machine asks for it, not an error', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')
  await createProject(page, dir, ROM, 'Shared')

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  // Drive the explorer's own load() directly (as the old single-widget
  // test drove hackbench.palette-view's) rather than through ProjectContext,
  // since the manifest on disk is now the corrupted one.
  const state = await page.evaluate(
    async ({ mp, id }) => {
      const w = await getWidget(id)
      await w.load(mp)
      return {
        status: w.result.status,
        title: w.result.status === 'rom-not-located' ? w.result.baseRom.title : null,
      }
    },
    { mp: manifestPath, id: EXPLORER },
  )

  expect(state.status).toBe('rom-not-located')
  expect(state.title).toBe('SOMEONE ELSES CART')

  await revealExplorer(page)
  const text = await page.evaluate(s => document.querySelector(s).innerText, sel(EXPLORER))
  expect(text).toMatch(/locate/i)
  expect(text).toContain('SOMEONE ELSES CART')
})

/**
 * The regression the original bug lived in: a SECOND edit on the same cell,
 * right after the first. With the old preview-layer design, the second
 * edit's `old` was read from before any editing started while the
 * cartridge held the first edit's bytes, so it always refused as stale and
 * the swatch never visibly moved past the first colour. Reading the
 * COMMITTED value off the inspector before each edit (matching what a real
 * user sees) is what exposes that class of bug; a hardcoded original value
 * would not.
 */
test('a second edit on the same cell, right after the first, still visibly commits', async ({
  page,
}) => {
  const dir = path.join(tmp, 'MyHackSecondEdit')
  const p = await openProject(page, dir)
  const id = await openTab(page, p.manifestPath, 'player')
  const swatch = await selectMarioRedSwatch(page, id)
  const hexField = page.locator(`${sel(id)} .hb-palette-inspector-hex`)

  await hexField.fill('1000')
  await hexField.press('Enter')
  await page.waitForTimeout(300)
  const afterFirst = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseRgbTriplet(afterFirst)).toEqual(bgr555ToRgbTriplet(0x1000))

  // Read the CURRENTLY DISPLAYED value the way a user would, not a
  // hardcoded original - this is exactly what the buggy version got wrong.
  await expect(hexField).toHaveValue('1000')

  await hexField.fill('2000')
  await hexField.press('Enter')
  await page.waitForTimeout(300)

  const afterSecond = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseRgbTriplet(afterSecond)).toEqual(bgr555ToRgbTriplet(0x2000))
  expect(afterSecond).not.toBe(afterFirst)

  const errorText = await page.locator(`${sel(id)} .hb-palette-inspector-from-error`).count()
  expect(errorText).toBe(0) // no refusal was hit

  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles).toHaveLength(2)
})

/** Every main-area widget that is a palette tab, found by class: a restored tab never got its per-row id. */
async function paletteTabsInShell(page) {
  return page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('main')
      .filter(w => w.node.classList.contains('hb-palette-group-view'))
      .map(w => ({ id: w.id, label: w.title.label })),
  )
}

test('a palette tab saved with the layout does not come back as an empty tab after a reload', async ({
  page,
}) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  await openTab(page, p.manifestPath, 'player')
  expect((await paletteTabsInShell(page)).length).toBe(1)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  // Prove the fixture: the saved layout really does ask the restorer for a
  // palette tab, so an empty shell below is the guard's work and not a
  // layout that never held one.
  const saved = await page.evaluate(() =>
    Object.keys(localStorage).some(k =>
      (localStorage.getItem(k) || '').includes('hackbench.palette-group-view'),
    ),
  )
  expect(saved).toBe(true)
  expect(await paletteTabsInShell(page)).toEqual([])
  expect(await page.locator('.hb-palette-group-view').count()).toBe(0)
})

test('expanding Layer 2 Background and clicking Palette 3 opens that one variant', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'MyHack'))
  await revealExplorer(page)
  await explorerResult(page)
  const group = page.locator(`${sel(EXPLORER)} .theia-TreeNode`, {
    hasText: 'Layer 2 Background',
  })
  await group.locator('.theia-ExpansionToggle').click()
  const row = page.locator(`${sel(EXPLORER)} .theia-TreeNode`, { hasText: 'Palette 3' })
  await expect(row).toHaveCount(1)
  await row.click()
  await page.waitForFunction(() =>
    getSvc('ApplicationShell')
      .getWidgets('main')
      .some(w => w.title.label.endsWith('Palette 3')),
  )
  const opened = await page.evaluate(() => {
    const w = getSvc('ApplicationShell')
      .getWidgets('main')
      .find(x => x.title.label.endsWith('Palette 3'))
    return {
      label: w.title.label,
      sections: w.node.querySelectorAll('.hb-palette-variant').length,
    }
  })
  expect(opened.label).toMatch(/^Layer 2 Background .*Palette 3$/)
  expect(opened.sections).toBe(1)
})

test('Escape in one tab leaves a pick in another tab alone', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHackEsc'))
  const a = await openTab(page, p.manifestPath, 'player')
  const b = await openTab(page, p.manifestPath, 'player', 0)
  // Side by side, so both inspectors are mounted and shown at once.
  await page.evaluate(
    ({ a, b }) => {
      const shell = getSvc('ApplicationShell')
      shell.addWidget(shell.getWidgetById(a), {
        area: 'main',
        mode: 'split-right',
        ref: shell.getWidgetById(b),
      })
    },
    { a, b },
  )
  await page.waitForTimeout(400)
  await selectMarioRedSwatch(page, a)
  await page
    .locator(`${sel(b)} .hb-palette-swatch`)
    .nth(9)
    .click()
  for (const id of [a, b]) await page.locator(`${sel(id)} .hb-palette-inspector-hex`).fill('03E0')
  await expect(page.locator(`${sel(a)} .hb-palette-inspector-ok`)).toBeEnabled()
  await expect(page.locator(`${sel(b)} .hb-palette-inspector-ok`)).toBeEnabled()
  // From the color input, not the hex field: the hex field handles Escape
  // itself, so only this reaches the inspector root's handler.
  await page.locator(`${sel(b)} .hb-palette-inspector-color`).press('Escape')
  await page.waitForTimeout(200)
  await expect(page.locator(`${sel(b)} .hb-palette-inspector-ok`)).toBeDisabled()
  await expect(page.locator(`${sel(a)} .hb-palette-inspector-ok`)).toBeEnabled()
  await expect(page.locator(`${sel(a)} .hb-palette-inspector-hex`)).toHaveValue('03E0')
})

/** Samples the preview's background in tab `id` for `ms`, returning the distinct values seen. */
async function previewColors(page, id, ms) {
  return page.evaluate(
    async ({ s, ms }) => {
      const el = document.querySelector(`${s} .hb-palette-preview`)
      const seen = new Set()
      const t0 = performance.now()
      while (performance.now() - t0 < ms) {
        seen.add(getComputedStyle(el).backgroundColor)
        await new Promise(r => setTimeout(r, 16))
      }
      return [...seen]
    },
    { s: sel(id), ms },
  )
}

/** CGRAM $64, the animated cell: Shared Sprite Colors row index 2, column 4. */
async function selectAnimatedCell(page, id) {
  await page
    .locator(`${sel(id)} .hb-palette-row`)
    .nth(2)
    .locator('.hb-palette-swatch')
    .nth(4)
    .click()
}

test('the preview pauses while its tab is hidden and resumes when shown', async ({ page }) => {
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  await selectAnimatedCell(page, id)
  // Playing while shown, or "no change while hidden" below proves nothing.
  expect((await previewColors(page, id, 600)).length).toBeGreaterThan(1)
  await openTab(page, p.manifestPath, 'player')
  await page.waitForTimeout(200)
  expect(await page.evaluate(i => getSvc('ApplicationShell').getWidgetById(i).isVisible, id)).toBe(
    false,
  )
  expect((await previewColors(page, id, 600)).length).toBe(1)
  await page.evaluate(async i => {
    await getSvc('ApplicationShell').activateWidget(i)
  }, id)
  await page.waitForTimeout(200)
  expect((await previewColors(page, id, 600)).length).toBeGreaterThan(1)
})

test('on a wide tab the inspector sits beside the grid, not at the far edge', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'sprite_sets')
  await selectAnimatedCell(page, id)
  await page.waitForTimeout(300)
  const m = await page.evaluate(s => {
    const root = document.querySelector(s)
    const layout = root.querySelector('.hb-palette-view-layout')
    const swatchRight = Math.max(
      ...[...root.querySelectorAll('.hb-palette-main .hb-palette-swatch')].map(
        e => e.getBoundingClientRect().right,
      ),
    )
    const i = root.querySelector('.hb-palette-inspector').getBoundingClientRect()
    const main = root.querySelector('.hb-palette-main').getBoundingClientRect()
    return {
      em: parseFloat(getComputedStyle(layout).fontSize),
      swatchRight,
      inspectorLeft: i.left,
      inspectorTop: i.top,
      mainTop: main.top,
      tabRight: root.getBoundingClientRect().right,
    }
  }, sel(id))
  // Same line: a wrapped inspector sits below, where the gap check is meaningless.
  expect(Math.abs(m.inspectorTop - m.mainTop)).toBeLessThan(2)
  expect(m.inspectorLeft).toBeGreaterThan(m.swatchRight)
  expect(m.inspectorLeft - m.swatchRight).toBeLessThanOrEqual(3 * m.em)
})

test('the inspector stays in view while a tall tab scrolls', async ({ page }) => {
  // Shorter than 1080 so Layer 2 Background (8 variants x 2 rows) is surely
  // taller than the tab at 1920 wide; the range check below proves it scrolls.
  await page.setViewportSize({ width: 1920, height: 640 })
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'bg')
  await page
    .locator(`${sel(id)} .hb-palette-swatch`)
    .nth(3)
    .click()
  await page.waitForTimeout(300)
  const m = await page.evaluate(async s => {
    const layout = document.querySelector(`${s} .hb-palette-view-layout`)
    const range = layout.scrollHeight - layout.clientHeight
    layout.scrollTop = layout.scrollHeight
    await new Promise(r => setTimeout(r, 200))
    const box = layout.getBoundingClientRect()
    const i = document.querySelector(`${s} .hb-palette-inspector`).getBoundingClientRect()
    return { range, scrolled: layout.scrollTop, top: box.top, bottom: box.bottom, iTop: i.top }
  }, sel(id))
  expect(m.range).toBeGreaterThan(100)
  expect(m.scrolled).toBeGreaterThan(100)
  expect(m.iTop).toBeGreaterThanOrEqual(m.top - 1)
  expect(m.iTop).toBeLessThan(m.bottom)
})

test('swatches grow on a wide tab and stay 1.8em on a narrow one', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  const p = await openProject(page, path.join(tmp, 'MyHack'))
  const id = await openTab(page, p.manifestPath, 'bg')
  const measure = () =>
    page.evaluate(s => {
      const sw = document.querySelector(`${s} .hb-palette-main .hb-palette-swatch`)
      return {
        width: sw.getBoundingClientRect().width,
        em: parseFloat(getComputedStyle(sw).fontSize),
      }
    }, sel(id))
  await page.waitForTimeout(300)
  const wide = await measure()
  await page.setViewportSize({ width: 700, height: 900 })
  await page.waitForTimeout(400)
  const narrow = await measure()
  expect(wide.width).toBeGreaterThan(narrow.width)
  // The pre-change size, so a narrow tab looks exactly as it did.
  expect(Math.abs(narrow.width - 1.8 * narrow.em)).toBeLessThan(0.5)
})

/**
 * Ctrl+Z straight after a hex-field edit, with focus left exactly where the
 * edit leaves it.
 *
 * undo-redo.spec.cjs proves Ctrl+Z works when the palette view has been
 * activated through `ApplicationShell.activateWidget`, which focuses the
 * widget NODE. A user editing a colour leaves focus in the hex `<input>`,
 * which has its own native undo. This is the path the owner reported broken
 * by hand while every existing undo test was green, so the assertion is on
 * the committed op files: whether the EDIT was undone, not whether some
 * keybinding fired.
 */
test('Ctrl+Z after a hex-field edit undoes the edit, not just the text', async ({ page }) => {
  const dir = path.join(tmp, 'KeyUndoFromField')
  // openProject sets ProjectContext.current: EditStackContribution gates on
  // it, so without it undo would correctly decline and the test would measure
  // its own setup.
  const p = await openProject(page, dir)
  const id = await openTab(page, p.manifestPath, 'player')
  await selectMarioRedSwatch(page, id)

  const hexField = page.locator(`${sel(id)} .hb-palette-inspector-hex`)
  await hexField.fill('03E0')
  await hexField.press('Enter')
  await page.waitForTimeout(400)

  const opsDir = path.join(dir, 'ops')
  expect(fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))).toHaveLength(1)

  // No click elsewhere first: focus is wherever committing the edit left it.
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(800)

  // The layer file leaves ops/ on undo - that is the behaviour, not a
  // repainted swatch.
  const after = fs.existsSync(opsDir) ? fs.readdirSync(opsDir).filter(f => f.endsWith('.json')) : []
  expect(after).toHaveLength(0)
})

test('the palette explorer speaks of ROMs, never cartridges', async ({ page }) => {
  await openProject(page, path.join(tmp, 'Words'))
  await revealExplorer(page)
  await page.waitForSelector(`${sel(EXPLORER)} .theia-TreeNode`, { timeout: 15000 })
  const loaded = await shownWords(page, sel(EXPLORER))
  expect(loaded).toMatch(/Player Palettes/)
  expect(loaded).not.toMatch(CART)

  // A fresh project: the opened one's working copy is already resolved.
  const untitled = await createProject(page, path.join(tmp, 'Untitled'), ROM, 'Untitled')
  makeUntitledAndUnlocated(untitled.manifestPath)
  await page.evaluate(async ({ mp, id }) => (await getWidget(id)).load(mp), {
    mp: untitled.manifestPath,
    id: EXPLORER,
  })
  const missing = () => shownWords(page, sel(EXPLORER))
  await expect.poll(missing).toContain('Locate the base ROM')
  expect(await missing()).not.toMatch(CART)
})
