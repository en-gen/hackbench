/**
 * #1083: hovering a marker (a sprite the app could not draw) names it and says why, in plain words. SYNTHETIC half:
 * canned replies, no ROM (docs/testing.md "Playwright and RPC"), with a lone $9B named and a nameless sprite; the
 * texts are literals here, not read from the code under test. ROM half: vanilla map $1D0's Castle Flames ($E6),
 * one of 8 refused $E6 rows found by a mapSprites sweep over slots $0-$1FF (one run, one machine).
 * Planted defect for the verifier: spriteName drops the reason (or notDrawnText returns the raw code): both marker cases go red.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
const INDEX = 0x1d0
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const REFUSED = "The app could not run this sprite's code."
const EXTRA =
  'It uses the extra-bits marker that custom sprites use, so vanilla art would be wrong.'
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

test('a named lone $9B and a nameless sprite say why they are markers; a drawn sprite keeps its name', async ({
  page,
}) => {
  const row = (index, x0, extra) => ({
    index,
    id: 1,
    x: x0,
    y: 100,
    box: { x0, y0: 100, x1: x0 + 16, y1: 116 },
    rgba: GRAY,
    status: 'drawn',
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
        row(900, 20, {
          id: 0x9b,
          name: 'Hammer Brother',
          status: 'placeholder',
          reason: 'refused: INIT: planted',
        }),
        row(901, 60, { id: 0x77, status: 'placeholder', reason: 'extraBits' }),
        row(902, 100, { name: 'Test sprite' }),
      ],
    },
  })
  expect(await hoverText(page, 28, 108)).toBe(`Hammer Brother (sprite $9B): ${REFUSED}`)
  expect(await hoverText(page, 68, 108)).toBe(`Sprite $77: ${EXTRA}`)
  expect(await hoverText(page, 108, 108)).toBe('Test sprite')
})

test('vanilla Castle Flames ($E6, map $1D0), a refused marker, says why on a real hover', async ({
  page,
}) => {
  test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-marker-reason-'))
  try {
    const { manifestPath } = await page.evaluate(
      ({ romPath, directory }) =>
        getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
      { romPath: ROM, directory: path.join(tmp, 'MyHack') },
    )
    await openMap(page, manifestPath)
    const reply = await page.evaluate(
      mp => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x1d0),
      manifestPath,
    )
    // Still a marker, or this fails rather than skips: the row is the proof the hover has something to say.
    const row = reply.sprites.find(s => s.index === 0 && s.id === 0xe6)
    expect(row).toMatchObject({ status: 'placeholder', box: { x0: 0, y0: 0, x1: 16, y1: 16 } })
    expect(await hoverText(page, 8, 8)).toBe(
      `Castle Flames (cluster type 5) (sprite $E6): ${REFUSED}`,
    )
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
