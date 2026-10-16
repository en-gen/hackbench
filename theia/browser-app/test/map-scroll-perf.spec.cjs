/**
 * Scrolling a long horizontal map stays smooth, en-gen/hackbench#973.
 *
 * Cause it pins: every scroll event re-ran `syncDisplay`, which threw away the "no indicators"
 * outcome of the screens without block indicators and rebuilt their IndicatorDisplay each time
 * (about 44 ms per event on $105), so the main thread missed frames.
 *
 * Input comes from OUTSIDE the page (Playwright page.mouse wheel and thumb drag, sent on a Node
 * timer without awaiting the page), so a stalled main thread cannot slow its own input: the stall
 * shows as a long gap between scrollLeft changes. Frames are read from a requestAnimationFrame
 * recorder in the page. Frozen spans (the gap between consecutive scrollLeft changes while the
 * input is still arriving) are asserted apart from the frame-interval percentiles.
 *
 * Wheel rate is an ASSUMPTION, not a measurement: 30 events per second of deltaX 100 (one Windows
 * wheel notch as Chromium reports it), standing for a held tilt. No tilt wheel was available to
 * measure the real auto-repeat rate; the owner check in the launched build covers the real device.
 *
 * Scope of the thresholds (see changelog.d/973-smooth-horizontal-scroll.md for the numbers): slot
 * $105 (20 screens) of the vanilla ROM, `build:browser`, Playwright's headless Chromium, one
 * machine, every zoom (fit, 1x, 2x, 3x, 4x), 3 runs each. Screens are WARMED first (a pass over
 * the strip, polling until every screen near the view is drawn), so a cold fetch is not counted.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)
// Classic (non-overlay) scrollbars, so the thumb is a real mouse target.
test.use({ launchOptions: { args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'] } }) // prettier-ignore

const INDEX = 0x105
const ID = `hackbench.map-view:${INDEX}`
const SCROLLER = `[id="${ID}"] [data-control="map-scroller"]`
const ZOOMS = ['fit', 1, 2, 3, 4]
const WHEEL = { period: 33, deltaX: 100 } // assumed held-tilt rate, see header
const DRAG = { period: 10, thumbPx: 3 } // a steady 100 Hz pointer moving the thumb 3 px a step
const P95_MAX_MS = 25
const FRAME_MAX_MS = 40
const FROZEN_MAX_MS = 90 // input period 33 ms + two missed frames

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

/** Sets the zoom through the toolbar, the way a user does: fit, or actual size (1x) then zoom-in steps. */
async function setZoom(page, zoom) {
  const click = c => page.locator(`[id="${ID}"] [data-control="${c}"]`).click()
  if (zoom === 'fit') await click('zoom-fit')
  else {
    await click('zoom-actual')
    for (let z = 1; z < zoom; z++) await click('zoom-in')
    await expect(page.locator(SCROLLER)).toHaveAttribute('data-rendered-zoom', String(zoom))
  }
  await page.waitForTimeout(500)
}

/** Resolves when every screen within one view-width of the viewport has its composite drawn. */
const settled = page =>
  page.waitForFunction(sel => {
    const el = document.querySelector(sel)
    const v = el.getBoundingClientRect()
    const comps = [...el.querySelectorAll('canvas[data-layer="screen"]')]
    const near = comps.filter(c => {
      const r = c.getBoundingClientRect()
      return r.right > v.left - v.width && r.left < v.right + v.width
    })
    return near.length > 0 && near.every(c => c.dataset.drawn)
  }, SCROLLER, { timeout: 30000 }) // prettier-ignore

/** One pass over the whole strip and back, half a view at a time, polling until the screens near the view are drawn. */
async function warm(page) {
  const max = await page.evaluate(sel => {
    const el = document.querySelector(sel)
    return [el.scrollWidth - el.clientWidth, el.clientWidth]
  }, SCROLLER)
  for (let x = 0; x <= max[0] + max[1]; x += max[1] / 2) {
    await page.evaluate(([sel, x]) => (document.querySelector(sel).scrollLeft = x), [SCROLLER, Math.min(x, max[0])]) // prettier-ignore
    await settled(page)
  }
  await page.evaluate(sel => (document.querySelector(sel).scrollLeft = 0), SCROLLER)
  await settled(page)
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
      if (on) window.__rec.frames = []
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
 * Frozen spans: the gaps between consecutive scrollLeft changes inside the window where the input
 * was arriving. Input arrives every WHEEL.period ms, so a gap far beyond that is the page failing to
 * show it. Reported apart from the average (a smooth mean hides a long freeze).
 */
function frozen(live) {
  const at = live.filter((f, i) => i > 0 && f[1] !== live[i - 1][1]).map(f => f[0])
  const gaps = at.slice(1).map((t, i) => t - at[i])
  return { changes: at.length, longest: Math.max(0, ...gaps), over: gaps.filter(g => g > FROZEN_MAX_MS).length } // prettier-ignore
}

const builds = page =>
  page.evaluate(id => getSvc('ApplicationShell').widgets.find(w => w.id === id).displayBuilds, ID)

const sleepUntil = t => new Promise(r => setTimeout(r, Math.max(0, t - Date.now())))

/** Sends `steps` inputs on a fixed Node-side schedule, never waiting on the page between them. */
async function drive(period, steps, send) {
  const t0 = Date.now()
  const sent = []
  for (let n = 1; n <= steps; n++) {
    await sleepUntil(t0 + n * period)
    sent.push(send(n))
  }
  await Promise.all(sent)
}

/** Records frames while `input` runs; returns the stats over the window where the view was moving. */
async function measure(page, input) {
  await record(page, true)
  await input()
  await page.waitForTimeout(400)
  await record(page, false)
  const frames = await page.evaluate(() => window.__rec.frames)
  const moved = frames.map((f, i) => i > 0 && f[1] !== frames[i - 1][1] ? i : -1).filter(i => i > 0) // prettier-ignore
  expect(moved.length, 'the input moved the view').toBeGreaterThan(20)
  const live = frames.slice(moved[0] - 1, moved[moved.length - 1] + 1)
  return { frames, live, s: stats(live), f: frozen(live) }
}

/** Where the mouse must sit to wheel the map: inside the scroller, clear of its scrollbar. */
async function centre(page) {
  const b = await page.locator(SCROLLER).boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 3 }
}

function check(label, m, extra = '') {
  const { s, f } = m
  console.log(`${label}: frames ${s.n} p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} max ${s.max.toFixed(1)}; scrollLeft changes ${f.changes}, longest frozen ${f.longest.toFixed(1)} ms, gaps over ${FROZEN_MAX_MS} ms: ${f.over}${extra}`) // prettier-ignore
  expect(f.longest, 'longest frozen span (ms)').toBeLessThan(FROZEN_MAX_MS)
  expect(s.p95, 'frame p95 (ms)').toBeLessThan(P95_MAX_MS)
  expect(s.max, 'longest frame (ms)').toBeLessThan(FRAME_MAX_MS)
}

for (const zoom of ZOOMS) {
  const name = zoom === 'fit' ? 'fit' : `${zoom}x`

  test(`a held horizontal wheel tilt stays smooth at ${name}`, async ({ page }) => {
    await setZoom(page, zoom)
    await warm(page)
    const before = await builds(page)
    const { x, y } = await centre(page)
    await page.mouse.move(x, y)
    const max = await page.evaluate(sel => { const e = document.querySelector(sel); return e.scrollWidth - e.clientWidth }, SCROLLER) // prettier-ignore
    const steps = Math.min(90, Math.ceil(max / WHEEL.deltaX))
    const m = await measure(page, () => drive(WHEEL.period, steps, () => page.mouse.wheel(WHEEL.deltaX, 0))) // prettier-ignore
    const end = await page.evaluate(sel => document.querySelector(sel).scrollLeft, SCROLLER)
    const delta = (await builds(page)) - before
    check(`wheel ${name}`, m, `; builds ${delta}; scrolled ${end} of ${max}`)
    expect(end, 'the wheel input reached the scroller').toBeGreaterThan(Math.min(max, steps * WHEEL.deltaX) * 0.9) // prettier-ignore
    expect(delta, 'IndicatorDisplay builds while scrolling warm screens').toBe(0)
  })

  test(`a scrollbar thumb drag stays smooth at ${name}`, async ({ page }) => {
    await setZoom(page, zoom)
    await warm(page)
    const before = await builds(page)
    const g = await page.evaluate(sel => {
      const e = document.querySelector(sel)
      const r = e.getBoundingClientRect()
      return { l: r.left, bottom: r.top + e.clientHeight, w: e.clientWidth, sw: e.scrollWidth, bar: e.offsetHeight - e.clientHeight } // prettier-ignore
    }, SCROLLER)
    expect(g.bar, 'the horizontal scrollbar takes space (not an overlay one)').toBeGreaterThan(0)
    const thumbW = (g.w * g.w) / g.sw
    const y = g.bottom + g.bar / 2
    await page.mouse.move(g.l + thumbW / 2 + 1, y)
    await page.mouse.down()
    const steps = Math.min(150, Math.floor((g.w - thumbW) / DRAG.thumbPx) - 2)
    const m = await measure(page, () => drive(DRAG.period, steps, n => page.mouse.move(g.l + thumbW / 2 + 1 + n * DRAG.thumbPx, y))) // prettier-ignore
    await page.mouse.up()
    const delta = (await builds(page)) - before
    check(`drag ${name}`, m, `; builds ${delta}`)
    expect(delta, 'IndicatorDisplay builds while dragging warm screens').toBe(0)
  })
}

test('a warm scroll rebuilds no screen display, at every zoom', async ({ page }) => {
  for (const zoom of ZOOMS) {
    await setZoom(page, zoom)
    const cold = await builds(page)
    expect(typeof cold, `displayBuilds counter exists at ${zoom}`).toBe('number')
    await warm(page)
    const before = await builds(page)
    expect(before, `warming built displays at ${zoom}`).toBeGreaterThan(cold)
    await page.evaluate(async sel => {
      const el = document.querySelector(sel)
      const max = el.scrollWidth - el.clientWidth
      for (let i = 0; i <= 40; i++) {
        el.scrollLeft = (max * i) / 40
        await new Promise(r => setTimeout(r, 30))
      }
    }, SCROLLER)
    expect(await builds(page), `builds during a warm scroll at ${zoom}`).toBe(before)
  }
})
