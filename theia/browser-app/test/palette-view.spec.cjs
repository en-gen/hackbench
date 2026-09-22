/**
 * The palette view, end to end against the shell.
 *
 * This view shows the STOCK ROM TABLES loadRomPalettes() and
 * PaletteStockTables.ts read, not the composed runtime CGRAM a level or the
 * overworld actually loads. Theia's main-area tab bar does not render
 * `title.iconClass` into the tab's icon element (verified against Maps'
 * own already-shipped main-area widget), so the icon test checks the
 * title's class rather than the rendered tab.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

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
  { id: 'bg', variants: 8, rowsPerVariant: 2 },
  { id: 'fg', variants: 8, rowsPerVariant: 2 },
  { id: 'sprite_sets', variants: 1, rowsPerVariant: 10 },
  { id: 'player', variants: 4, rowsPerVariant: 1 },
  { id: 'sp_ef', variants: 8, rowsPerVariant: 2 },
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

async function revealPalettes(page) {
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.palette-view')
  })
  await page.waitForTimeout(800)
}

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

async function loadPalettes(page, dir) {
  return page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      if (!svc) return { error: 'ProjectService not resolvable from the frontend' }
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      const w = await getWidget('hackbench.palette-view')
      await w.load(project.manifestPath)
      return { manifestPath: project.manifestPath, result: w.result }
    },
    { romPath: ROM, directory: dir },
  )
}

test("every group and row shape matches loadRomPalettes' own definitions", async ({ page }) => {
  const { result, error } = await loadPalettes(page, path.join(tmp, 'MyHack'))
  expect(error).toBeUndefined()
  expect(result.status).toBe('ok')
  expect(result.palettes.groups.map(g => g.id)).toEqual(EXPECTED_GROUPS.map(g => g.id))

  for (const expected of EXPECTED_GROUPS) {
    const g = result.palettes.groups.find(x => x.id === expected.id)
    expect(g.variants.length, `${expected.id} variant count`).toBe(expected.variants)
    g.variants.forEach((v, vi) => {
      expect(v.rows.length, `${expected.id}[${vi}] row count`).toBe(expected.rowsPerVariant)
      v.rows.forEach((row, ri) =>
        expect(row.length, `${expected.id}[${vi}][${ri}] col count`).toBe(COLS),
      )
    })
  }
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
  const { result, error } = await loadPalettes(page, path.join(tmp, 'MyHack'))
  expect(error).toBeUndefined()
  expect(result.status).toBe('ok')

  const rom = RomFile.load(ROM)
  let checked = 0
  let checkedCol1 = 0

  for (const g of result.palettes.groups) {
    for (const v of g.variants) {
      for (const row of v.rows) {
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
  // Tripwire against a sweep that silently checks nothing, or checks one
  // swatch: both were real defects here before this fix.
  expect(checked).toBeGreaterThan(700)
  expect(checkedCol1).toBeGreaterThan(0)
})

test('the back area colour rides with its bg variant and matches loadBackAreaColors', async ({
  page,
}) => {
  const { result } = await loadPalettes(page, path.join(tmp, 'MyHack'))
  const rom = RomFile.load(ROM)
  const truth = loadBackAreaColors(rom)

  const bg = result.palettes.groups.find(g => g.id === 'bg')
  expect(bg.variants.length).toBe(8)
  bg.variants.forEach((v, vi) => {
    const [r, g, b, a] = truth[vi]
    expect(v.backAreaColor, `bg variant ${vi} backAreaColor`).toEqual({ r, g, b, a })
    // Also the colour actually shown at CGRAM row 0's own column 0.
    expect(v.rows[0][0], `bg variant ${vi} row 0 col 0`).toMatchObject({
      table: 'BackAreaColors',
      color: { r, g, b, a },
    })
  })
})

test('a cell no table writes is never painted as a colour or given a BGR555 reading', async ({
  page,
}) => {
  const { result } = await loadPalettes(page, path.join(tmp, 'MyHack'))

  // Known-still-unwritten cells: fg col 8 (no table covers it), player cols
  // 2-5 (PlayerColors starts at col 6), sp_ef cols 8-15 (no secondary table
  // targets its rows), and any row but the first's column 0 (only CGRAM $00
  // is the real backdrop; every other row's col 0 is a transparent sentinel).
  const fg = result.palettes.groups.find(g => g.id === 'fg')
  expect(fg.variants[0].rows[0][8]).toEqual({ written: false })
  const player = result.palettes.groups.find(g => g.id === 'player')
  for (const col of [2, 3, 4, 5])
    expect(player.variants[0].rows[0][col]).toEqual({ written: false })
  const spEf = result.palettes.groups.find(g => g.id === 'sp_ef')
  for (const col of [8, 9, 12, 15])
    expect(spEf.variants[0].rows[0][col]).toEqual({ written: false })
  const bg = result.palettes.groups.find(g => g.id === 'bg')
  expect(bg.variants[0].rows[1][0]).toEqual({ written: false })

  // And the rendered half: hatched, no colour, no BGR555 in its tooltip.
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })

  const unwritten = await page.evaluate(() => {
    // bg's active row 0: column 8 is unwritten only past StatusBarColors'
    // range on OTHER groups, so use fg's col 8 instead - switch group first.
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Foreground'),
    )
    nav.click()
    return new Promise(resolve =>
      setTimeout(() => {
        const el = document.getElementById('hackbench.palette-view')
        const row0 = [...el.querySelectorAll('.hb-palette-row')][0]
        const swatch = row0.querySelectorAll('.hb-palette-swatch')[8]
        resolve({
          hasUnwrittenClass: swatch.classList.contains('hb-palette-swatch-unwritten'),
          inlineStyle: swatch.getAttribute('style') || '',
          title: swatch.getAttribute('title') || '',
        })
      }, 300),
    )
  })
  expect(unwritten.hasUnwrittenClass).toBe(true)
  expect(unwritten.inlineStyle).not.toContain('background')
  expect(unwritten.title).not.toMatch(/BGR555/)
})

test('two groups that genuinely share a CGRAM row still cite their own distinct tables', async ({
  page,
}) => {
  // sprite_sets row index 4 and player's only row are both CGRAM row 8, and
  // both StandardColors and PlayerColors cover its columns 6-7 - a real
  // overlap, not a bug. Each cell must still name ITS OWN table rather than
  // asserting one shared, unqualified "CGRAM row 8" identity.
  const { result } = await loadPalettes(page, path.join(tmp, 'MyHack'))
  const spriteSets = result.palettes.groups.find(g => g.id === 'sprite_sets')
  const player = result.palettes.groups.find(g => g.id === 'player')
  expect(spriteSets.variants[0].rows[4][6].table).toBe('StandardColors')
  expect(player.variants[0].rows[0][6].table).toBe('PlayerColors')

  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-nav-item', { timeout: 15000 })

  const gutter = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Shared Sprite Colors'),
    )
    nav.click()
    return new Promise(resolve =>
      setTimeout(() => {
        const el = document.getElementById('hackbench.palette-view')
        const gutters = [...el.querySelectorAll('.hb-palette-row-gutter')].map(g => g.textContent)
        resolve(gutters)
      }, 300),
    )
  })
  // Plain row identifiers, not a table-name claim that would misattribute
  // the half of the row a different table actually supplies.
  for (const g of gutter) expect(g).toMatch(/^CGRAM \d+$/)
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

  const state = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'Tiny', directory })
      const w = await getWidget('hackbench.palette-view')
      await w.load(project.manifestPath)
      return {
        status: w.result ? w.result.status : null,
        error: w.error || null,
        text: document.getElementById('hackbench.palette-view').innerText,
      }
    },
    { romPath: tinyRomPath, directory: dir },
  )

  expect(state.error, state.error).toBeNull()
  expect(state.status).toBe('unreadable')
  expect(state.text.length).toBeGreaterThan(0)
})

test('a stale response never overwrites a newer one', async ({ page }) => {
  // Real RPC timing is not a reliable oracle here, so the service is
  // stubbed with two synthetic responses on controlled delays: A resolves
  // LAST despite being called FIRST. Without a request token, A's late
  // arrival overwrites B's.
  const state = await page.evaluate(async () => {
    const w = await getWidget('hackbench.palette-view')
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
      const a = w.load('manifest-a')
      const b = w.load('manifest-b')
      await Promise.all([a, b])
      return {
        manifestPath: w.manifestPath,
        error: w.error || null,
        reason: w.result ? w.result.reason : null,
      }
    } finally {
      w.palettes = real
    }
  })

  expect(state.error, state.error).toBeNull()
  expect(state.manifestPath).toBe('manifest-b')
  expect(state.reason).toBe('CURRENT-B')
})

test('a project whose cartridge is not on this machine asks for it, not an error', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')

  await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({ romPath, name: 'Shared', directory })
    },
    { romPath: ROM, directory: dir },
  )

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const state = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.palette-view')
    await w.load(mp)
    return {
      status: w.result.status,
      title: w.result.status === 'rom-not-located' ? w.result.baseRom.title : null,
    }
  }, manifestPath)

  expect(state.status).toBe('rom-not-located')
  expect(state.title).toBe('SOMEONE ELSES CART')

  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view', { timeout: 15000 })
  const text = await page.locator('#hackbench\\.palette-view').innerText()
  expect(text).toMatch(/locate/i)
  expect(text).toContain('SOMEONE ELSES CART')
})

test('no project open shows an explicit empty state, not a blank panel', async ({ page }) => {
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view', { timeout: 15000 })

  const text = await page.locator('#hackbench\\.palette-view').innerText()
  expect(text.toLowerCase()).toContain('open a project')
})

test('the palette view is labelled and carries a real, defined codicon class', async ({ page }) => {
  await revealPalettes(page)

  const found = await page.evaluate(() => !!document.getElementById('hackbench.palette-view'))
  expect(found, 'the widget itself should exist').toBe(true)

  const tabLabel = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.lm-TabBar-tab')].find(
      t => (t.querySelector('.lm-TabBar-tabLabel')?.textContent || '') === 'Palettes',
    )
    return tab ? tab.querySelector('.lm-TabBar-tabLabel').textContent : null
  })
  expect(tabLabel, 'a tab labelled Palettes should exist').toBe('Palettes')

  const icon = await page.evaluate(async () => {
    const w = await getWidget('hackbench.palette-view')
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
  })

  expect(icon.hasCodicon, `iconClass was "${icon.iconClass}"`).toBe(true)
  expect(icon.hasGlyphRule, `no ::before rule found for ${icon.iconClass}`).toBe(true)
})
