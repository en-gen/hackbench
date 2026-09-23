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
        expect(row.length, `${expected.id}[${vi}][${ri}] col count`).toBe(expected.cols ?? COLS),
      )
    })
  }

  // The rendered nav follows the same order, and opens on its first entry.
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-nav-item', { timeout: 15000 })
  const nav = await page.evaluate(() =>
    [...document.querySelectorAll('.hb-palette-nav-item')].map(n => {
      const el = n.querySelector('.hb-palette-nav-label')
      return {
        label: el?.textContent ?? '',
        active: n.classList.contains('hb-palette-nav-item-active'),
        clipped: !el || el.scrollWidth > el.clientWidth,
      }
    }),
  )
  expect(nav.map(n => n.label)).toEqual(result.palettes.groups.map(g => g.label))
  expect(nav.findIndex(n => n.active)).toBe(0)
  // The nav is fixed-width and not resizable, so every label must show in full.
  for (const n of nav) expect(n.clipped, `nav label "${n.label}" is clipped`).toBe(false)
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

/**
 * Back Area Colors: its own standalone group next to Layer 2 Background,
 * not a swatch paired one-to-one with each BG variant (that pairing implied
 * a link the cartridge does not have - BG palette is header byte 0, back
 * area colour is the INDEPENDENT header byte 1). Nor does it leak into
 * CGRAM row 0 col 0: CODE_00922F zeroes that cell before every upload
 * (SMWDisX bank_00.asm:2047-2048); back area goes to COLDATA instead.
 */
test('Back Area Colors is its own group of 8, matching loadBackAreaColors, with no CGRAM row', async ({
  page,
}) => {
  const { result } = await loadPalettes(page, path.join(tmp, 'MyHack'))
  const rom = RomFile.load(ROM)
  const truth = loadBackAreaColors(rom)

  const group = result.palettes.groups.find(g => g.id === 'back_area')
  expect(group, 'a back_area group should exist').toBeTruthy()
  expect(group.cgRamRow).toBeNull() // it has no CGRAM row - it is not CGRAM data
  expect(group.description.toLowerCase()).toMatch(/coldata|\$2132/) // states what it IS
  expect(group.description).toMatch(/byte 1/) // and how a map picks one

  expect(group.variants.length).toBe(1)
  const cells = group.variants[0].rows[0]
  expect(cells.length).toBe(8)
  cells.forEach((cell, i) => {
    const [r, g, b, a] = truth[i]
    expect(cell, `back_area index ${i}`).toMatchObject({ written: true, color: { r, g, b, a } })
    expect(cell.romAddr, `back_area index ${i} romAddr`).toBe(0x00b0a0 + i * 2)
  })

  // Layer 2 Background no longer carries a per-variant back-area pairing,
  // neither as a field nor as its first row's column 0.
  const bg = result.palettes.groups.find(g => g.id === 'bg')
  bg.variants.forEach((v, vi) => {
    expect(v.backAreaColor).toBeUndefined()
    expect(v.rows[0][0], `bg variant ${vi} row 0 col 0`).toEqual({ written: false })
  })

  // It has its own nav entry, same weight as the other five - not a detail
  // nested inside Layer 2 Background's own display.
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-nav-item', { timeout: 15000 })

  // Rendered: Layer 2 Background's first swatch in every variant is hatched,
  // not painted with a back area colour.
  const bgCol0 = await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Layer 2 Background'),
    )
    nav.click()
    return new Promise(resolve =>
      setTimeout(() => {
        const el = document.getElementById('hackbench.palette-view')
        resolve(
          [...el.querySelectorAll('.hb-palette-variant')].map(variant => {
            const s = variant.querySelector('.hb-palette-row .hb-palette-swatch')
            return {
              unwritten: s.classList.contains('hb-palette-swatch-unwritten'),
              style: s.getAttribute('style') || '',
            }
          }),
        )
      }, 300),
    )
  })
  expect(bgCol0.length).toBe(8)
  for (const s of bgCol0) {
    expect(s.unwritten).toBe(true)
    expect(s.style).not.toContain('background')
  }
  const navLabels = await page.evaluate(() =>
    [...document.querySelectorAll('.hb-palette-nav-label')].map(el => el.textContent),
  )
  expect(navLabels).toContain('Back Area Colors')

  // Its swatches render at the same size as every other group's.
  const referenceSize = await page
    .locator('#hackbench\\.palette-view .hb-palette-swatch')
    .first()
    .evaluate(el => el.getBoundingClientRect().width)
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Back Area Colors'),
    )
    nav.click()
  })
  await page.waitForTimeout(300)
  const backAreaSwatches = page.locator('#hackbench\\.palette-view .hb-palette-swatch')
  expect(await backAreaSwatches.count()).toBe(8)
  const backAreaSize = await backAreaSwatches
    .first()
    .evaluate(el => el.getBoundingClientRect().width)
  expect(backAreaSize).toBe(referenceSize)
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

/**
 * Editing. Mario's red: PlayerColors variant 0 ("Mario"), CGRAM row 8 col 9,
 * $00B2CE, vanilla word $391F (SMWDisX/bank_00.asm:11257, :11324-11332 -
 * see the implementation brief). Player Palettes is currently the first
 * group, which activeGroupId defaults to, but it is selected explicitly
 * rather than assuming that order.
 */

/** Same expansion PaletteColorFormat.bgr555HexToCssHex uses: 5-bit -> 8-bit, exact for a value that came from bgr555ToRgba. */
function bgr555ToRgbTriplet(word) {
  const r5 = word & 0x1f
  const g5 = (word >> 5) & 0x1f
  const b5 = (word >> 10) & 0x1f
  const expand = c5 => (c5 << 3) | (c5 >> 2)
  return [expand(r5), expand(g5), expand(b5)]
}

function parseRgbTriplet(cssColor) {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(cssColor)
  if (!m) throw new Error(`not an rgb() colour: ${cssColor}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

async function selectMarioRedSwatch(page) {
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Player Palettes'),
    )
    nav.click()
  })
  await page.waitForTimeout(300)
  // Mario is the first variant section; its one row is CGRAM row 8; column
  // index 9 is the 10th swatch.
  const swatch = page
    .locator('#hackbench\\.palette-view .hb-palette-variant')
    .first()
    .locator('.hb-palette-swatch')
    .nth(9)
  await swatch.click()
  return swatch
}

test("changing a swatch's hex value updates its rendered colour and persists a real op file", async ({
  page,
}) => {
  const dir = path.join(tmp, 'MyHack')
  const { manifestPath } = await loadPalettes(page, dir)
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })

  const swatch = await selectMarioRedSwatch(page)

  const before = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseRgbTriplet(before)).toEqual(bgr555ToRgbTriplet(0x391f)) // vanilla red before the edit

  const hexField = page.locator('#hackbench\\.palette-view .hb-palette-inspector-hex')
  await expect(hexField).toHaveValue('391F')

  await hexField.fill('03E0')
  await hexField.press('Enter')
  await page.waitForTimeout(300)

  const after = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(parseRgbTriplet(after)).toEqual(bgr555ToRgbTriplet(0x03e0))
  expect(after).not.toBe(before) // the actual pixel colour changed, not just a class

  await expect(hexField).toHaveValue('03E0')

  // The edit is a real, committed op file under ops/ - address+old+new, not
  // a raw cartridge byte, so it is plainly fine for check-staged-content.sh.
  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles.length).toBeGreaterThan(0)
  const layer = JSON.parse(fs.readFileSync(path.join(opsDir, opFiles[0]), 'utf8'))
  expect(layer.ops).toContainEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })

  // Reload the project fresh: the working copy (not just in-memory widget
  // state) reflects the edit.
  const reloaded = await page.evaluate(async mp => {
    const wm = getSvc('WidgetManager')
    const widget = await wm.getOrCreateWidget('hackbench.palette-view')
    await widget.load(mp)
    return widget.result
  }, manifestPath)
  expect(reloaded.status).toBe('ok')
  const player = reloaded.palettes.groups.find(g => g.id === 'player')
  expect(player.variants[0].rows[0][9].color).toEqual({
    r: bgr555ToRgbTriplet(0x03e0)[0],
    g: bgr555ToRgbTriplet(0x03e0)[1],
    b: bgr555ToRgbTriplet(0x03e0)[2],
    a: 255,
  })
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
  await loadPalettes(page, dir)
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })

  const swatch = await selectMarioRedSwatch(page)
  const before = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)

  await page.evaluate(() => {
    const el = document.querySelector('#hackbench\\.palette-view .hb-palette-inspector-color')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#00ff00')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(200)

  // Picking alone must not write anything to disk yet.
  const opsDir = path.join(dir, 'ops')
  const opFilesBeforeOk = fs.existsSync(opsDir)
    ? fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
    : []
  expect(opFilesBeforeOk).toEqual([])

  const okButton = page.locator('#hackbench\\.palette-view .hb-palette-inspector-ok')
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
  await loadPalettes(page, dir)
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })

  const swatch = await selectMarioRedSwatch(page)
  const before = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)

  await page.evaluate(() => {
    const el = document.querySelector('#hackbench\\.palette-view .hb-palette-inspector-color')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#00ff00')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(200)

  const cancelButton = page.locator('#hackbench\\.palette-view .hb-palette-inspector-cancel')
  await expect(cancelButton).toBeEnabled()
  await cancelButton.click()
  await page.waitForTimeout(200)

  const afterCancel = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(afterCancel).toBe(before)

  const opsDir = path.join(dir, 'ops')
  expect(fs.existsSync(opsDir) ? fs.readdirSync(opsDir) : []).toEqual([])

  // Pick again, this time abandon it with Escape.
  await page.evaluate(() => {
    const el = document.querySelector('#hackbench\\.palette-view .hb-palette-inspector-color')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '#0000ff')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)

  const afterEscape = await swatch.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(afterEscape).toBe(before)
  expect(fs.existsSync(opsDir) ? fs.readdirSync(opsDir) : []).toEqual([])
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
  await loadPalettes(page, dir)
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })

  const swatch = await selectMarioRedSwatch(page)
  const hexField = page.locator('#hackbench\\.palette-view .hb-palette-inspector-hex')

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

  const errorText = await page
    .locator('#hackbench\\.palette-view .hb-palette-inspector-from-error')
    .count()
  expect(errorText).toBe(0) // no refusal was hit

  const opsDir = path.join(dir, 'ops')
  const opFiles = fs.readdirSync(opsDir).filter(f => f.endsWith('.json'))
  expect(opFiles).toHaveLength(2)
})

/**
 * A genuine stale refusal must be visible INSIDE the inspector, naming the
 * address and both values, and must NOT hide the rest of the palette view -
 * an earlier version replaced the entire panel with a bare error div on
 * ANY edit refusal, including ones a later successful edit never cleared.
 */
test('a stale refusal is shown inline in the inspector, without hiding the palette grid', async ({
  page,
}) => {
  const dir = path.join(tmp, 'MyHackStale')
  const { manifestPath } = await loadPalettes(page, dir)
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-swatch', { timeout: 15000 })
  await selectMarioRedSwatch(page)

  // Force a stale refusal directly: claim the cell still holds $1234 when it does not.
  const result = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(PaletteService)')
    return svc.setColor(mp, 0x00b2ce, '$1234', '$5678')
  }, manifestPath)
  expect(result.status).toBe('stale')

  await page.evaluate(async res => {
    const wm = getSvc('WidgetManager')
    const w = await wm.getOrCreateWidget('hackbench.palette-view')
    w.applyResult(res)
  }, result)
  await page.waitForTimeout(200)

  const notice = page.locator('#hackbench\\.palette-view .hb-palette-inspector-from-error')
  await expect(notice).toBeVisible()
  const noticeText = await notice.innerText()
  expect(noticeText).toContain('$00B2CE')
  expect(noticeText).toContain('$1234') // the value it expected
  expect(noticeText).toMatch(/\$391F/i) // the value actually there

  // The rest of the view is still fully there - not replaced by the error.
  const swatchCount = await page.locator('#hackbench\\.palette-view .hb-palette-swatch').count()
  expect(swatchCount).toBeGreaterThan(0)

  // And it clears on the next SUCCESSFUL edit rather than sticking forever.
  const hexField = page.locator('#hackbench\\.palette-view .hb-palette-inspector-hex')
  await hexField.fill('2000')
  await hexField.press('Enter')
  await page.waitForTimeout(300)
  expect(await notice.count()).toBe(0)
})

/**
 * Layout: the inspector (and the edit controls it holds) is pinned above
 * the group content and never scrolls with it, at both size extremes -
 * Player Palettes (shortest) and Shared Sprite Colors (tallest).
 */
test('the inspector is pinned above the content and does not move when the content scrolls', async ({
  page,
}) => {
  // Shrunk so the tallest group (10 rows) cannot possibly fit without
  // scrolling - the point of this test is the scroll behaviour itself, not
  // whichever height this test happens to run at by default.
  await page.setViewportSize({ width: 900, height: 480 })
  await loadPalettes(page, path.join(tmp, 'MyHack3'))
  await revealPalettes(page)
  await page.waitForSelector('#hackbench\\.palette-view .hb-palette-inspector', { timeout: 15000 })

  const panel = page.locator('#hackbench\\.palette-view')
  const inspector = page.locator('#hackbench\\.palette-view .hb-palette-inspector')
  const content = page.locator('#hackbench\\.palette-view .hb-palette-main')

  // Player Palettes (the shortest group) is active by default.
  const panelBox = await panel.boundingBox()
  const inspectorBoxShort = await inspector.boundingBox()
  const contentBoxShort = await content.boundingBox()
  expect(inspectorBoxShort.y - panelBox.y).toBeLessThan(40)
  expect(inspectorBoxShort.y).toBeLessThan(contentBoxShort.y)

  // Selecting a swatch when nothing was selected must not move the content
  // region's top: the empty and populated inspector are the same height.
  const swatch = page
    .locator('#hackbench\\.palette-view .hb-palette-variant')
    .first()
    .locator('.hb-palette-swatch:not(.hb-palette-swatch-unwritten)')
    .first()
  await swatch.click()
  await page.waitForTimeout(200)
  const contentBoxAfterSelect = await content.boundingBox()
  expect(Math.abs(contentBoxAfterSelect.y - contentBoxShort.y)).toBeLessThan(2)

  const inspectorBoxBeforeScroll = await inspector.boundingBox()

  // Switch to the tallest group and scroll its content under the inspector.
  await page.evaluate(() => {
    const nav = [...document.querySelectorAll('.hb-palette-nav-item')].find(n =>
      (n.textContent || '').includes('Shared Sprite Colors'),
    )
    nav.click()
  })
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    document.querySelector('#hackbench\\.palette-view .hb-palette-main').scrollTop = 300
  })
  await page.waitForTimeout(150)

  const scrollTop = await page.evaluate(
    () => document.querySelector('#hackbench\\.palette-view .hb-palette-main').scrollTop,
  )
  expect(scrollTop).toBeGreaterThan(0) // the content actually scrolled

  const inspectorBoxAfterScroll = await inspector.boundingBox()
  expect(Math.abs(inspectorBoxAfterScroll.y - inspectorBoxBeforeScroll.y)).toBeLessThan(2)
})
