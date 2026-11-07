/**
 * Play on the map toolbar runs the map's own scroll routines from the ROM and shows what they move (#1242).
 *
 * Vanilla ROM. Map $009 moves by itself: Layer 2 shifts against the map by the run's offsets and the camera
 * frame follows the camera. Map $1EF waits for Mario on Layer 2: it plays as if he stands there, says so, and
 * shows no camera frame. A map with no routine has no button. Stop puts the composite pixels back exactly, and
 * nothing is written to the project.
 * Checked on the node reply (`mapMotion`) and the canvases the user sees: the offset the widget draws at each
 * sampled frame is the run's value for that frame, and the screen canvas is keyed to it.
 * Plant for the verifier: in `playTick` (map-view-widget.tsx) use `m.shiftY[f + 1]`; the offset assertion goes red.
 * NOT covered: the exact pixels of a shifted Layer 2 (unit tests cover the shift and the wrap).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`
const playOf = slot => `${rootOf(slot)} [data-control="map-play"]`
const opened = []
let tmp
let project

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-map-play-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    for (const id of ids) {
      try {
        await getSvc('ApplicationShell').closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function openMap(page, slot) {
  await page.evaluate(
    async ({ mp, slot }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', {
        index: slot,
      })
      await w.open({ manifestPath: mp, index: slot, label: slot.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, slot },
  )
  opened.push(`hackbench.map-view:${slot}`)
  await page.locator(`${rootOf(slot)} .hb-map-view-strip`).waitFor({ timeout: 30000 })
}

/** The widget behind a map tab, its drawn composites and its play state, read in one synchronous step. */
const snapshot = (page, slot) =>
  page.evaluate(slot => {
    const w = getSvc('ApplicationShell').widgets.find(x => x.id === `hackbench.map-view:${slot}`)
    const sums = {}
    for (const c of document.querySelectorAll(
      `[id="hackbench.map-view:${slot}"] canvas[data-layer="screen"]`,
    )) {
      if (!c.width) continue
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let h = 0
      for (let i = 0; i < d.length; i += 4)
        h = (h * 31 + d[i] + 3 * d[i + 1] + 7 * d[i + 2] + 13 * d[i + 3]) | 0
      sums[c.dataset.screen] = { h, key: c.dataset.drawn }
    }
    const f = document.querySelector(
      `[id="hackbench.map-view:${slot}"] [data-control="camera-frame"]`,
    )
    return {
      playing: w.playing,
      frame: w.playFrame,
      shift: w.playShift,
      sums,
      frameLeft: f ? parseFloat(f.style.left) : null,
    }
  }, slot)

const motionOf = (page, slot) =>
  page.evaluate(({ mp, slot }) => getSvc('Symbol(ProjectService)').mapMotion(mp, slot), {
    mp: project.manifestPath,
    slot,
  })

const opsListing = () => {
  const dir = path.join(tmp, 'MyHack', 'ops')
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []
}

test('$009: Layer 2 is drawn at the run offset of the frame it is on, and the camera frame moves', async ({
  page,
}) => {
  await openMap(page, 0x9)
  const run = await motionOf(page, 0x9)
  expect(run.status).toBe('ok')
  expect(run.kind).toBe('own-motion')
  expect(run.cameraMoved).toBe(true)
  await expect(page.locator(playOf(0x9))).toBeEnabled({ timeout: 30000 })
  await expect(page.locator(`${rootOf(0x9)} [data-control="camera-frame"]`)).toHaveCount(0)
  await page.locator(playOf(0x9)).click()
  await expect(page.locator(playOf(0x9))).toHaveAttribute('data-play-state', 'playing')
  const lefts = new Set()
  const shifts = new Set()
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(300)
    const s = await snapshot(page, 0x9)
    expect(s.playing).toBe(true)
    // The offset in use is the run's value for the frame shown, and every screen canvas is keyed to it.
    expect(s.shift).toBe(run.shiftY[s.frame])
    for (const { key } of Object.values(s.sums)) expect(key.endsWith(`:${s.shift}`)).toBe(true)
    lefts.add(s.frameLeft)
    shifts.add(s.shift)
  }
  // Frames advance by time (about 60 a second), the camera frame follows the camera, and the offset changes.
  expect(shifts.size).toBeGreaterThan(1)
  expect(lefts.size).toBeGreaterThan(1)
  expect([...lefts].every(v => v !== null)).toBe(true)
})

test('stop restores the composite pixels exactly and writes nothing to the project', async ({
  page,
}) => {
  await openMap(page, 0x9)
  await expect(page.locator(playOf(0x9))).toBeEnabled({ timeout: 30000 })
  await page.waitForTimeout(1500)
  const stack = () =>
    page.evaluate(mp => getSvc('Symbol(ProjectService)').editStack(mp), project.manifestPath)
  const [before, stackBefore, opsBefore] = [await snapshot(page, 0x9), await stack(), opsListing()]
  await page.locator(playOf(0x9)).click()
  // Long enough for Layer 2 to have moved off its place on a screen.
  await page.waitForTimeout(2500)
  const during = await snapshot(page, 0x9)
  expect(during.shift).not.toBe(0)
  expect(Object.keys(during.sums).some(s => during.sums[s].h !== before.sums[s]?.h)).toBe(true)
  await page.locator(playOf(0x9)).click()
  await expect(page.locator(playOf(0x9))).toHaveAttribute('data-play-state', 'ready')
  await page.waitForTimeout(500)
  const after = await snapshot(page, 0x9)
  expect(after.playing).toBe(false)
  for (const [s, v] of Object.entries(before.sums)) expect(after.sums[s]).toEqual(v)
  await expect(page.locator(`${rootOf(0x9)} [data-control="camera-frame"]`)).toHaveCount(0)
  expect(await stack()).toEqual(stackBefore)
  expect(opsListing()).toEqual(opsBefore)
})

test('$1EF: plays as if Mario stands on Layer 2, says so, and shows no camera frame', async ({
  page,
}) => {
  await openMap(page, 0x1ef)
  const run = await motionOf(page, 0x1ef)
  expect(run.status).toBe('ok')
  expect(run.kind).toBe('needs-mario')
  expect(run.cameraMoved).toBe(false)
  const play = page.locator(playOf(0x1ef))
  await expect(play).toBeEnabled({ timeout: 30000 })
  await expect(play).toHaveAttribute('title', /Mario/)
  await play.click()
  await page.waitForTimeout(1500)
  const s = await snapshot(page, 0x1ef)
  expect(s.playing).toBe(true)
  expect(s.shift).toBe(run.shiftY[s.frame])
  expect(s.shift).toBeGreaterThan(0)
  await expect(page.locator(`${rootOf(0x1ef)} [data-control="camera-frame"]`)).toHaveCount(0)
})

test('a map with no scroll routine has no play button', async ({ page }) => {
  await openMap(page, 0x105)
  const run = await motionOf(page, 0x105)
  expect(run.status).toBe('none')
  await page.waitForTimeout(3000)
  await expect(page.locator(playOf(0x105))).toHaveCount(0)
})
