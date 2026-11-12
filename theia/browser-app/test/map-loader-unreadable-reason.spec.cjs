/**
 * #1011: a sprite boxed because the app could not read the ROM's sprite loader says so, in plain words, on a real hover
 * and in the Properties panel. SYNTHETIC only: canned replies, no ROM (docs/testing.md "Playwright and RPC"). The texts are
 * literals here, not read from the code under test. A goal tape ($7B) stands for the bit-2 sprite that used to draw as
 * vanilla; a sprite boxed for custom code ('extraBits') beside it keeps its own, different words.
 * Planted defect for the verifier: notDrawnText drops the loaderUnreadable entry (the hover and the note fall to the generic
 * "The app could not draw this sprite."): the hover, the panel note and the stale-words check all go red.
 */
const { test, expect } = require('@playwright/test')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const INDEX = 0x1d0
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const EXTRA =
  'It uses the extra-bits marker that custom sprites use, so vanilla art would be wrong.'
const UNREAD =
  "The app could not read how this ROM's sprite loader treats the extra-bits marker, so it cannot tell whether vanilla art is right."
const SYNTHETIC = 'synthetic.hbproj'
const GRAY = btoa(String.fromCharCode(...new Uint8Array(16 * 16 * 4).fill(255)))

let pageErrors
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(async ({ page }) => {
  await page.evaluate(async i => {
    await getSvc('ApplicationShell')
      .closeWidget(`hackbench.map-view:${i}`)
      .catch(() => undefined)
  }, INDEX)
  expect(pageErrors).toEqual([])
})

/** Opens map `index` at Actual size, with `canned` replies standing in for the project service when given. */
async function openMap(page, manifestPath, canned) {
  await page.evaluate(
    async ({ mp, index, canned }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      if (canned) {
        const reply = k => async () =>
          canned[k] ?? { status: 'unavailable', reason: 'synthetic map' }
        w.projects = new Proxy({}, { get: (_t, k) => reply(k) })
      }
      await w.open({ manifestPath: mp, index, label: 'marker', iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
      await w.node.querySelector('[data-control="zoom-actual"]').click()
    },
    { mp: manifestPath, index: INDEX, canned },
  )
  await expect
    .poll(
      () =>
        page.evaluate(
          i =>
            getSvc('WidgetManager')
              .getOrCreateWidget('hackbench.map-view', { index: i })
              .then(w => !!w.sprites),
          INDEX,
        ),
      { timeout: 30000 },
    )
    .toBe(true)
  await page.waitForTimeout(1500)
}

/** Moves the real pointer to map pixel (x, y) at zoom 1 (the map starts at the scroller's origin) and returns Theia's open hover text. */
async function hoverText(page, x, y) {
  await page.evaluate(i => {
    const s = document.querySelector(`[id="hackbench.map-view:${i}"] [data-control="map-scroller"]`)
    s.scrollLeft = s.scrollTop = 0
  }, INDEX)
  const r = await page
    .locator(`[id="hackbench.map-view:${INDEX}"] [data-control="map-edge"]`)
    .boundingBox()
  await page.mouse.move(r.x + x + 1, r.y + y)
  await page.mouse.move(r.x + x, r.y + y)
  await expect(page.locator('.theia-hover')).toBeVisible({ timeout: 10000 })
  return page.locator('.theia-hover').textContent()
}

/** Clicks map pixel (x, y) at zoom 1, the way hoverText moves to it. */
async function clickAt(page, x, y) {
  const r = await page
    .locator(`[id="hackbench.map-view:${INDEX}"] [data-control="map-edge"]`)
    .boundingBox()
  await page.mouse.click(r.x + x, r.y + y)
}

test('a sprite boxed for an unreadable loader says why on hover and in the Properties panel; a custom-code box keeps its words', async ({
  page,
}) => {
  const row = (index, x0, extra) => ({
    index,
    id: 1,
    x: x0,
    y: 100,
    box: { x0, y0: 100, x1: x0 + 16, y1: 116 },
    rgba: GRAY,
    status: 'placeholder',
    ...extra,
  })
  const none = { l2Low: null, l1Low: null, l2High: null, l1High: null, l3Low: null, l3High: null }
  const map = { status: 'ok', orientation: 'horizontal', screenCount: 4, width: 256, height: 432 }
  await openMap(page, SYNTHETIC, {
    mapStart: { status: 'ok', x: 0, y: 0 },
    mapScreen: {
      ...map,
      screen: 0,
      planes: none,
      layer3: { priority: false, reason: null },
      screens: { main: ['l1Low'], sub: [] },
      math: null,
      layer2Interactive: false,
      layerNotes: [],
      backdrop: [200, 0, 0],
    },
    mapSprites: {
      ...map,
      sprites: [
        row(900, 20, { id: 0x7b, reason: 'loaderUnreadable' }),
        row(901, 60, { id: 0x77, reason: 'extraBits' }),
      ],
    },
  })
  expect(await hoverText(page, 28, 108)).toBe(`Sprite $7B: ${UNREAD}`)
  expect(await hoverText(page, 68, 108)).toBe(`Sprite $77: ${EXTRA}`)

  await clickAt(page, 28, 108)
  const panel = page.locator('[id="hackbench.properties"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-field="label"]')).toHaveText('Sprite $7B')
  await expect(panel.locator('[data-field="note"]').first()).toContainText(`Not drawn: ${UNREAD}`)
  await clickAt(page, 68, 108)
  await expect(panel.locator('[data-field="note"]').first()).toContainText(`Not drawn: ${EXTRA}`)
})
