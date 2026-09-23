/**
 * Default placement on a fresh layout: the emulator docks in the bottom panel
 * beside Problems, and Theia's Outline view is not in the layout but is
 * still reachable.
 *
 * Needs no ROM or core, so it runs in CI. Each Playwright context starts with
 * empty localStorage, which is what makes Theia build its initial layout
 * rather than restore a saved one.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const EMULATOR_IN_BOTTOM = '#theia-bottom-content-panel #hackbench\\.emulator-view'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

test.beforeEach(async ({ page }) => {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  // Contributions finish registering slightly after the shell paints; same
  // wait the other specs use for the same reason.
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test('the emulator docks in the bottom panel beside Problems', async ({ page }) => {
  const bottom = await page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('bottom')
      .map(w => w.id),
  )
  expect(bottom).toEqual(expect.arrayContaining(['problems', 'hackbench.emulator-view']))
})

test('the emulator starts collapsed, and View > Emulator opens and closes it', async ({ page }) => {
  const panel = page.locator(EMULATOR_IN_BOTTOM)
  const viewEmulator = async () => {
    await page.locator('.lm-MenuBar-itemLabel', { hasText: /^View$/ }).click()
    await page.locator('.lm-Menu .lm-Menu-item', { hasText: /^Emulator/ }).click()
  }
  await expect(panel).toBeHidden()
  await viewEmulator()
  await expect(panel).toBeVisible()
  // Open must mean usable, not a sliver.
  expect((await panel.boundingBox()).height).toBeGreaterThan(150)
  await viewEmulator()
  await expect(panel).toBeHidden()
})

test('Outline is not in the default layout', async ({ page }) => {
  const all = await page.evaluate(() =>
    ['left', 'right', 'main', 'bottom'].flatMap(area =>
      getSvc('ApplicationShell')
        .getWidgets(area)
        .map(w => w.id),
    ),
  )
  expect(all).not.toContain('outline-view')
  await expect(page.locator('#shell-tab-outline-view')).toHaveCount(0)
})

test('Outline is still reachable from its command and opens on the right', async ({ page }) => {
  const right = await page.evaluate(async () => {
    const commands = getSvc('CommandRegistry')
    await commands.executeCommand('outlineView:toggle')
    return getSvc('ApplicationShell')
      .getWidgets('right')
      .map(w => w.id)
  })
  expect(right).toContain('outline-view')
})

test('in the short bottom panel the emulator screen keeps the SNES 256:224 aspect', async ({
  page,
}) => {
  await page.evaluate(async () => {
    await getSvc('CommandRegistry').executeCommand('hackbench.emulator.focus')
  })
  await expect(page.locator(EMULATOR_IN_BOTTOM)).toBeVisible()
  // The real screen only renders once a ROM and core are loaded, which CI
  // has neither of; the sizing is pure CSS, so an identical stage + screen
  // placed in the same panel measures the same rules.
  const box = await page.evaluate(() => {
    const host = document.getElementById('hackbench.emulator-view')
    const stage = document.createElement('div')
    stage.className = 'hb-emulator-stage'
    // The panel's own height, so the height clamp is the rule measured.
    stage.style.height = `${host.clientHeight}px`
    const screen = document.createElement('div')
    screen.className = 'hb-emulator-screen'
    stage.appendChild(screen)
    host.appendChild(stage)
    const r = screen.getBoundingClientRect()
    return { width: r.width, height: r.height }
  })
  // Only meaningful while the panel clamps the height below the 448px cap.
  expect(box.height).toBeGreaterThan(0)
  expect(box.height).toBeLessThan(448)
  expect(box.width / box.height).toBeCloseTo(256 / 224, 2)
})

test('Change Emulator Core reveals the collapsed emulator panel', async ({ page }) => {
  const panel = page.locator(EMULATOR_IN_BOTTOM)
  await expect(panel).toBeHidden()
  await page.evaluate(async () => {
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.emulator-view')
    // The real picker opens a native file dialog; only the reveal is under test.
    w.pickCore = async () => {}
    await getSvc('CommandRegistry').executeCommand('hackbench.emulator.changeCore')
  })
  await expect(panel).toBeVisible()
})
