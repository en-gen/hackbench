/**
 * Play on the map toolbar runs the map's own scroll routines from the ROM and shows what they move (#1242).
 *
 * Vanilla ROM. Map $009 moves by itself: Layer 2 shifts against the map by the run's offsets and the camera
 * frame follows the camera. Map $1EF waits for Mario on Layer 2: it plays as if he stands there, says so, and
 * shows no camera frame. A map with no routine has no button. Stop puts what is VISIBLE back exactly (the
 * display canvas where an indicator screen has one, else the composite), and nothing is written to the project.
 * Waits are by the run's own data: the first frame with a nonzero offset comes from the `mapMotion` reply.
 * Checked on that reply and on the canvases the user sees: the offset the widget draws at each sampled frame is
 * the run's value for that frame, and each drawn screen canvas is keyed to it. During play a hover over an
 * indicator and a layer toggle leave every screen moving.
 * Block indicators stay visible while it plays (D52); a refused map has a disabled button with the reason; a
 * hidden tab stops it.
 * Plants for the verifier. (1) In `playTick` (map-view-widget.tsx) use `m.shiftY[f + 1]`: the offset assertion goes
 * red. (2) In `playTick` drop `this.syncDisplays()`: a screen with indicators keeps the display built before Play
 * (width > 0 over a hidden composite) while the offset moves. Screen 3 of $009 has indicators and Layer 2
 * pixels, so its visible hash then stays equal across a 20-row move and `frozenScreens` lists it in the stop
 * test and in the hover/toggle test; $009's screen 0 has indicators but no Layer 2 pixels, so only its display
 * key is asserted. The Layer 2 screens are read from the widget's state, and the set must not be empty.
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
const FRAME_MS = 1000 / 60
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

/**
 * The widget behind a map tab and what is visible, read in one synchronous step. Per drawn screen: a hash of the
 * canvas on top (the display canvas when it has width, else the composite), the composite's key, whether the
 * composite is hidden under a display, and the display's width. A screen not drawn yet is left out.
 */
const snapshot = (page, slot) =>
  page.evaluate(slot => {
    const root = document.querySelector(`[id="hackbench.map-view:${slot}"]`)
    const w = getSvc('ApplicationShell').widgets.find(x => x.id === `hackbench.map-view:${slot}`)
    const hash = c => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let h = 2166136261
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 16777619)
      return h >>> 0
    }
    const screens = {}
    // Layer 2 pixels, from the widget's own state: a screen whose Layer 2 planes are both empty cannot change
    // its picture when Layer 2 shifts.
    const hasL2 = n => {
      const shot = w.screens.get(w.key(Number(n)))
      return !!shot && (!!shot.planes.l2Low || !!shot.planes.l2High)
    }
    for (const c of root.querySelectorAll('canvas[data-layer="screen"]')) {
      if (!c.width || !c.dataset.drawn) continue
      const d = root.querySelector(
        `canvas[data-layer="display"][data-screen="${c.dataset.screen}"]`,
      )
      const top = d && d.width > 0 ? d : c
      screens[c.dataset.screen] = {
        h: hash(top),
        key: c.dataset.drawn,
        hasL2: hasL2(c.dataset.screen),
        displayWidth: d ? d.width : 0,
        compositeHidden: c.style.visibility === 'hidden',
      }
    }
    const f = root.querySelector('[data-control="camera-frame"]')
    return {
      playing: w.playing,
      frame: w.playFrame,
      shift: w.playShift,
      screens,
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

/**
 * The screens with indicators (a display), split by whether they have Layer 2 pixels. Only the first group can
 * change its picture when the offset moves.
 */
const indicatorScreens = snap => {
  const shown = Object.entries(snap.screens).filter(([, v]) => v.displayWidth > 0)
  return {
    l2: shown.filter(([, v]) => v.hasL2).map(([s]) => s),
    plain: shown.filter(([, v]) => !v.hasL2).map(([s]) => s),
  }
}

/**
 * Over a span in which the offset moves by at least 20 rows: the indicator screens with Layer 2 pixels whose
 * VISIBLE canvas did not change, and the indicator screens without whose composite key did not advance. A display
 * that is not redrawn per frame shows in the first list; a composite-key check alone would not catch it.
 */
async function frozenScreens(page, slot, groups) {
  const a = await snapshot(page, slot)
  await expect
    .poll(async () => Math.abs((await snapshot(page, slot)).shift - a.shift), {
      timeout: 30000,
      intervals: [100],
    })
    .toBeGreaterThanOrEqual(20)
  const b = await snapshot(page, slot)
  const same = (s, f) => !a.screens[s] || !b.screens[s] || a.screens[s][f] === b.screens[s][f]
  return [...groups.l2.filter(s => same(s, 'h')), ...groups.plain.filter(s => same(s, 'key'))]
}

/** Waits until the run is at a frame whose offset is not zero; the wait comes from the run, not from a number here. */
async function untilShifted(page, slot, run) {
  const first = run.shiftY.findIndex(v => v !== 0)
  expect(first).toBeGreaterThanOrEqual(0)
  await expect
    .poll(async () => (await snapshot(page, slot)).shift, {
      timeout: first * FRAME_MS + 15000,
      intervals: [200],
    })
    .not.toBe(0)
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
  await untilShifted(page, 0x9, run)
  const lefts = new Set()
  const shifts = new Set()
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300)
    const s = await snapshot(page, 0x9)
    expect(s.playing).toBe(true)
    // The offset in use is the run's value for the frame shown, and every drawn screen canvas is keyed to it.
    expect(s.shift).toBe(run.shiftY[s.frame])
    const keys = Object.values(s.screens).map(v => v.key)
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(key.endsWith(`:${s.shift}`)).toBe(true)
    lefts.add(s.frameLeft)
    shifts.add(s.shift)
  }
  // Frames advance by time (about 60 a second), the camera frame follows the camera, and the offset changes.
  expect(shifts.size).toBeGreaterThan(1)
  expect(lefts.size).toBeGreaterThan(1)
  expect([...lefts].every(v => v !== null)).toBe(true)
})

test('stop restores what is visible exactly, indicator screens included, and writes nothing', async ({
  page,
}) => {
  await openMap(page, 0x9)
  const run = await motionOf(page, 0x9)
  await expect(page.locator(playOf(0x9))).toBeEnabled({ timeout: 30000 })
  // Let the indicators build: at least one screen shows a display canvas at rest.
  await expect
    .poll(
      async () => Object.values((await snapshot(page, 0x9)).screens).some(v => v.displayWidth > 0),
      {
        timeout: 30000,
      },
    )
    .toBe(true)
  const stack = () =>
    page.evaluate(mp => getSvc('Symbol(ProjectService)').editStack(mp), project.manifestPath)
  const [before, stackBefore, opsBefore] = [await snapshot(page, 0x9), await stack(), opsListing()]
  await page.locator(playOf(0x9)).click()
  await untilShifted(page, 0x9, run)
  const during = await snapshot(page, 0x9)
  // Indicators stay up while playing (D52): a screen that had a display at rest still has one over its composite.
  for (const [s, v] of Object.entries(before.screens)) {
    if (v.displayWidth === 0) continue
    expect(during.screens[s]?.displayWidth).toBeGreaterThan(0)
    expect(during.screens[s]?.compositeHidden).toBe(true)
  }
  const indicated = indicatorScreens(before)
  expect(indicated.l2.length).toBeGreaterThan(0)
  expect(await frozenScreens(page, 0x9, indicated)).toEqual([])
  await page.locator(playOf(0x9)).click()
  await expect(page.locator(playOf(0x9))).toHaveAttribute('data-play-state', 'ready')
  await expect
    .poll(
      async () => {
        const a = await snapshot(page, 0x9)
        return Object.entries(before.screens).every(([s, v]) => {
          const x = a.screens[s]
          return (
            x &&
            x.h === v.h &&
            x.key === v.key &&
            x.displayWidth === v.displayWidth &&
            x.compositeHidden === v.compositeHidden
          )
        })
      },
      { timeout: 15000 },
    )
    .toBe(true)
  const after = await snapshot(page, 0x9)
  expect(after.playing).toBe(false)
  await expect(page.locator(`${rootOf(0x9)} [data-control="camera-frame"]`)).toHaveCount(0)
  expect(await stack()).toEqual(stackBefore)
  expect(opsListing()).toEqual(opsBefore)
})

test('while playing, a hover over an indicator and a layer toggle leave every screen moving', async ({
  page,
}) => {
  await openMap(page, 0x9)
  const run = await motionOf(page, 0x9)
  await expect(page.locator(playOf(0x9))).toBeEnabled({ timeout: 30000 })
  await expect
    .poll(
      async () => Object.values((await snapshot(page, 0x9)).screens).some(v => v.displayWidth > 0),
      {
        timeout: 30000,
      },
    )
    .toBe(true)
  const indicated = indicatorScreens(await snapshot(page, 0x9))
  expect(indicated.l2.length).toBeGreaterThan(0)
  await page.locator(playOf(0x9)).click()
  await untilShifted(page, 0x9, run)
  // Moving, by the same span rule as the stop test: no indicator screen stands still while the offset moves.
  const moving = async () => (await frozenScreens(page, 0x9, indicated)).length === 0
  // Indicators stay up while Play runs (D52): a display canvas with width sits over a hidden composite.
  const shown = async () =>
    Object.values((await snapshot(page, 0x9)).screens).some(
      v => v.displayWidth > 0 && v.compositeHidden,
    )
  await expect.poll(shown, { timeout: 20000 }).toBe(true)
  // The pointer on an actual indicator, at the position the widget holds for it.
  const at = await page.evaluate(() => {
    const w = getSvc('ApplicationShell').widgets.find(x => x.id === 'hackbench.map-view:9')
    const i = w.blocks.indicators[0]
    const edge = document.querySelector('[id="hackbench.map-view:9"] [data-control="map-edge"]')
    const r = edge.getBoundingClientRect()
    const mapW = w.mapLayout.width * w.mapLayout.screenCount
    const mapH = w.mapLayout.height
    const sc = edge.closest('[data-control="map-scroller"]')
    const target = {
      x: r.left + ((i.x + 8) * r.width) / mapW,
      y: r.top + ((i.y + 8) * r.height) / mapH,
    }
    const view = sc.getBoundingClientRect()
    sc.scrollBy(target.x - (view.left + view.width / 2), target.y - (view.top + view.height / 2))
    const r2 = edge.getBoundingClientRect()
    return {
      id: `${i.plane}:${i.x}:${i.y}`,
      x: r2.left + ((i.x + 8) * r2.width) / mapW,
      y: r2.top + ((i.y + 8) * r2.height) / mapH,
    }
  })
  await page.mouse.move(at.x + 1, at.y)
  await page.mouse.move(at.x, at.y)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const w = getSvc('ApplicationShell').widgets.find(x => x.id === 'hackbench.map-view:9')
          return w.hover ? `${w.hover.plane}:${w.hover.x}:${w.hover.y}` : null
        }),
      { timeout: 15000 },
    )
    .toBe(at.id)
  await expect.poll(moving, { timeout: 20000 }).toBe(true)
  await expect.poll(shown, { timeout: 20000 }).toBe(true)
  // A layer toggle is honored and Play keeps going.
  const l1 = page.locator(`${rootOf(0x9)} [data-control="layer-l1"]`)
  await l1.click()
  await expect.poll(moving, { timeout: 20000 }).toBe(true)
  expect((await snapshot(page, 0x9)).playing).toBe(true)
  await l1.click()
  await expect.poll(moving, { timeout: 20000 }).toBe(true)
})

test('a refused map has a disabled button that says why, and moves nothing', async ({ page }) => {
  for (const [slot, reason] of [
    [0x122, /depends on where Mario is/],
    [0xd4, /camera follows Mario/],
  ]) {
    await openMap(page, slot)
    const run = await motionOf(page, slot)
    expect(run.status).toBe('unavailable')
    const play = page.locator(playOf(slot))
    await expect(play).toBeDisabled({ timeout: 30000 })
    await expect(play).toHaveAttribute('data-play-state', 'refused')
    await expect(play).toHaveAttribute('title', reason)
    expect((await snapshot(page, slot)).playing).toBe(false)
  }
})

test('a tab that is hidden stops Play, and shows the map at rest when it comes back', async ({
  page,
}) => {
  await openMap(page, 0x9)
  const run = await motionOf(page, 0x9)
  await expect(page.locator(playOf(0x9))).toBeEnabled({ timeout: 30000 })
  await page.locator(playOf(0x9)).click()
  await untilShifted(page, 0x9, run)
  await openMap(page, 0x105)
  await expect.poll(async () => (await snapshot(page, 0x9)).playing, { timeout: 15000 }).toBe(false)
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.map-view:9')
  })
  await expect(page.locator(playOf(0x9))).toHaveAttribute('data-play-state', 'ready')
  expect((await snapshot(page, 0x9)).shift).toBe(0)
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
  await untilShifted(page, 0x1ef, run)
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
