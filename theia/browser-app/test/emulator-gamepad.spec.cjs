/**
 * Gamepad input and the controllers fly-out in the emulator view (#433).
 *
 * navigator.getGamepads is stubbed before the page loads: headless Chromium
 * has no pad. Every assertion on input reads what reached the core's
 * _simulate_input (port, button, value), the same oracle emulator-view.spec
 * uses for the keyboard, so a mapping that drew right but sent wrong goes red.
 *
 * Needs the same local ROM and core fixtures as emulator-view.spec.cjs and
 * skips without them. Written for the PR 1 brief; run by the verifier.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const CORE_JS =
  process.env.HB_CORE_JS ||
  path.resolve(__dirname, '../../../vendor/cores/snes9x-wasm/snes9x_libretro.js')
const haveRom = fs.existsSync(ROM)
const haveCore = fs.existsSync(CORE_JS) && fs.existsSync(CORE_JS.replace(/\.js$/, '.wasm'))
const VIEW = '#hackbench\\.emulator-view'

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) { return getSvc('WidgetManager').getOrCreateWidget(id) }
async function revealEmulator() {
  await getSvc('EmulatorContribution').openView({ activate: true, reveal: true })
  return getWidget('hackbench.emulator-view')
}
/** A standard-mapping pad stub; down lists the button indexes held. */
function pad(index, down = [], axes = [0, 0, 0, 0], mapping = 'standard') {
  return {
    connected: true,
    index,
    id: 'Test Pad ' + index,
    mapping,
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: down.includes(i) })),
  }
}
function setPads(p0, p1) { window.__pads = [p0 ?? null, p1 ?? null, null, null] }`

let tmp

test.beforeEach(async ({ page }) => {
  test.skip(
    !haveRom || !haveCore,
    `fixtures not present (ROM: ${haveRom}, core: ${haveCore}); this suite must SKIP, not pass.`,
  )
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-pad-'))
  await page.addInitScript(() => {
    window.__pads = [null, null, null, null]
    navigator.getGamepads = () => window.__pads
  })
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  await page
    .evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.stop())
    .catch(() => {})
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Project + running core, with _simulate_input recorded into window.__hbSeen. */
async function bootWithSpy(page, name) {
  const setup = await page.evaluate(
    async ({ romPath, corePath, directory }) => {
      const emu = getSvc('Symbol(EmulatorService)')
      const projects = getSvc('Symbol(ProjectService)')
      const ctx = getSvc('ProjectContext')
      const r = await emu.locateCore(corePath)
      if (r.status !== 'ok') return { error: r.message }
      const project = await projects.createProject({ romPath, name: 'PadHack', directory })
      const w = await getWidget('hackbench.emulator-view')
      ctx.current = project
      await w.refresh()
      return { state: w.state }
    },
    { romPath: ROM, corePath: CORE_JS, directory: path.join(tmp, name) },
  )
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await page.locator(`${VIEW} button[aria-label="Start"]`).click()
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.frameCount()),
      { timeout: 60000 },
    )
    .toBeGreaterThan(10)
  await page.evaluate(async () => {
    const m = (await getWidget('hackbench.emulator-view')).driver.module
    const real = m._simulate_input
    window.__hbSeen = []
    m._simulate_input = (p, b, v) => (window.__hbSeen.push([p, b, v]), real(p, b, v))
  })
}

const seen = page => page.evaluate(() => window.__hbSeen)
const selectTab = (page, n) => page.locator(`${VIEW} [role="tab"]:has-text("Player ${n}")`).click()
const openFlyout = async page => {
  await page.locator(`${VIEW} button[aria-label="Controllers"]`).click()
  await expect(page.locator(`${VIEW} .hb-pad-flyout`)).toBeVisible()
}

test('the toolbar button matches the map toolbar and toggles a right fly-out while the game runs', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Toolbar')
  const button = page.locator(`${VIEW} button[aria-label="Controllers"]`)
  await expect(button).toHaveClass(/hb-icon-btn/)
  await expect(button.locator('.codicon')).toHaveClass(/codicon-game/)
  // Same box as the other toolbar buttons.
  const sizes = await page
    .locator(`${VIEW} .hb-emulator-controls .hb-icon-btn`)
    .evaluateAll(els => els.map(e => [e.offsetWidth, e.offsetHeight]))
  expect(new Set(sizes.map(s => s.join('x'))).size).toBe(1)
  await expect(button).toHaveAttribute('aria-pressed', 'false')

  await button.click()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expect(button).toHaveClass(/hb-icon-btn-on/)
  const flyout = page.locator(`${VIEW} .hb-pad-flyout`)
  await expect(flyout).toBeVisible()
  const edge = await page.evaluate(() => {
    const body = document.querySelector('#hackbench\\.emulator-view .hb-emulator-body')
    const f = document.querySelector('#hackbench\\.emulator-view .hb-pad-flyout')
    return Math.abs(body.getBoundingClientRect().right - f.getBoundingClientRect().right)
  })
  expect(edge, 'fly-out is not on the right edge').toBeLessThan(2)

  // The game keeps running with it open.
  const frames = () =>
    page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.frameCount())
  const f0 = await frames()
  await page.waitForTimeout(500)
  expect(await frames()).toBeGreaterThan(f0)

  await button.click()
  await expect(flyout).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-pressed', 'false')
})

test('pad buttons map by position to the right port, send edges once, and release on disconnect', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Pads')

  // Bottom face (index 0) is SNES B (id 0); held across many frames it is one press.
  await page.evaluate(() => setPads(pad(0, [0])))
  await page.waitForTimeout(300)
  await page.evaluate(() => setPads(pad(0, [0, 1])))
  await expect
    .poll(() => seen(page))
    .toEqual([
      [0, 0, 1],
      [0, 8, 1],
    ])

  // Unplugging releases what was held, on its port.
  await page.evaluate(() => setPads(null))
  await expect.poll(() => seen(page)).toHaveLength(4)
  expect((await seen(page)).slice(2).sort()).toEqual([
    [0, 0, 0],
    [0, 8, 0],
  ])

  // Pad 1 is player 2: left face (index 2) is Y (id 1) on port 1.
  await page.evaluate(() => {
    window.__hbSeen.length = 0
    setPads(null, pad(1, [2]))
  })
  await expect.poll(() => seen(page)).toEqual([[1, 1, 1]])

  // The left stick past the threshold is the d-pad.
  await page.evaluate(() => {
    window.__hbSeen.length = 0
    setPads(pad(0, [], [0.9, 0]), null)
  })
  await expect.poll(() => seen(page)).toContainEqual([0, 7, 1])
})

test('a pad without the standard mapping sends nothing', async ({ page }) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'NonStandard')
  await page.evaluate(() => setPads(pad(0, [0, 1, 2, 3], [0, 0, 0, 0], '')))
  await page.waitForTimeout(500)
  expect(await seen(page)).toEqual([])
})

test('losing focus releases held pad buttons and an unfocused window is not polled', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Release')
  await page.evaluate(() => setPads(pad(0, [9])))
  await expect.poll(() => seen(page)).toEqual([[0, 3, 1]])
  // Gating reads document.hasFocus() each frame; no blur event is involved.
  await page.evaluate(() => {
    document.hasFocus = () => false
  })
  await expect
    .poll(() => seen(page))
    .toEqual([
      [0, 3, 1],
      [0, 3, 0],
    ])
  await page.waitForTimeout(300)
  expect(await seen(page), 'polled while unfocused').toHaveLength(2)
  await page.evaluate(() => {
    document.hasFocus = () => true
  })
  await expect.poll(() => seen(page)).toHaveLength(3)
})

test('Stop releases a held key and a held pad button, so the next Start inherits nothing', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'StopRelease')
  await page.keyboard.down('KeyZ')
  await page.evaluate(() => setPads(null, pad(1, [3])))
  await expect
    .poll(() => seen(page))
    .toEqual([
      [0, 0, 1],
      [1, 9, 1],
    ])
  await page.locator(`${VIEW} button[aria-label="Stop"]`).click()
  // The spy sits on the core Stop discards, so it is the release the core
  // received BEFORE it went that this asserts; read it from the recorded calls.
  const calls = await seen(page)
  expect(calls.slice(2).sort(), 'Stop did not release what was held').toEqual([
    [0, 0, 0],
    [1, 9, 0],
  ])
  await page.keyboard.up('KeyZ')
  expect(
    await page.evaluate(async () => [
      ...(await getWidget('hackbench.emulator-view')).controllers.hub.pressed(0),
    ]),
  ).toEqual([])
})

test('a key held while the keyboard moves to player 2 is released on port 0', async ({ page }) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'KeyboardMove')
  await openFlyout(page)
  await page.evaluate(async () => (await getWidget('hackbench.emulator-view')).node.focus())
  await page.keyboard.down('KeyZ')
  expect(await seen(page)).toEqual([[0, 0, 1]])
  await selectTab(page, 2)
  await page.locator(`${VIEW} input[aria-label="Player 2 keyboard"]`).check()
  expect(await seen(page), 'the held key stuck on port 0').toEqual([
    [0, 0, 1],
    [0, 0, 0],
  ])
  await page.keyboard.up('KeyZ')
})

test('the drawing lights what each player is sending, including d-pad, L/R and Start', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Drawing')
  await openFlyout(page)
  const lit = player =>
    page.evaluate(
      p =>
        [
          ...document.querySelectorAll(
            `#hackbench\\.emulator-view [data-player="${p}"] [data-btn].hb-pad-on`,
          ),
        ]
          .map(e => Number(e.getAttribute('data-btn')))
          .sort((a, b) => a - b),
      player,
    )
  expect(await lit(1)).toEqual([])
  // Only the selected player's drawing exists; P2's is reachable through its tab.
  await expect(page.locator(`${VIEW} [data-player="2"]`)).toHaveCount(0)
  // P1: right face (A, 8), d-pad up (4), LB (L, 10), start (3).
  await page.evaluate(() => setPads(pad(0, [1, 12, 4, 9]), pad(1, [3])))
  await expect.poll(() => lit(1)).toEqual([3, 4, 8, 10])
  // P2: top face (X, 9), and only P2.
  await selectTab(page, 2)
  await expect(page.locator(`${VIEW} [data-player="1"]`)).toHaveCount(0)
  await expect.poll(() => lit(2)).toEqual([9])
  await page.evaluate(() => setPads(null, null))
  await expect.poll(() => lit(2)).toEqual([])
  await selectTab(page, 1)
  await expect.poll(() => lit(1)).toEqual([])
  // Every pressable part exists in the drawing: B Y Sel Start U D L R A X L R.
  const parts = await page.evaluate(() =>
    [...document.querySelectorAll('#hackbench\\.emulator-view [data-player="1"] [data-btn]')]
      .map(e => Number(e.getAttribute('data-btn')))
      .sort((a, b) => a - b),
  )
  expect(parts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('tabs: aria roles, keyboard navigation, activity dot, and the selection persists', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Tabs')
  await openFlyout(page)
  const tab = n => page.locator(`${VIEW} [role="tab"]:has-text("Player ${n}")`)
  await expect(page.locator(`${VIEW} [role="tablist"]`)).toBeVisible()
  await expect(tab(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tab(2)).toHaveAttribute('aria-selected', 'false')
  // Arrow keys move between tabs.
  await tab(1).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tab(2)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator(`${VIEW} [data-player="2"]`)).toBeVisible()
  // P1 holds a button while the P2 tab is selected: P1's dot lights, P2's does not.
  await page.evaluate(() => setPads(pad(0, [0]), null))
  await expect(tab(1).locator('.hb-pad-dot')).toHaveCount(1)
  await expect(tab(2).locator('.hb-pad-dot')).toHaveCount(0)
  await page.evaluate(() => setPads(null, null))
  await expect(tab(1).locator('.hb-pad-dot')).toHaveCount(0)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  const selected = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    await new Promise(r => setTimeout(r, 500))
    return w.controllers.settings.selectedPlayer
  })
  expect(selected).toBe(1)
})

test('the keyboard follows its player assignment', async ({ page }) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Keyboard')
  await page.keyboard.press('ArrowRight')
  expect(await seen(page)).toEqual([
    [0, 7, 1],
    [0, 7, 0],
  ])
  await openFlyout(page)
  await page.evaluate(() => (window.__hbSeen.length = 0))
  await selectTab(page, 2)
  await page.locator(`${VIEW} input[aria-label="Player 2 keyboard"]`).check()
  await selectTab(page, 1)
  await expect(page.locator(`${VIEW} input[aria-label="Player 1 keyboard"]`)).not.toBeChecked()
  await selectTab(page, 2)
  await page.evaluate(async () => (await getWidget('hackbench.emulator-view')).node.focus())
  await page.keyboard.press('ArrowRight')
  expect(await seen(page)).toEqual([
    [1, 7, 1],
    [1, 7, 0],
  ])
  // Nobody has the keyboard: keys do nothing.
  await page.locator(`${VIEW} input[aria-label="Player 2 keyboard"]`).uncheck()
  await page.evaluate(async () => {
    window.__hbSeen.length = 0
    ;(await getWidget('hackbench.emulator-view')).node.focus()
  })
  await page.keyboard.press('ArrowRight')
  expect(await seen(page)).toEqual([])
})

test('pad assignment is chosen per player, exclusive, and survives a reload', async ({ page }) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Assign')
  await page.evaluate(() => setPads(pad(0), pad(1)))
  await openFlyout(page)
  const p1 = page.locator(`${VIEW} select[aria-label="Player 1 gamepad"]`)
  const p2 = page.locator(`${VIEW} select[aria-label="Player 2 gamepad"]`)
  await expect(p1).toHaveValue('0')
  await selectTab(page, 2)
  await expect(p2).toHaveValue('1')
  // Giving P2 pad 0 takes it from P1.
  await p2.selectOption('0')
  await expect(p2).toHaveValue('0')
  await selectTab(page, 1)
  await expect(p1).toHaveValue('')
  await page.evaluate(() => (window.__hbSeen.length = 0))
  await page.evaluate(() => setPads(pad(0, [0]), null))
  await expect.poll(() => seen(page)).toEqual([[1, 0, 1]])

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  const stored = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    await new Promise(r => setTimeout(r, 500))
    return w.controllers.settings.players.map(a => a.pad)
  })
  expect(stored).toEqual([undefined, 0])
})

test('controller colors follow the region, and the style override wins and persists', async ({
  page,
}) => {
  test.setTimeout(120000)
  await bootWithSpy(page, 'Region')
  const fillOfA = () =>
    page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector('#hackbench\\.emulator-view [data-player="1"] [data-btn="8"]'),
        ).fill,
    )
  // The OS country (Electron's bridge; stubbed here since the browser build has none) wins.
  const setCountry = code =>
    page.evaluate(
      async c => (await getWidget('hackbench.emulator-view')).controllers.setOsCountry(c),
      code,
    )
  // The fallback reads navigator.language only, never the later navigator.languages.
  const setLanguage = (language, languages = [language]) =>
    page.evaluate(
      ([lang, langs]) => {
        Object.defineProperty(navigator, 'language', { get: () => lang, configurable: true })
        Object.defineProperty(navigator, 'languages', { get: () => langs, configurable: true })
      },
      [language, languages],
    )
  const scheme = () => page.locator(`${VIEW} [data-player="1"]`).getAttribute('data-scheme')
  const reopen = async () => {
    const b = page.locator(`${VIEW} button[aria-label="Controllers"]`)
    if (await page.locator(`${VIEW} .hb-pad-flyout`).count()) await b.click()
    await b.click()
  }
  const NA = 'rgb(78, 58, 134)'
  const PAL = 'rgb(255, 72, 86)'

  for (const [country, want, fill] of [
    ['US', 'na', NA],
    ['CA', 'na', NA],
    ['MX', 'na', NA],
    ['JP', 'pal', PAL],
    ['GB', 'pal', PAL],
  ]) {
    await setCountry(country)
    await reopen()
    await expect.poll(scheme, { message: `country ${country}` }).toBe(want)
    expect(await fillOfA(), `A button color for ${country}`).toBe(fill)
  }

  // No OS country: fall back to navigator.language.
  await setCountry('')
  for (const [language, languages, want] of [
    ['en-US', ['en-US'], 'na'],
    ['fr-CA', ['fr-CA', 'en'], 'na'],
    ['ja-JP', ['ja-JP'], 'pal'],
    ['en', ['en'], 'pal'],
    // A later tagged language says nothing about where the user is.
    ['de', ['de', 'en-US'], 'pal'],
  ]) {
    await setLanguage(language, languages)
    await reopen()
    await expect.poll(scheme, { message: `language ${language}` }).toBe(want)
  }

  // Override: a Japanese locale forced to North American, then back to Auto.
  await setLanguage('ja-JP')
  await reopen()
  const style = page.locator(`${VIEW} select[aria-label="Controller style"]`)
  await style.selectOption('na')
  await expect.poll(scheme).toBe('na')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  const persisted = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    await new Promise(r => setTimeout(r, 500))
    return w.controllers.settings.style
  })
  expect(persisted).toBe('na')
})
