/**
 * Default activity-bar placement on a fresh layout: the emulator docks on the
 * right, and Theia's Outline view is not in the layout but is still reachable.
 *
 * Needs no ROM or core, so it runs in CI. Each Playwright context starts with
 * empty localStorage, which is what makes Theia build its initial layout
 * rather than restore a saved one.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'

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

test('the emulator docks in the right activity bar, not the left or the main area', async ({
  page,
}) => {
  const areas = await page.evaluate(() => {
    const ids = area =>
      getSvc('ApplicationShell')
        .getWidgets(area)
        .map(w => w.id)
    return {
      right: ids('right'),
      left: ids('left'),
      main: ids('main'),
    }
  })
  expect(areas.right).toContain('hackbench.emulator-view')
  expect(areas.left).not.toContain('hackbench.emulator-view')
  expect(areas.main).not.toContain('hackbench.emulator-view')
})

test('the emulator starts collapsed, and its right activity-bar tab opens and closes it', async ({
  page,
}) => {
  const panel = page.locator('#theia-right-side-panel #hackbench\\.emulator-view')
  const tab = page.locator('#theia-right-content-panel #shell-tab-hackbench\\.emulator-view')
  await expect(tab).toBeVisible()
  await expect(panel).toBeHidden()
  await tab.click()
  await expect(panel).toBeVisible()
  await tab.click()
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

test('in the narrow right panel the emulator screen keeps the SNES 256:224 aspect', async ({
  page,
}) => {
  await page.locator('#theia-right-content-panel #shell-tab-hackbench\\.emulator-view').click()
  // The real screen only renders once a ROM and core are loaded, which CI
  // has neither of; the sizing is pure CSS, so an identical stage + screen
  // placed in the same panel measures the same rules.
  const box = await page.evaluate(() => {
    const host = document.getElementById('hackbench.emulator-view')
    const stage = document.createElement('div')
    stage.className = 'hb-emulator-stage'
    stage.style.height = '600px'
    const screen = document.createElement('div')
    screen.className = 'hb-emulator-screen'
    stage.appendChild(screen)
    host.appendChild(stage)
    const r = screen.getBoundingClientRect()
    return { width: r.width, height: r.height }
  })
  // Only meaningful while the panel clamps the width below the 512px cap.
  expect(box.width).toBeGreaterThan(0)
  expect(box.width).toBeLessThan(512)
  expect(box.width / box.height).toBeCloseTo(256 / 224, 2)
})

test('Change Emulator Core reveals the collapsed emulator panel', async ({ page }) => {
  const panel = page.locator('#theia-right-side-panel #hackbench\\.emulator-view')
  await expect(panel).toBeHidden()
  await page.evaluate(async () => {
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.emulator-view')
    // The real picker opens a native file dialog; only the reveal is under test.
    w.pickCore = async () => {}
    await getSvc('CommandRegistry').executeCommand('hackbench.emulator.changeCore')
  })
  await expect(panel).toBeVisible()
})
