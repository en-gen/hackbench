/**
 * System Default color theme option (#665, #666).
 *
 * A fresh profile settles on the OS's mode once preferences load, correcting
 * even a stale stored theme (#665). `system` then keeps following
 * `prefers-color-scheme` live, until a real theme is picked - through the
 * picker or Settings - which pins it (#666). Settings persist server-side in
 * the shared test server's THEIA_CONFIG_DIR across specs, so every test
 * resets `workbench.colorTheme` before and after it runs.
 *
 * Planted-defect coverage, for whoever re-verifies these are real oracles,
 * named against `theia/extension/src/browser/system-color-theme.ts`:
 * - the fresh-launch and stale-localStorage tests go red if
 *   `SystemThemeService#getConfiguredTheme` stops resolving `system`, or if
 *   the frontend app config's `defaultTheme: 'system'` is removed;
 * - the live-follow test goes red if the `matchMedia` `change` listener in
 *   `SystemThemeService#init` is removed;
 * - the pinning tests go red if `setCurrentTheme` keeps applying the OS mode
 *   for a real, pinned theme id;
 * - the "resumes following" tests go red if `getConfiguredTheme` cannot
 *   re-recognize `system` once set back;
 * - the picker tests go red if `SystemColorThemePicker` fails to splice in
 *   the row, mislabels the current mode, or its persisted selection does not
 *   round-trip through `setCurrentTheme`'s `system` branch;
 * - the Escape tests go red if previewing (`persist: false`) ever writes the
 *   preference, or if restoring after Escape does not go through
 *   `getConfiguredTheme` again;
 * - the "default comes from config" test goes red if `defaultTheme: 'system'`
 *   plus `preferences: {}` is removed from `browser-app/package.json` (no
 *   `FrontendConfigPreferenceContribution` override registered, so the
 *   schema's plain hardcoded `'light'` default answers `inspect()` instead).
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const COLOR_THEME_KEY = 'workbench.colorTheme'
const POLL_TIMEOUT = 15000

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

async function attachHelpers(page) {
  await page.addScriptTag({ content: GET_SVC })
}

async function boot(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await attachHelpers(page)
}

const currentThemeId = page => page.evaluate(() => getSvc('ThemeService').getCurrentTheme().id)
const colorThemePreference = page =>
  page.evaluate(key => getSvc('Symbol(PreferenceService)').get(key), COLOR_THEME_KEY)
const setColorThemePreference = (page, value) =>
  page.evaluate(
    ([key, v]) => getSvc('Symbol(PreferenceService)').updateValue(key, v),
    [COLOR_THEME_KEY, value],
  )
const inspectDefault = page =>
  page.evaluate(
    key => getSvc('Symbol(PreferenceService)').inspect(key)?.defaultValue,
    COLOR_THEME_KEY,
  )

// Click into the input so the arrow keys activateRow presses land there.
async function openPicker(page) {
  await page.evaluate(() =>
    getSvc('CommandRegistry').executeCommand('workbench.action.selectTheme'),
  )
  await page.locator('.quick-input-box input').click()
}
// Exact label match: 'Light (Theia)' is also a substring of 'High Contrast
// Light (Theia)'.
const quickPickRow = (page, text) =>
  text
    ? page.locator('.quick-input-list-entry').filter({ has: page.getByText(text, { exact: true }) })
    : page.locator('.quick-input-list-entry').first()
// Preview follows the ACTIVE row, which hover does not move; arrow keys do.
// Theia's quick-input arrow keybindings register a few seconds after the
// shell paints, so keep pressing, spaced out, until the row is reached.
async function activateRow(page, text, key) {
  const focused = page.locator('.quick-input-list .monaco-list-row.focused')
  for (let i = 0; i < 60; i++) {
    if ((await focused.innerText()).split('\n')[0].trim() === text) return
    await page.keyboard.press(key)
    await page.waitForTimeout(250)
  }
  throw new Error(
    `no quick pick row "${text}" reached with ${key}: ${JSON.stringify(await focused.allInnerTexts())}`,
  )
}

test.beforeEach(async ({ page }) => {
  await boot(page)
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
      browser,
    }) => {
      const context = await browser.newContext({ colorScheme: scheme })
      try {
        const page = await context.newPage()
        await boot(page)
        await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe(themeId)
        expect(await colorThemePreference(page)).toBe('system')
      } finally {
        await context.close()
      }
    })
  }

  test('a stale localStorage theme is corrected once preferences load', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'light' })
    try {
      const page = await context.newPage()
      await page.addInitScript(() => window.localStorage.setItem('theme', 'dark'))
      await boot(page)
      await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')
    } finally {
      await context.close()
    }
  })

  test('the default comes from the frontend app config, not a hardcoded value', async ({
    page,
  }) => {
    expect(await inspectDefault(page)).toBe('system')
  })
})

test('system keeps following a live OS scheme change, with no reload (#666)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'system')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')
})

test('picking Light through the picker pins it, and system resumes following once reselected (#666)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await openPicker(page)
  await quickPickRow(page, 'Light (Theia)').click()
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  // No listener fires for a pinned theme; give one a chance to (wrongly) run.
  await page.waitForTimeout(600)
  expect(await currentThemeId(page)).toBe('light')

  // Positive control: the same pinned state resumes following once `system`
  // is selected again, proving the assertion above is not vacuously true.
  await setColorThemePreference(page, 'system')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')
})

test('choosing system through Settings, with no picker, resumes following the OS (#666)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'light')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')

  await setColorThemePreference(page, 'system')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')
})

test.describe('the picker leads with System Default (#666)', () => {
  for (const [scheme, label] of [
    ['dark', 'System Default (Dark)'],
    ['light', 'System Default (Light)'],
  ]) {
    test(`labelled "${label}" under OS ${scheme}, and selecting it sets system`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme })
      // Pin the opposite real theme first, so the row's presence and label
      // are asserted independently of whichever theme happens to be active.
      await setColorThemePreference(page, scheme === 'dark' ? 'light' : 'dark')
      await openPicker(page)
      const firstRow = quickPickRow(page)
      await expect(firstRow).toContainText(label)

      await firstRow.click()
      await expect.poll(() => colorThemePreference(page), { timeout: POLL_TIMEOUT }).toBe('system')
      await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe(scheme)
    })
  }
})

test('Escape after previewing a real theme restores system and its resolved theme (#666)', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'system')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')

  await openPicker(page)
  await activateRow(page, 'Light (Theia)', 'ArrowDown')
  // Past the 200ms preview debounce upstream's selectColorTheme still uses.
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')

  await page.keyboard.press('Escape')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')
  expect(await colorThemePreference(page)).toBe('system')
})

test('Escape after previewing System Default never persists it (#666)', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await setColorThemePreference(page, 'light')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')

  await openPicker(page)
  await activateRow(page, 'System Default (Dark)', 'ArrowUp')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('dark')

  await page.keyboard.press('Escape')
  expect(await colorThemePreference(page)).toBe('light')
  await expect.poll(() => currentThemeId(page), { timeout: POLL_TIMEOUT }).toBe('light')
})
