/**
 * The map tab draws the L1 (foreground), en-gen/hackbench#421 step 3.
 *
 * Every assertion reads PIXELS back from the tab's canvases, never the mere
 * presence of one: a blank canvas is on screen too. Each screen is its own
 * canvas (`[data-screen=N]`), drawn at native resolution, and carries
 * `data-drawn="<palaces>:<screen>"` once the backend's reply for the
 * current switch-palace state is painted, which is what the waits key on.
 *
 * Measured on the vanilla ROM by expanding $105 with and without the yellow
 * palace pressed (map-screen's unit test pins the same cells): exactly five
 * cells change, one of them column 156, row 20, which is screen 9, local
 * column 12. $106 has its own at column 39, row 20 (screen 2, column 7).
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords } = require('./rom-words.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

/**
 * ForegroundPalettes variant 0, row 2 color 2 (PaletteLoader ADDR_FG_PAIR,
 * bank_00.asm:6141). Found by changing each palette word in turn and
 * keeping one that moves pixels on $105's first screen, so the edit below
 * cannot pass by recoloring a color the map never draws.
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
  await page.waitForSelector(`${root(index)} canvas[data-screen="0"][data-drawn]`, { timeout: 30000 }) // prettier-ignore
}

async function activate(page, index) {
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, `hackbench.map-view:${index}`)
  await page.waitForTimeout(300)
}

/** The palace key a screen is drawn for: yellow, green, red, blue bits. */
const drawnKey = (screen, yellow = false) => `${yellow ? 1 : 0}000:${screen}`

/** Scrolls a screen into view and waits until it is painted for `key`. */
async function showScreen(page, index, screen, key = drawnKey(screen)) {
  const sel = `${root(index)} canvas[data-screen="${screen}"]`
  await page.locator(sel).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
  await expect(page.locator(sel)).toHaveAttribute('data-drawn', key, { timeout: 15000 })
}

/** One screen's pixels: a positional checksum, distinct colors, and per-cell checksums. */
async function readScreen(page, index, screen) {
  return page.evaluate(
    sel => {
      const c = document.querySelector(sel)
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const distinct = new Set()
      for (let i = 0; i < data.length; i += 4) distinct.add(data.slice(i, i + 4).join(','))
      const cells = {}
      for (let cy = 0; cy < c.height / 16; cy++)
        for (let cx = 0; cx < c.width / 16; cx++) {
          const cell = c.getContext('2d').getImageData(cx * 16, cy * 16, 16, 16).data
          cells[`${cx},${cy}`] = checksumOf(cell)
        }
      return { checksum: checksumOf(data), distinct: distinct.size, cells }
    },
    `${root(index)} canvas[data-screen="${screen}"]`,
  )
}

const changedCells = (a, b) => Object.keys(a.cells).filter(k => a.cells[k] !== b.cells[k])

test('opening a map draws real pixels, and two maps differ', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const a = await readScreen(page, 0x105, 0)
  // Not uniform: a blank or single-color canvas would pass a presence check.
  expect(a.distinct).toBeGreaterThan(4)

  await openMap(page, project.manifestPath, 0x106)
  const b = await readScreen(page, 0x106, 0)
  expect(b.distinct).toBeGreaterThan(4)
  expect(b.checksum).not.toBe(a.checksum)
})

test('a palette edit repaints the open map, with no reload', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const before = await readScreen(page, 0x105, 0)

  // The word the ROM holds now, read from the file rather than assumed.
  const rom = fs.readFileSync(ROM)
  const base = rom.length % 1024 === 512 ? 512 : 0
  const at = base + (FG_COLOR_ADDR & 0x7fff)
  const oldWord = rom[at] | (rom[at + 1] << 8)
  const oldHex = '$' + oldWord.toString(16).toUpperCase().padStart(4, '0')
  expect(oldHex).not.toBe(NEW_HEX)

  const result = await page.evaluate(
    async ({ mp, addr, oldHex, newHex }) =>
      getSvc('Symbol(PaletteService)').setColor(mp, addr, oldHex, newHex),
    { mp: project.manifestPath, addr: FG_COLOR_ADDR, oldHex, newHex: NEW_HEX },
  )
  expect(result.status).toBe('ok')

  // No open() or refresh here: the working-copy push must repaint it.
  await expect
    .poll(async () => (await readScreen(page, 0x105, 0)).checksum, { timeout: 15000 })
    .not.toBe(before.checksum)
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
  await showScreen(page, 0x105, 9, drawnKey(9, true))
  const after = await readScreen(page, 0x105, 9)

  // Column 156 is screen 9's local column 12; nothing else on it moves,
  // including a far cell on the same row.
  expect(changedCells(before, after)).toEqual(['12,20'])
  expect(after.cells['0,20']).toBe(before.cells['0,20'])

  // And back: toggling off restores the original pixels.
  await yellow.click()
  await showScreen(page, 0x105, 9, drawnKey(9))
  expect((await readScreen(page, 0x105, 9)).checksum).toBe(before.checksum)
})

test('two map tabs keep their own palaces', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x106)
  await showScreen(page, 0x106, 2)
  const other = await readScreen(page, 0x106, 2)

  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="palace-yellow"]`).click()
  await showScreen(page, 0x105, 9, drawnKey(9, true))

  await activate(page, 0x106)
  await expect(page.locator(`${root(0x106)} [data-control="palace-yellow"]`)).toHaveAttribute(
    'aria-pressed',
    'false',
  )
  // $106's own yellow block (screen 2, column 7, row 20) is still unpressed.
  await expect(page.locator(`${root(0x106)} canvas[data-screen="2"]`)).toHaveAttribute(
    'data-drawn',
    drawnKey(2),
  )
  const still = await readScreen(page, 0x106, 2)
  expect(still.cells['7,20']).toBe(other.cells['7,20'])
  // Pressing yellow HERE changes this tab's block, proving the cell is live.
  await page.locator(`${root(0x106)} [data-control="palace-yellow"]`).click()
  await showScreen(page, 0x106, 2, drawnKey(2, true))
  expect(changedCells(still, await readScreen(page, 0x106, 2))).toEqual(['7,20'])
})

test('the header panel opens and shows the decode beside its ROM bytes', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  const panel = page.locator(`${root(0x105)} [data-control="header-panel"]`)
  const table = panel.locator('.hb-map-view-table')
  await expect(table).toBeHidden()

  await panel.locator('summary').click()
  await expect(panel).toHaveJSProperty('open', true)
  await expect(table).toBeVisible()
  await expect(panel.locator('.hb-map-view-raw code')).toHaveText(/^([0-9A-F]{2} ){4}[0-9A-F]{2}$/)

  // The decoded screen count is the one the strip was sized from.
  const screensRow = panel.locator('tr', { hasText: 'Screens' }).locator('td')
  const canvases = await page.locator(`${root(0x105)} canvas[data-screen]`).count()
  await expect(screensRow).toHaveText(String(canvases))
  expect(canvases).toBe(20)
})

test('the map tab speaks of ROMs, never cartridges', async ({ page }) => {
  const project = await createProject(page, path.join(tmp, 'MyHack'))
  await openMap(page, project.manifestPath, 0x105)
  await page.locator(`${root(0x105)} [data-control="header-panel"] summary`).click()
  const words = await shownWords(page, root(0x105))
  expect(words).toMatch(/Switch palaces/)
  expect(words).not.toMatch(CART)
})
