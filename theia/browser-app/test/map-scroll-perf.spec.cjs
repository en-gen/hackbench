/**
 * Scrolling a long horizontal map stays smooth, en-gen/hackbench#973.
 *
 * Cause it pins: every scroll event re-ran `syncDisplay`, which threw away the "no indicators"
 * outcome of the screens without block indicators and rebuilt their IndicatorDisplay each time
 * (about 44 ms per event on $105), so the main thread missed frames.
 *
 * Scope of the thresholds: slot $105 (20 screens) of the vanilla ROM, `build:browser`, headless
 * Chromium 156 under Playwright, one machine, 2026-10-16, Chromium's 60 Hz rAF. Bounds chosen from
 * the earlier thumb-drag measurements (before the fix p50/p95/max ms: fit 16.7/33.5/116.8, 1x
 * 33.3/33.5/50.1; after 16.7/16.8/16.8 at every zoom); this spec's own numbers are in the PR. The bounds below
 * (p95 under 25, max under 40) sit between the two, so one dropped frame passes and a steady 30 fps
 * does not.
 *
 * The screens are WARMED first (one pass over the strip at each zoom, then a settle), so the cold
 * fetch and decode of a screen is not counted: this measures scrolling over screens already held.
 * Frames are read from a requestAnimationFrame recorder in the page, not from Playwright round trips.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const INDEX = 0x105
const ID = `hackbench.map-view:${INDEX}`
const SCROLLER = `[id="${ID}"] [data-control="map-scroller"]`
const P95_MAX_MS = 25
const FRAME_MAX_MS = 40

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-scrollperf-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index: INDEX },
  )
  await expect(page.locator(SCROLLER)).toHaveAttribute('data-start', /^(placed|skipped|unavailable)$/, { timeout: 30000 }) // prettier-ignore
})

test.afterEach(async ({ page }) => {
  await page.evaluate(id => getSvc('ApplicationShell').closeWidget(id), ID).catch(() => undefined)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Sets the zoom through the toolbar, the way a user does: fit, actual size (1x), or one step past it (2x). */
async function setZoom(page, zoom) {
  const click = c => page.locator(`[id="${ID}"] [data-control="${c}"]`).click()
  if (zoom === 'fit') await click('zoom-fit')
  else {
    await click('zoom-actual')
    if (zoom === 2) await click('zoom-in')
  }
  await page.waitForTimeout(800)
}

/** One pass over the whole strip and back, a screen-width at a time, then a settle: every screen is fetched and drawn. */
async function warm(page) {
  await page.evaluate(async sel => {
    const el = document.querySelector(sel)
    const max = el.scrollWidth - el.clientWidth
    for (let x = 0; x <= max + el.clientWidth; x += el.clientWidth / 2) {
      el.scrollLeft = Math.min(x, max)
      await new Promise(r => setTimeout(r, 250))
    }
    el.scrollLeft = 0
    await new Promise(r => setTimeout(r, 1500))
  }, SCROLLER)
}

/** The page-side recorder: every animation frame's timestamp and scrollLeft. */
async function record(page, on) {
  await page.evaluate(
    ({ sel, on }) => {
      const el = document.querySelector(sel)
      if (!window.__rec) {
        const rec = (window.__rec = { run: false, frames: [] })
        const loop = t => {
          if (rec.run) rec.frames.push([t, el.scrollLeft])
          requestAnimationFrame(loop)
        }
        requestAnimationFrame(loop)
      }
      if (on) {
        window.__rec.frames = []
      }
      window.__rec.run = on
    },
    { sel: SCROLLER, on },
  )
}

const stats = frames => {
  const dt = frames.slice(1).map((f, i) => f[0] - frames[i][0]).sort((a, b) => a - b) // prettier-ignore
  const at = q => dt[Math.min(dt.length - 1, Math.floor(dt.length * q))]
  return { n: dt.length, p50: at(0.5), p95: at(0.95), max: dt[dt.length - 1] }
}

/**
 * Frozen spans: runs of frames, while the input was still moving the view, in which scrollLeft did not
 * change. Reported apart from the average (a smooth mean hides a long freeze).
 */
function frozen(frames) {
  let count = 0
  let longest = 0
  let from = null
  for (let i = 1; i < frames.length; i++) {
    if (frames[i][1] === frames[i - 1][1]) {
      count++
      from ??= frames[i - 1][0]
      longest = Math.max(longest, frames[i][0] - from)
    } else from = null
  }
  return { count, longest }
}

const builds = page =>
  page.evaluate(id => getSvc('ApplicationShell').widgets.find(w => w.id === id).displayBuilds, ID)

/**
 * The scroll input: scrollLeft advanced 6 px every 10 ms from the page (a steady 100 Hz pointer on a
 * scrollbar thumb), for up to 3 s. Headless Chromium has overlay scrollbars, so a real thumb drag is
 * not available there; each step still fires the same scroll event the thumb would.
 */
const scrollSteadily = (page, step = 6) =>
  page.evaluate(
    async ({ sel, step }) => {
      const el = document.querySelector(sel)
      const max = el.scrollWidth - el.clientWidth
      const t0 = performance.now()
      for (let n = 1; el.scrollLeft < max && performance.now() - t0 < 3000; n++) {
        el.scrollLeft = step * n
        await new Promise(r => setTimeout(r, 10))
      }
    },
    { sel: SCROLLER, step },
  )

for (const zoom of ['fit', 1, 2]) {
  test(`steady horizontal scroll stays smooth at ${zoom === 'fit' ? 'fit' : zoom + 'x'}`, async ({
    page,
  }) => {
    await setZoom(page, zoom)
    await warm(page)
    const before = await builds(page)
    await record(page, true)
    await scrollSteadily(page)
    await page.waitForTimeout(300)
    await record(page, false)
    const frames = await page.evaluate(() => window.__rec.frames)
    // Only the frames while the view was moving: from the first change to the last.
    const moved = frames.filter((f, i) => i > 0 && f[1] !== frames[i - 1][1])
    expect(moved.length, 'the scroll moved the view').toBeGreaterThan(20)
    const live = frames.slice(frames.indexOf(moved[0]) - 1, frames.indexOf(moved[moved.length - 1]) + 1) // prettier-ignore
    const s = stats(live)
    const f = frozen(live)
    console.log(`scroll ${zoom}: frames ${s.n} p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} max ${s.max.toFixed(1)}; frozen frames ${f.count}, longest ${f.longest.toFixed(1)} ms; builds ${(await builds(page)) - before}`) // prettier-ignore
    expect(s.p95, 'frame p95 (ms)').toBeLessThan(P95_MAX_MS)
    expect(s.max, 'longest frame (ms)').toBeLessThan(FRAME_MAX_MS)
  })
}

test('a warm scroll rebuilds no screen display', async ({ page }) => {
  await warm(page)
  const before = await builds(page)
  await page.evaluate(async sel => {
    const el = document.querySelector(sel)
    const max = el.scrollWidth - el.clientWidth
    for (let i = 0; i <= 40; i++) {
      el.scrollLeft = (max * i) / 40
      await new Promise(r => setTimeout(r, 30))
    }
  }, SCROLLER)
  expect(await builds(page), 'IndicatorDisplay builds during a warm scroll').toBe(before)
})
