/**
 * The Overworld view (en-gen/hackbench#363) and the area tabs (#364 part B), end to end
 * against the shell.
 *
 * The Overworld row in the map explorer (#432) opens ONE main-area widget: the hub, a
 * single 512x512 canvas (half 0) that hashes to its pin, which the Vitest decode test also
 * holds, per layer set: the layer toggles and a refused L2 land on those same pins. The
 * Area 1..6 rows under it each open their own 256x224 tab. A ROM whose L1 reader is not
 * stock shows the reason and no canvas. The Map tab's L1 toggle, now the shared
 * LayerToggle, is covered by map-view.spec.cjs.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const {
  VANILLA_OVERWORLD_HUB_SHA256: HUB,
  VANILLA_OVERWORLD_AREA_SHA256: AREA_PIN,
} = require('../../../test/suite/support/overworld-pin.cjs')
const { loromToOffset } = require('../../extension/lib/src/rom/addressing')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const EXPLORER = '#hackbench\\.map-explorer'
// Theia also puts data-node-id on a row's expansion chevron, so name the row itself.
const NODE = id => `${EXPLORER} .theia-TreeNode[data-node-id="${id}"]`
const ROW = NODE('overworld')
// Every Overworld widget (preview or pinned) carries hb-overworld-view and its data-area.
const AREA_VIEW = n => `#theia-main-content-panel .hb-overworld-view[data-area="${n}"]`
const VIEW = AREA_VIEW(0)
const AREA_ROW = n => NODE(`overworld/area:${n}`)

/** LDX #OWL1TileData's opcode in CODE_04DC09 (bank_04.asm:5675), pinned by the reader. */
const L1_LDX_OPCODE = 0x04dc5a
/** `JSR CODE_04DABA`'s opcode for the high stream (bank_04.asm:5704), pinned by the L2 reader. */
const L2_JSR_OPCODE = 0x04dc99
/** The camera read's first opcode, `ASL A` (bank_00.asm:4324), the first byte of the derivation's pattern. */
const CAMERA_READ_OPCODE = 0x00a130
/** DATA_04849D, the warp destination words (bank_04.asm:554-581). */
const WARP_DEST_TABLE = 0x04849d
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
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
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
      // Setting the context does not load the explorer; load it as map-groups.spec does.
      const explorer = await getWidget('hackbench.map-explorer')
      await explorer.load(created.manifestPath)
      await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
      return created.manifestPath
    },
    { romPath: rom, directory: path.join(tmp, 'MyHack') },
  )
}

/** Skips without the ROM, opens a project on it, and waits for the Overworld row. */
async function openVanillaWithRow(page) {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await page.waitForSelector(ROW, { timeout: 15000 })
}

/** SHA-256 of the canvas inside `scope`, hashed in the page. */
const canvasSha = (page, scope) =>
  page.evaluate(async sel => {
    const c = document.querySelector(`${sel} .hb-overworld-canvas`)
    const rgba = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    const digest = await crypto.subtle.digest('SHA-256', rgba)
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  }, scope)
const hubSha = page => canvasSha(page, VIEW)

/** Writes `rom` with `edit` applied to a copy in tmp, and returns its path. */
function plantedRom(name, edit) {
  const bytes = fs.readFileSync(ROM)
  edit(bytes)
  const file = path.join(tmp, name)
  fs.writeFileSync(file, bytes)
  return file
}

const overworldIds = page =>
  page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('main')
      .map(w => w.id)
      .filter(id => id.startsWith('hackbench.overworld-')),
  )
const previewIds = async page => (await overworldIds(page)).filter(id => id.endsWith(':preview'))
const pinnedIds = async page => (await overworldIds(page)).filter(id => !id.endsWith(':preview'))
const areaTabCount = async page =>
  (await pinnedIds(page)).filter(id => id.startsWith('hackbench.overworld-area-view:')).length
const leftExpanded = page => page.evaluate(() => getSvc('ApplicationShell').isExpanded('left'))
const activeId = page => page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id)

/** Opens the Overworld the way a map row opens: double-click, which always fires. */
async function openOverworldRow(page) {
  await page.locator(ROW).dblclick()
}

/** Closes the pinned hub tab, so a reopen is observable. */
const closeOverworld = page =>
  page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('main')
      .find(w => w.id === 'hackbench.overworld-view')
      .close(),
  )

test('the activity bar has no Overworld or globe entry', async ({ page }) => {
  const ids = await page.evaluate(() =>
    [...document.querySelectorAll('#theia-left-content-panel .lm-TabBar-tab')].map(t => t.id),
  )
  expect(ids.filter(id => /overworld/i.test(id))).toEqual([])
  await expect(page.locator('#theia-left-content-panel .codicon-globe')).toHaveCount(0)
})

test('the explorer starts Title Screen, New Game, Overworld, then the groups', async ({ page }) => {
  await openVanillaWithRow(page)
  const top = await page.evaluate(sel => {
    const rows = [...document.querySelectorAll(`${sel} .theia-TreeNode`)]
    return rows.slice(0, 4).map(r => r.getAttribute('data-node-id'))
  }, EXPLORER)
  expect(top.slice(0, 3)).toEqual([
    expect.stringMatching(/^special:title-screen:/),
    expect.stringMatching(/^special:new-game:/),
    'overworld',
  ])
  // The areas the ROM names are the Overworld row's children.
  expect(top[3]).toBe('overworld/area:1')
  // No hex slot label, a globe icon, and not draggable.
  await expect(page.locator(`${ROW} .hb-map-slot`)).toHaveCount(0)
  await expect(page.locator(`${ROW} .codicon-globe`)).toHaveCount(1)
  await expect(page.locator(ROW)).not.toHaveAttribute('draggable', 'true')
})

test('double-clicking the Overworld row pins one tab; again focuses it; closed, it reopens', async ({
  page,
}) => {
  await openVanillaWithRow(page)
  await openOverworldRow(page)
  await expect(page.locator(VIEW)).toBeVisible()
  // The double-click's own single click previewed it; the pin retired that preview.
  await expect.poll(() => overworldIds(page)).toEqual(['hackbench.overworld-view'])

  // Move focus to the map explorer, then double-click again: the same tab, no second.
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  })
  await openOverworldRow(page)
  await expect.poll(() => activeId(page)).toBe('hackbench.overworld-view')
  expect(await overworldIds(page)).toEqual(['hackbench.overworld-view'])

  // After the tab is closed, the row reopens it.
  await closeOverworld(page)
  await expect(page.locator(VIEW)).toHaveCount(0)
  await openOverworldRow(page)
  await expect(page.locator(VIEW)).toBeVisible()
  expect(await pinnedIds(page)).toEqual(['hackbench.overworld-view'])
})

test('double-clicking Overworld opens it without folding its Area rows', async ({ page }) => {
  await openVanillaWithRow(page)
  await expect(page.locator(AREA_ROW(1))).toBeVisible()
  await openOverworldRow(page)
  await expect(page.locator(VIEW)).toBeVisible()
  for (const n of [1, 2, 3, 4, 5, 6]) await expect(page.locator(AREA_ROW(n))).toBeVisible()
  // The chevron still toggles.
  await page.locator(`${ROW} .theia-ExpansionToggle`).click()
  await expect(page.locator(AREA_ROW(1))).toHaveCount(0)
})

test('a single click on an Area row previews it in one shared tab; a double-click pins it', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await page.waitForSelector(AREA_ROW(2), { timeout: 15000 })
  await page.locator(AREA_ROW(2)).click()
  await expect(page.locator(AREA_VIEW(2))).toBeVisible()
  expect(await previewIds(page)).toEqual(['hackbench.overworld-view:preview'])
  expect(await pinnedIds(page)).toEqual([])
  // Focus stays in the list so the arrows keep walking it.
  await expect.poll(() => activeId(page)).toBe('hackbench.map-explorer')

  // Another row reuses the same preview tab.
  await page.locator(AREA_ROW(5)).click()
  await expect(page.locator(AREA_VIEW(5))).toBeVisible()
  await expect(page.locator(AREA_VIEW(2))).toHaveCount(0)
  expect(await previewIds(page)).toEqual(['hackbench.overworld-view:preview'])

  // The hub row shares that slot too.
  await page.locator(ROW).click()
  await expect(page.locator(VIEW)).toBeVisible()
  expect(await previewIds(page)).toEqual(['hackbench.overworld-view:preview'])

  // A double-click pins the area and retires a preview that showed it.
  await page.locator(AREA_ROW(5)).click()
  await expect(page.locator(AREA_VIEW(5))).toBeVisible()
  await page.locator(AREA_ROW(5)).dblclick()
  await expect.poll(() => overworldIds(page)).toEqual(['hackbench.overworld-area-view:5'])
})

test('the Overworld and area views zoom: stepper, canvas CSS size, bitmap untouched', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await page.waitForSelector(AREA_ROW(1), { timeout: 15000 })
  await page.locator(AREA_ROW(1)).dblclick()
  await openOverworldRow(page)
  for (const [view, w, h] of [
    [AREA_VIEW(1), 256, 224],
    [VIEW, 512, 512],
  ]) {
    await page.waitForSelector(`${view} .hb-overworld-canvas`, { timeout: 30000 })
    const canvas = page.locator(`${view} .hb-overworld-canvas`)
    const size = () => canvas.evaluate(c => [c.width, c.height, c.getBoundingClientRect().width])
    const [bw, bh, shown] = await size()
    expect([bw, bh]).toEqual([w, h])
    await page.locator(`${view} [data-control="zoom-in"]`).click()
    await expect(page.locator(`${view} [data-control="zoom-indicator"]`)).toHaveText('2x')
    await expect.poll(async () => Math.round((await size())[2])).toBe(Math.round(shown * 2))
    expect((await size()).slice(0, 2)).toEqual([w, h])
  }
})

test('the views carry no "map data before any event" note', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await openOverworldRow(page)
  await page.waitForSelector(`${VIEW} .hb-overworld-canvas`, { timeout: 30000 })
  await expect(page.locator('.hb-overworld-note')).toHaveCount(0)
})

test('opening the row keeps the explorer visible, and it survives an activity switch', async ({
  page,
}) => {
  await openVanillaWithRow(page)
  await openOverworldRow(page)
  await expect(page.locator(VIEW)).toBeVisible()
  await expect.poll(() => leftExpanded(page)).toBe(true)
  await expect(page.locator(EXPLORER)).toBeVisible()
  // Click the activity-bar tabs as a user would.
  await page.locator('#shell-tab-hackbench\\.gfx-explorer').click()
  await expect(page.locator(EXPLORER)).toBeHidden()
  await page.locator('#shell-tab-hackbench\\.map-explorer').click()
  await expect.poll(() => leftExpanded(page)).toBe(true)
  await expect(page.locator(EXPLORER)).toBeVisible()
})

test('the command is on the View menu and opens the same widget', async ({ page }) => {
  await page.locator('.lm-MenuBar-itemLabel', { hasText: /^View$/ }).click()
  await page.locator('.lm-Menu .lm-Menu-item', { hasText: /^Overworld/ }).click()
  await expect(page.locator(VIEW)).toBeVisible()
})

test('on vanilla the hub is one 512x512 canvas that hashes to its pin', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await openOverworldRow(page)
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  const canvases = page.locator(`${VIEW} .hb-overworld-canvas`)
  await expect(canvases).toHaveCount(1)
  expect(await canvases.evaluate(c => [c.width, c.height])).toEqual([512, 512])
  // Displayed width is 512 (a scale transform goes red).
  expect((await canvases.boundingBox()).width).toBeCloseTo(512, 0)
  expect(await hubSha(page)).toBe(HUB.BOTH)
  await expect(page.locator('.hb-overworld-reason')).toHaveCount(0)
  await expect(page.locator('.hb-overworld-l2-reason')).toHaveCount(0)
  // Foreground off changes the pixels.
  await page.locator(`${VIEW} [data-control="layer-l1"]`).click()
  await expect.poll(() => hubSha(page)).not.toBe(HUB.BOTH)
})

test('the explorer shows Area 1..Area 6 under Overworld on vanilla', async ({ page }) => {
  await openVanillaWithRow(page)
  const rows = await page.evaluate(sel => {
    return [...document.querySelectorAll(`${sel} .theia-TreeNode[data-node-id^="overworld/"]`)].map(
      r => [r.getAttribute('data-node-id'), r.textContent.trim()],
    )
  }, EXPLORER)
  expect(rows).toEqual([1, 2, 3, 4, 5, 6].map(n => [`overworld/area:${n}`, `Area ${n}`]))
  await expect(page.locator(AREA_ROW(1))).not.toHaveClass(/hb-map-row-orphan/)
})

test('activating Area 2 opens a 256x224 tab; Area 5 opens a second; reopening focuses', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await page.waitForSelector(AREA_ROW(2), { timeout: 15000 })
  await page.locator(AREA_ROW(2)).dblclick()
  await expect(page.locator(AREA_VIEW(2))).toBeVisible()
  await page.waitForSelector(`${AREA_VIEW(2)} .hb-overworld-canvas`, { timeout: 30000 })
  await page.waitForTimeout(500)
  expect(
    await page.locator(`${AREA_VIEW(2)} .hb-overworld-canvas`).evaluate(c => [c.width, c.height]),
  ).toEqual([256, 224])
  expect(await canvasSha(page, AREA_VIEW(2))).toBe(AREA_PIN[2].BOTH)
  await expect(page.locator(`${AREA_VIEW(2)} .hb-gfx-view-title`)).toHaveText('Area 2')

  await page.locator(AREA_ROW(5)).dblclick()
  await expect(page.locator(AREA_VIEW(5))).toBeVisible()
  await page.waitForSelector(`${AREA_VIEW(5)} .hb-overworld-canvas`, { timeout: 30000 })
  await page.waitForTimeout(500)
  expect(await canvasSha(page, AREA_VIEW(5))).toBe(AREA_PIN[5].BOTH)
  expect(await areaTabCount(page)).toBe(2)

  // Move focus back to the explorer, then activate Area 2 again: the same tab, no third.
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  })
  await page.locator(AREA_ROW(2)).dblclick()
  await expect
    .poll(() => page.evaluate(() => getSvc('ApplicationShell').activeWidget?.id))
    .toBe('hackbench.overworld-area-view:2')
  expect(await areaTabCount(page)).toBe(2)
})

test('an area tab toggles Foreground, and its Effects toggle is disabled with a reason', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await page.waitForSelector(AREA_ROW(1), { timeout: 15000 })
  await page.locator(AREA_ROW(1)).dblclick()
  await page.waitForSelector(`${AREA_VIEW(1)} .hb-overworld-canvas`, { timeout: 30000 })
  await page.waitForTimeout(500)
  const l3 = page.locator(`${AREA_VIEW(1)} [data-control="layer-l3"]`)
  await expect(l3).toBeDisabled()
  await expect(l3).toHaveAttribute('title', 'Effects not drawn yet')
  expect(await canvasSha(page, AREA_VIEW(1))).toBe(AREA_PIN[1].BOTH)
  await page.locator(`${AREA_VIEW(1)} [data-control="layer-l1"]`).click()
  await expect.poll(() => canvasSha(page, AREA_VIEW(1))).toBe(AREA_PIN[1].L2)
  await page.locator(`${AREA_VIEW(1)} [data-control="layer-l1"]`).click()
  await page.locator(`${AREA_VIEW(1)} [data-control="layer-l2"]`).click()
  await expect.poll(() => canvasSha(page, AREA_VIEW(1))).toBe(AREA_PIN[1].L1)
})

test('a one-tile edit in half 1 redraws the area that shows it, and leaves the hub alone', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  const planted = plantedRom('planted.sfc', bytes => {
    bytes[fileOffset(bytes, 0x0cf7df + OPAQUE_CELL)] = 0
  })
  await openProject(page, planted)
  await openOverworldRow(page)
  await page.waitForSelector(`${VIEW} .hb-overworld-canvas`, { timeout: 30000 })
  await page.waitForTimeout(500)
  expect(await hubSha(page)).toBe(HUB.BOTH)
  // Grid column 55 is half-1 column 23, row 1: pixels (368..383, 16..31), inside Area 4's window.
  await page.locator(AREA_ROW(4)).dblclick()
  await page.waitForSelector(`${AREA_VIEW(4)} .hb-overworld-canvas`, { timeout: 30000 })
  await page.waitForTimeout(500)
  expect(await canvasSha(page, AREA_VIEW(4))).not.toBe(AREA_PIN[4].BOTH)
})

test('a refused derivation shows no area rows and says why on the Overworld row', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  // The first opcode of the camera read (bank_00.asm:4324), pinned by the derivation.
  const planted = plantedRom('no-areas.sfc', bytes => {
    bytes[fileOffset(bytes, CAMERA_READ_OPCODE)] ^= 0xff
  })
  await openProject(page, planted)
  await page.waitForSelector(ROW, { timeout: 15000 })
  await expect(page.locator(`${EXPLORER} [data-node-id^="overworld/area:"]`)).toHaveCount(0)
  await expect(page.locator(ROW)).toHaveAttribute('title', /^Areas unavailable: .*camera read/)
  // The hub still draws.
  await openOverworldRow(page)
  await page.waitForSelector(`${VIEW} .hb-overworld-canvas`, { timeout: 30000 })
})

test('an area past the camera table keeps a marked row with its reason and opens nothing', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  // Warp record 26 (live: its source is area 1) now leads to area 9: bits 9-12 of the high byte.
  const planted = plantedRom('area-9.sfc', bytes => {
    const hi = fileOffset(bytes, WARP_DEST_TABLE + 2 * 26 + 1)
    bytes[hi] = (bytes[hi] & 1) | (9 << 1)
  })
  await openProject(page, planted)
  await page.waitForSelector(AREA_ROW(9), { timeout: 15000 })
  await expect(page.locator(AREA_ROW(9))).toHaveAttribute(
    'title',
    /warp record 26 leads to area 9, past the camera table's 7 entries/,
  )
  await expect(page.locator(AREA_ROW(9))).toHaveClass(/hb-map-row-orphan/)
  await expect(page.locator(`${AREA_ROW(9)} .codicon-warning`)).toHaveCount(1)
  await page.locator(AREA_ROW(9)).dblclick()
  await page.waitForTimeout(1000)
  await expect(page.locator(AREA_VIEW(9))).toHaveCount(0)
  expect(await areaTabCount(page)).toBe(0)
})

test('a ROM whose L2 reader is not stock draws L1 alone and says why', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  const planted = plantedRom('no-l2.sfc', bytes => {
    bytes[fileOffset(bytes, L2_JSR_OPCODE)] ^= 0xff
  })
  await openProject(page, planted)
  await openOverworldRow(page)
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await expect(page.locator('.hb-overworld-l2-reason')).toContainText(
    /^Background unavailable: the L2 decompressor is not stock: \$04DC91/,
  )
  await page.waitForTimeout(500)
  expect(await page.$$eval('.hb-overworld-canvas', cs => cs.map(c => [c.width, c.height]))).toEqual(
    [[512, 512]],
  )
  // Exactly the L1-alone canvas: every L1 pixel drawn, the backdrop where L2 would be.
  expect(await hubSha(page)).toBe(HUB.L1)
  await expect(page.locator('[data-control="layer-l2"]')).toBeDisabled()
})

test('each layer toggle hides its layer, and toggling back restores the pin', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await openOverworldRow(page)
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  await page.waitForTimeout(500)
  expect(await hubSha(page)).toBe(HUB.BOTH)
  const view = page.locator(VIEW)
  for (const [control, alone] of [
    ['layer-l2', HUB.L1],
    ['layer-l1', HUB.L2],
  ]) {
    const button = view.locator(`[data-control="${control}"]`)
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    // The other layer alone: the pixels changed, to that layer's own pin.
    await expect.poll(() => hubSha(page)).toBe(alone)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => hubSha(page)).toBe(HUB.BOTH)
  }
})

test('the Effects toggle is disabled and says why', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  await openProject(page, ROM)
  await openOverworldRow(page)
  await page.waitForSelector('.hb-overworld-canvas', { timeout: 30000 })
  const l3 = page.locator(`${VIEW} [data-control="layer-l3"]`)
  await expect(l3).toBeDisabled()
  await expect(l3).toHaveAttribute('title', 'Effects not drawn yet')
  await expect(l3).toHaveAttribute('aria-pressed', 'false')
  // The icon marks the top bar: three bars, only the first in the button's color.
  const ys = await l3
    .locator('svg rect[data-on="true"]')
    .evaluateAll(rs => rs.map(r => r.getAttribute('y')))
  expect(ys).toEqual(['1'])
  const before = await hubSha(page)
  await l3.click({ force: true })
  expect(await hubSha(page)).toBe(before)
})

test('a ROM whose L1 reader is not stock shows the reason and no canvas', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla ROM')
  const planted = plantedRom('refused.sfc', bytes => {
    bytes[fileOffset(bytes, L1_LDX_OPCODE)] ^= 0xff
  })
  await openProject(page, planted)
  await openOverworldRow(page)
  await expect(page.locator('.hb-overworld-reason')).toContainText(
    /not stock: \$04DC4C .* holds (?:\S+ ){14}5d /,
  )
  await expect(page.locator('.hb-overworld-canvas')).toHaveCount(0)
})

test('a single click on the row previews the view without taking focus', async ({ page }) => {
  await openVanillaWithRow(page)
  await page.locator(ROW).click()
  await expect(page.locator(VIEW)).toBeVisible()
  expect(await previewIds(page)).toEqual(['hackbench.overworld-view:preview'])
  await expect.poll(() => activeId(page)).toBe('hackbench.map-explorer')
  // The keys still drive the list: the next arrow moves the selection off the row.
  await page.keyboard.press('ArrowUp')
  await expect(
    page.locator(`${EXPLORER} .theia-TreeNode[data-node-id^="special:new-game"]`),
  ).toHaveClass(/theia-mod-selected/)
})

test('arrowing onto the row previews the view and keeps focus in the list', async ({ page }) => {
  await openVanillaWithRow(page)
  await page.locator(`${EXPLORER} .theia-TreeNode[data-node-id^="special:title-screen"]`).click()
  // Title Screen, New Game, Overworld: two presses. Each waits for the selection
  // to land, so a press is never sent before the tree has re-rendered.
  await page.keyboard.press('ArrowDown')
  await expect(
    page.locator(`${EXPLORER} .theia-TreeNode[data-node-id^="special:new-game"]`),
  ).toHaveClass(/theia-mod-selected/)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator(ROW)).toHaveClass(/theia-mod-selected/)
  await expect(page.locator(VIEW)).toBeVisible()
  expect(await previewIds(page)).toEqual(['hackbench.overworld-view:preview'])
  expect(await activeId(page)).toBe('hackbench.map-explorer')
  // The keys still drive the list: the next arrow moves the selection off the row.
  await page.keyboard.press('ArrowUp')
  await expect(
    page.locator(`${EXPLORER} .theia-TreeNode[data-node-id^="special:new-game"]`),
  ).toHaveClass(/theia-mod-selected/)
})
