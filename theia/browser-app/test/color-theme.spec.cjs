/**
 * System Default color theme option (#665, #666).
 *
 * A fresh profile settles on the OS's mode once preferences load (#665); the
 * `system` preference value then keeps following `prefers-color-scheme`
 * live, until a real theme is picked, which pins it (#666). Settings persist
 * server-side in the shared test server's THEIA_CONFIG_DIR across specs, so
 * every test resets `workbench.colorTheme` to unset before it starts.
 *
 * Planted-defect coverage, for whoever re-verifies these are real oracles:
 * - the "settles on OS mode" tests go red if the schema default reverts to
 *   the hardcoded `'light'` (core-preferences.ts) instead of `'system'`, or
 *   if the fresh-load re-apply in SystemColorThemeContribution#onStart is
 *   removed;
 * - the "live OS change" test goes red if the `matchMedia` `change` listener
 *   in SystemColorThemeContribution is removed or never attached;
 * - the "pinning" test goes red if setting a real theme still leaves
 *   `followSystemIfSelected` applying the OS mode afterward;
 * - the picker test goes red if the System Default row is missing, mislabels
 *   the current mode, or selecting it fails to persist `system`.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const COLOR_THEME_KEY = 'workbench.colorTheme'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

async function boot(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.addScriptTag({ content: GET_SVC })
}

const currentThemeId = page => page.evaluate(() => getSvc('ThemeService').getCurrentTheme().id)
const colorThemePreference = page =>
  page.evaluate(key => getSvc('PreferenceService').get(key), COLOR_THEME_KEY)
const setColorThemePreference = (page, value) =>
  page.evaluate(
    ([key, v]) => getSvc('PreferenceService').updateValue(key, v),
    [COLOR_THEME_KEY, value],
  )

test.beforeEach(async ({ page }) => {
  await boot(page)
  // Wipe whatever an earlier spec (or a previous test in this file) pinned.
  await setColorThemePreference(page, undefined)
})

test.afterEach(async ({ page }) => {
  await setColorThemePreference(page, undefined).catch(() => {})
})

test.describe('fresh launch follows the OS (#665)', () => {
  for (const [scheme, themeId] of [
    ['dark', 'dark'],
    ['light', 'light'],
  ]) {
    test(`OS ${scheme} settles on the ${themeId} theme after preferences load`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      // Preference is already unset from beforeEach; reload to re-run the
      // fresh-launch path with that scheme active from the first paint.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
      await page.addScriptTag({ content: GET_SVC })
      // Past ThemeService's own 500ms debounce, not at first paint.
      await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe(themeId)
      expect(await colorThemePreference(page)).toBe('system')
    })
  }
})

test('system keeps following a live OS scheme change, with no reload (#666)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'system')
  await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe('dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe('dark')
})

test('picking a real theme pins it against later OS changes (#666)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'light')
  await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  // No listener fires for a pinned theme; give one a chance to (wrongly) run.
  await page.waitForTimeout(600)
  expect(await currentThemeId(page)).toBe('light')
})

test('the picker leads with System Default for the current OS mode, and selecting it sets system (#666)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'light')

  await page.evaluate(() =>
    getSvc('CommandRegistry').executeCommand('workbench.action.selectTheme'),
  )
  const firstRow = page.locator('.quick-input-list .quick-input-list-entry').first()
  await expect(firstRow).toContainText('System Default (Dark)')

  await firstRow.click()
  await expect.poll(() => colorThemePreference(page), { timeout: 5000 }).toBe('system')
  await expect.poll(() => currentThemeId(page), { timeout: 5000 }).toBe('dark')
})
