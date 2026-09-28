/**
 * The Overworld view (en-gen/hackbench#363), end to end against the shell.
 *
 * The globe opens ONE main-area widget, and every path that shows the globe
 * does. The canvas is L2 (background) under L1 (foreground) at 1024x512 and
 * hashes to the pins the Vitest decode test also holds, per layer set: the
 * layer toggles and a refused L2 land on those same pins. A ROM whose L1
 * reader is not stock shows the reason and no canvas. The Map tab's L1
 * toggle, now the shared LayerToggle, is covered by map-view.spec.cjs.
 */
const { test, expect } = require('@playwright/test')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const {
  VANILLA_OVERWORLD_CANVAS_SHA256,
  VANILLA_OVERWORLD_L1_SHA256,
  VANILLA_OVERWORLD_L2_SHA256,
} = require('../../../test/suite/support/overworld-pin.cjs')
const { loromToOffset } = require('../../extension/lib/src/rom/addressing')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const GLOBE = '#shell-tab-hackbench\\.overworld-launcher'
const VIEW = '#theia-main-content-panel #hackbench\\.overworld-view'

/** LDX #OWL1TileData's opcode in CODE_04DC09 (bank_04.asm:5675), pinned by the reader. */
const L1_LDX_OPCODE = 0x04dc5a
/** `JSR CODE_04DABA`'s opcode for the high stream (bank_04.asm:5704), pinned by the L2 reader. */
const L2_JSR_OPCODE = 0x04dc99
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

/** Writes `rom` with `edit` applied to a copy in tmp, and returns its path. */
function plantedRom(name, edit) {
  const bytes = fs.readFileSync(ROM)
  edit(bytes)
  const file = path.join(tmp, name)
  fs.writeFileSync(file, bytes)
  return file
}

const leftExpanded = page => page.evaluate(() => getSvc('ApplicationShell').isExpanded('left'))
const overworldCount = page =>
  page.evaluate(
    () =>
      getSvc('ApplicationShell')
        .getWidgets('main')
        .filter(w => w.id === 'hackbench.overworld-view').length,
  )

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
  await expect.poll(() => leftExpanded(page)).toBe(false)

  // Move focus away, then click again: the same widget comes back, no second.
  await page.evaluate(() =>
    getSvc('CommandRegistry')
      .executeCommand('hackbench.gfx.focus')
      .then(() => undefined),
  )
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  expect(await overworldCount(page)).toBe(1)
  // The panel collapses before the view is activated, so this settles after the click.
  await expect
    .poll(() => page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id))
    .toBe('hackbench.overworld-view')
})

/** Closes the Overworld widget, so a reopen is observable. */
const closeOverworld = page =>
  page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('main')
      .find(w => w.id === 'hackbench.overworld-view')
      .close(),
  )

test('clicking the globe again, after it was last shown, reopens the view', async ({ page }) => {
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  await closeOverworld(page)
  await expect(page.locator(VIEW)).toHaveCount(0)
  // Before the fix, the globe stayed current and this click collapsed the panel.
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  await expect.poll(() => leftExpanded(page)).toBe(false)
  expect(await overworldCount(page)).toBe(1)
})

test('Toggle Left Panel with the globe last shown opens the view, not a blank sidebar', async ({
  page,
}) => {
  await page.locator(GLOBE).click()
  await expect(page.locator(VIEW)).toBeVisible()
  await closeOverworld(page)
  await page.evaluate(() => getSvc('CommandRegistry').executeCommand('core.toggle.left.panel'))
  await expect(page.locator(VIEW)).toBeVisible()
  await expect.poll(() => leftExpanded(page)).toBe(false)
  await expect(page.locator('#hackbench\\.overworld-launcher')).toBeHidden()
})

test('closing Maps neither opens the Overworld nor leaves a blank globe panel', async ({
  page,
}) => {
  // Maps current with no previous tab, so closing it falls back to the tab at
  // its index, the globe ('select-previous-tab' with no previous title).
  await page.evaluate(async () => {
    const shell = getSvc('ApplicationShell')
    await shell.collapsePanel('left')
    await shell.activateWidget('hackbench.map-explorer')
  })
  await expect.poll(() => leftExpanded(page)).toBe(true)
  await page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('left')
      .find(w => w.id === 'hackbench.map-explorer')
      .close(),
  )
  await page.waitForTimeout(500)
  expect(await overworldCount(page)).toBe(0)
  await expect(page.locator(VIEW)).toHaveCount(0)
  await expect(page.locator('#hackbench\\.overworld-launcher')).toBeHidden()
})

test('the command is on the View menu and opens the same widget', async ({ page }) => {
  await page.locator('.lm-MenuBar-itemLabel', { hasText: /^View$/ }).click()
  await page.locator('.lm-Menu .lm-Menu-item', { hasText: /^Overworld/ }).click()
  await expect(page.locator(VIEW)).toBeVisible()
})

test('on vanilla the canvas is 1024x512 and hashes to the pinned vanilla canvas', async ({
  page,
}) => {
  await openProject(page, ROM)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  const got = await canvasSha(page)
  expect([got.width, got.height]).toEqual([1024, 512])
  expect(got.sha).toBe(VANILLA_OVERWORLD_CANVAS_SHA256)
  await expect(page.locator('.hb-overworld-note')).toContainText(
    /Map data before any event.*right half may differ in game/,
  )
  await expect(page.locator('.hb-overworld-reason')).toHaveCount(0)
  await expect(page.locator('.hb-overworld-l2-reason')).toHaveCount(0)
})

test('a one-tile edit draws a canvas that differs from the pin', async ({ page }) => {
  const planted = plantedRom('planted.sfc', bytes => {
    bytes[fileOffset(bytes, 0x0cf7df + OPAQUE_CELL)] = 0
  })
  await openProject(page, planted)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  expect((await canvasSha(page)).sha).not.toBe(VANILLA_OVERWORLD_CANVAS_SHA256)
})

test('a ROM whose L2 reader is not stock draws L1 alone and says why', async ({ page }) => {
  const planted = plantedRom('no-l2.sfc', bytes => {
    bytes[fileOffset(bytes, L2_JSR_OPCODE)] ^= 0xff
  })
  await openProject(page, planted)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await expect(page.locator('.hb-overworld-l2-reason')).toContainText(
    /^L2 \(background\) unavailable: the L2 decompressor is not stock: \$04DC91/,
  )
  await page.waitForTimeout(500)
  const got = await canvasSha(page)
  expect([got.width, got.height]).toEqual([1024, 512])
  // Exactly the L1-alone canvas: every L1 pixel drawn, the backdrop where L2 would be.
  expect(got.sha).toBe(VANILLA_OVERWORLD_L1_SHA256)
  await expect(page.locator('[data-control="layer-l2"]')).toBeDisabled()
})

test('each layer toggle hides its layer, and toggling back restores the pin', async ({ page }) => {
  await openProject(page, ROM)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  expect((await canvasSha(page)).sha).toBe(VANILLA_OVERWORLD_CANVAS_SHA256)
  const view = page.locator(VIEW)
  for (const [control, alone] of [
    ['layer-l2', VANILLA_OVERWORLD_L1_SHA256],
    ['layer-l1', VANILLA_OVERWORLD_L2_SHA256],
  ]) {
    const button = view.locator(`[data-control="${control}"]`)
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    // The other layer alone: the pixels changed, to that layer's own pin.
    await expect.poll(async () => (await canvasSha(page)).sha).toBe(alone)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => (await canvasSha(page)).sha).toBe(VANILLA_OVERWORLD_CANVAS_SHA256)
  }
})

test('the L3 (overlay) toggle is disabled and says why', async ({ page }) => {
  await openProject(page, ROM)
  await page.locator(GLOBE).click()
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  const l3 = page.locator(`${VIEW} [data-control="layer-l3"]`)
  await expect(l3).toBeDisabled()
  await expect(l3).toHaveAttribute('title', 'L3 (overlay) not drawn yet')
  await expect(l3).toHaveAttribute('aria-pressed', 'false')
  // The icon marks the top bar: three bars, only the first in the button's color.
  const ys = await l3
    .locator('svg rect[data-on="true"]')
    .evaluateAll(rs => rs.map(r => r.getAttribute('y')))
  expect(ys).toEqual(['1'])
  const before = (await canvasSha(page)).sha
  await l3.click({ force: true })
  expect((await canvasSha(page)).sha).toBe(before)
})

test('a ROM whose L1 reader is not stock shows the reason and no canvas', async ({ page }) => {
  const planted = plantedRom('refused.sfc', bytes => {
    bytes[fileOffset(bytes, L1_LDX_OPCODE)] ^= 0xff
  })
  await openProject(page, planted)
  await page.locator(GLOBE).click()
  await expect(page.locator('.hb-overworld-reason')).toContainText(
    /not stock: \$04DC4C .* holds (?:\S+ ){14}5d /,
  )
  await expect(page.locator('.hb-overworld-canvas')).toHaveCount(0)
})
