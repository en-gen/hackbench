/**
 * The Overworld view (#676), end to end against the shell.
 *
 * The globe opens ONE main-area widget; the canvas is the whole L1 grid at
 * 1024x512; its pixels match the decode computed here in node from the ROM
 * file, outside the RPC, base64 and canvas path the view takes; a ROM whose
 * L1 reader is not stock shows the reason and no canvas.
 */
const { test, expect } = require('@playwright/test')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const { RomFile } = require('../../extension/lib/src/rom/RomFile')
const { SmwRom } = require('../../extension/lib/src/rom/SmwRom')
const { loromToOffset } = require('../../extension/lib/src/rom/addressing')
const {
  decodeOverworldL1,
} = require('../../extension/lib/theia/extension/src/node/overworld-decode')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const GLOBE = '#shell-tab-hackbench\\.overworld-launcher'
const VIEW = '#theia-main-content-panel #hackbench\\.overworld-view'

/** LDX #OWL1TileData's opcode in CODE_04DC09 (bank_04.asm:5675), pinned by the reader. */
const L1_LDX_OPCODE = 0x04dc5a
/** Tile data byte for grid (row 1, col 55): map16ByteOffset(1, 1, 23). Opaque on vanilla. */
const OPAQUE_CELL = 0x517

/** File offset of a SNES address in `bytes`, copier header included. */
function fileOffset(bytes, snes) {
  const header = bytes.length % 1024 === 512
  return loromToOffset(snes, bytes.length - (header ? 512 : 0), header)
}

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-overworld-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Creates and opens a project on `rom`, as File > New Project leaves it. */
async function openProject(page, rom) {
  return page.evaluate(
    async ({ romPath, directory }) => {
      const projects = getSvc('Symbol(ProjectService)')
      const created = await projects.createProject({ romPath, name: 'MyHack', directory })
      getSvc('ProjectContext').current = await projects.openProject(created.manifestPath)
      return created.manifestPath
    },
    { romPath: rom, directory: path.join(tmp, 'MyHack') },
  )
}

/** SHA-256 of the canvas's RGBA, read back from the page. */
async function canvasSha(page) {
  const { width, height, bytes } = await page.evaluate(() => {
    const canvas = document.querySelector('.hb-overworld-canvas')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let s = ''
    for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i])
    return { width: canvas.width, height: canvas.height, bytes: btoa(s) }
  })
  const sha = createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex')
  return { width, height, sha }
}

function expectedSha(file) {
  const dto = decodeOverworldL1(new SmwRom(RomFile.load(file)))
  if (dto.status !== 'ok') throw new Error(dto.reason)
  return createHash('sha256').update(Buffer.from(dto.rgbaBase64, 'base64')).digest('hex')
}

test('the globe sits after Maps and before Graphics in the activity bar', async ({ page }) => {
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#theia-left-content-panel .lm-TabBar-tab')].map(t => t.id),
  )
  const at = id => ids.indexOf(`shell-tab-${id}`)
  expect(at('hackbench.overworld-launcher')).toBeGreaterThan(at('hackbench.map-explorer'))
  expect(at('hackbench.overworld-launcher')).toBeLessThan(at('hackbench.gfx-explorer'))
  await expect(page.locator(`${GLOBE} .codicon-globe`)).toHaveCount(1)
})

test('clicking the globe opens one Overworld widget in the main area; again focuses it', async ({
  page,
}) => {
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  const title = await page
    .locator('#theia-main-content-panel .lm-TabBar-tab.lm-mod-current')
    .innerText()
  expect(title).toMatch(/Overworld/)
  // The sidebar slot holds nothing: the left panel collapses.
  expect(await page.evaluate(() => getSvc('ApplicationShell').isExpanded('left'))).toBe(false)

  // Move focus away, then click again: the same widget comes back, no second.
  await page.evaluate(() => getSvc('CommandRegistry').executeCommand('hackbench.gfx.focus'))
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  const count = await page.evaluate(
    () =>
      getSvc('ApplicationShell')
        .getWidgets('main')
        .filter(w => w.id === 'hackbench.overworld-view').length,
  )
  expect(count).toBe(1)
  expect(await page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id)).toBe(
    'hackbench.overworld-view',
  )
})

test('the command is on the View menu and opens the same widget', async ({ page }) => {
  await page.locator('.lm-MenuBar-itemLabel', { hasText: /^View$/ }).click()
  await page.locator('.lm-Menu .lm-Menu-item', { hasText: /^Overworld/ }).click()
  await expect(page.locator(VIEW)).toBeVisible()
})

test('on vanilla the canvas is 1024x512 and matches the decode computed from the ROM', async ({
  page,
}) => {
  await openProject(page, ROM)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  const got = await canvasSha(page)
  expect([got.width, got.height]).toEqual([1024, 512])
  expect(got.sha).toBe(expectedSha(ROM))
  await expect(page.locator('.hb-overworld-note')).toContainText(/colors outside it may be wrong/)
  await expect(page.locator('.hb-overworld-reason')).toHaveCount(0)

  // A planted defect: the same comparison against a different ROM must fail.
  const planted = path.join(tmp, 'planted.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[fileOffset(bytes, 0x0cf7df + OPAQUE_CELL)] = 0
  fs.writeFileSync(planted, bytes)
  expect(expectedSha(planted)).not.toBe(got.sha)
})

test('a ROM whose L1 reader is not stock shows the reason and no canvas', async ({ page }) => {
  const planted = path.join(tmp, 'refused.sfc')
  const bytes = fs.readFileSync(ROM)
  bytes[fileOffset(bytes, L1_LDX_OPCODE)] ^= 0xff
  fs.writeFileSync(planted, bytes)

  await openProject(page, planted)
  await page.locator(GLOBE).click()
  await expect(page.locator('.hb-overworld-reason')).toContainText(/not stock at \$04DC57/)
  await expect(page.locator('.hb-overworld-canvas')).toHaveCount(0)
})
