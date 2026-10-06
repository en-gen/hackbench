/**
 * #618: the map toolbar warns when the open level's mode is on the unverified list (1E, #617).
 *
 * CI has no ROM, so the level is synthetic: each tab's ProjectService is replaced by a stub whose
 * mapDetails reports the header mode and whose every other call is unavailable. Nothing reads a
 * file. To prove it goes red, delete 0x1e from UNVERIFIED_MODES in src/rom/model/UnverifiedModes.ts
 * and rebuild: the 1E assertions fail.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const WARNING = 'Level mode 1E: sprite layering not verified'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

const root = index => `[id="hackbench.map-view:${index}"]`
const warning = index => `${root(index)} [data-control="unverified-mode"]`

test.beforeEach(async ({ page }) => {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

/** Opens slot `index` in a tab whose service is stubbed to report `levelMode`. */
async function openSynthetic(page, index, levelMode) {
  await page.evaluate(
    async ({ index, levelMode }) => {
      const wm = getSvc('WidgetManager')
      const w = await wm.getOrCreateWidget('hackbench.map-view', { index })
      const unavailable = { status: 'unavailable', reason: 'synthetic level' }
      w.projects = new Proxy(
        {},
        {
          get: (_, name) =>
            name === 'mapDetails'
              ? async () => ({ index, name: 'Synthetic', screens: 1, levelMode })
              : async () => unavailable,
        },
      )
      await w.open({ manifestPath: 'synthetic.hbproj', index, label: `s${index}`, iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { index, levelMode },
  )
}

test('mode 1E shows the warning, with an explanatory tooltip', async ({ page }) => {
  await openSynthetic(page, 0x1e0, 0x1e)
  const w = page.locator(warning(0x1e0))
  await expect(w).toHaveText(WARNING)
  await expect(w.locator('.codicon-warning')).toHaveCount(1)
  await expect(w).toHaveAttribute(
    'title',
    'Sprites in this mode may draw in the wrong order. This mode has not been checked against the game.',
  )
  expect(await w.getAttribute('title')).not.toMatch(/github/i)
})

test('another mode shows no warning', async ({ page }) => {
  await openSynthetic(page, 0x1e1, 0x0e)
  // The details reply has landed once the name shows, so absence is checked after it.
  await expect(page.locator(`${root(0x1e1)} .hb-map-name`)).toHaveText('Synthetic')
  await expect(page.locator(warning(0x1e1))).toHaveCount(0)
})

test('reusing one tab for a 1E level, then a normal one, hides the warning', async ({ page }) => {
  // The preview tab is reused across maps: one widget, open() twice (hackbench-contribution.ts).
  await openSynthetic(page, 0x1e2, 0x1e)
  await expect(page.locator(warning(0x1e2))).toBeVisible()
  await page.evaluate(async () => {
    const w = getSvc('ApplicationShell').getWidgetById('hackbench.map-view:482')
    w.projects = new Proxy(
      {},
      {
        get: (_, name) =>
          name === 'mapDetails'
            ? async () => ({ index: 0x1e2, name: 'Normal', screens: 1, levelMode: 0x01 })
            : async () => ({ status: 'unavailable', reason: 'synthetic level' }),
      },
    )
    await w.open({ manifestPath: 'synthetic.hbproj', index: 0x1e2, label: 'n', iconClass: '' })
  })
  await expect(page.locator(`${root(0x1e2)} .hb-map-name`)).toHaveText('Normal')
  await expect(page.locator(warning(0x1e2))).toHaveCount(0)
})
