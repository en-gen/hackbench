/**
 * The emulator view, end to end against the shell and a real libretro core.
 *
 * The defect class this guards against is a meter that cannot go red: a
 * requestAnimationFrame counter reads ~60fps whether or not the core itself
 * is advancing, and a leaked second polling loop from a previous stop()/
 * start() shows up as a subtle rate change, not a crash. So every assertion
 * here is read from the CORE'S OWN frame counter (never rAF), and the
 * "planted defect" case at the bottom proves that oracle can actually fail.
 *
 * The ROM and core fixtures are local-machine files, gitignored the same way
 * (docs/testing.md's copyright rule; vendor/cores/ is untracked, .gitignore:
 * 107). Absent, this suite SKIPS rather than silently passing.
 *
 * Reaches the widget's `driver`/`meter` fields directly (TypeScript
 * `protected`, plain properties at runtime), the same way load-maps.spec.cjs
 * reaches `w.model`: no test-only global hook duplicating that surface.
 *
 * Does not leave real per-machine state behind: the whole suite snapshots and
 * restores core-registry.json, rom-registry.json and recent-projects.json in
 * application data, so running it does not silently forget whatever core or
 * projects the developer running it had registered.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords, makeUntitledAndUnlocated } = require('./rom-words.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'
// Resolved against the repo root this file lives in, NOT a hardcoded machine
// path: vendor/cores/ is gitignored per checkout (.gitignore:107), so a fixed
// absolute default would only ever work on the one machine it was written on.
const CORE_JS =
  process.env.HB_CORE_JS ||
  path.resolve(__dirname, '../../../vendor/cores/snes9x-wasm/snes9x_libretro.js')

const haveRom = fs.existsSync(ROM)
const haveCore = fs.existsSync(CORE_JS) && fs.existsSync(CORE_JS.replace(/\.js$/, '.wasm'))

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  const wm = getSvc('WidgetManager')
  return wm.getOrCreateWidget(id)
}
async function revealEmulator() {
  // Same route MapExplorerContribution.initializeLayout() uses: the view
  // contribution knows how to attach itself to the correct shell area,
  // rather than this test duplicating that placement logic.
  const contribution = getSvc('EmulatorContribution')
  await contribution.openView({ activate: true, reveal: true })
  return getWidget('hackbench.emulator-view')
}`

// ── per-machine state isolation ──────────────────────────────────────────
// Mirrors src/project/appData.ts exactly (there is no way to reach that
// TypeScript from a .cjs Playwright spec without a build step).
function appDataDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'hackbench')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'hackbench')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'hackbench')
}
const REGISTRY_FILES = ['core-registry.json', 'rom-registry.json', 'recent-projects.json']
let registrySnapshot = {}

test.beforeAll(() => {
  const dir = appDataDir()
  for (const name of REGISTRY_FILES) {
    const p = path.join(dir, name)
    registrySnapshot[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
})

test.afterAll(() => {
  const dir = appDataDir()
  for (const name of REGISTRY_FILES) {
    const p = path.join(dir, name)
    const original = registrySnapshot[name]
    if (original === null) fs.rmSync(p, { force: true })
    else fs.writeFileSync(p, original, 'utf8')
  }
})

let tmp

test.beforeEach(async ({ page }) => {
  test.skip(
    !haveRom || !haveCore,
    `fixtures not present on this machine (ROM present: ${haveRom}, core present: ${haveCore}); ` +
      'this suite is not something a fresh clone can run and must SKIP rather than pass or fail silently.',
  )
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-emu-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(async ({ page }) => {
  // Stop whatever is running before the page navigates away on the next test,
  // so a leaked loop from one test cannot bleed frame-count noise into the next.
  await page
    .evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.stop())
    .catch(() => {})
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Create a project, point EmulatorService's registry state, and load it into the widget. */
async function setupProject(page, dir, { withCore = true, romPath = ROM } = {}) {
  return page.evaluate(
    async ({ romPath, corePath, directory, withCore }) => {
      const emu = getSvc('Symbol(EmulatorService)')
      const projects = getSvc('Symbol(ProjectService)')
      const ctx = getSvc('ProjectContext')
      if (!emu || !projects || !ctx) return { error: 'services not resolvable from the frontend' }

      if (withCore) {
        const r = await emu.locateCore(corePath)
        if (r.status !== 'ok') return { error: `locateCore refused the fixture core: ${r.message}` }
      } else {
        await emu.forgetCore()
      }

      const project = await projects.createProject({ romPath, name: 'MyHack', directory })
      const w = await getWidget('hackbench.emulator-view')
      ctx.current = project
      await w.refresh()
      return { manifestPath: project.manifestPath, state: w.state }
    },
    { romPath, corePath: CORE_JS, directory: dir, withCore },
  )
}

/** Boot the core through the widget's own start(), the same path the Start button uses. */
async function bootAndWaitForFrames(page, minFrames = 10) {
  await page.evaluate(async () => {
    await (await getWidget('hackbench.emulator-view')).start()
  })
  await page.waitForFunction(
    async () => (await getWidget('hackbench.emulator-view')).driver.isBooted(),
    null,
    { timeout: 60000 },
  )
  await page.waitForFunction(
    async min => (await getWidget('hackbench.emulator-view')).driver.frameCount() > min,
    minFrames,
    { timeout: 30000 },
  )
}

/** pumpTicks accrued over one real second, the driver's own tick counter. */
async function pumpTicksPerSecond(page) {
  const t0 = await page.evaluate(
    async () => (await getWidget('hackbench.emulator-view')).driver.pumpTicks,
  )
  await page.waitForTimeout(1000)
  const t1 = await page.evaluate(
    async () => (await getWidget('hackbench.emulator-view')).driver.pumpTicks,
  )
  return t1 - t0
}

/**
 * Confirm the canvas the widget renders is actually the one on screen:
 * attached to the document, sized, and visible. This is the part of "paints
 * the canvas" that is genuinely checkable from outside the core's own render
 * loop; pixel content is verified separately, through the core's own
 * screenshot command, because this core's WebGL context has no
 * preserveDrawingBuffer, so the drawing buffer clears before any
 * page.evaluate() can observe it.
 */
async function liveCanvasIsAttached(page) {
  return page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    const canvas = w.node.querySelector('canvas')
    if (!canvas) return { attached: false, reason: 'no canvas element' }
    const rect = canvas.getBoundingClientRect()
    const style = getComputedStyle(canvas)
    return {
      attached:
        canvas.isConnected &&
        canvas.width > 0 &&
        canvas.height > 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none',
      width: canvas.width,
      height: canvas.height,
      rectWidth: rect.width,
      rectHeight: rect.height,
    }
  })
}

function distinctColorCount(pixels) {
  const distinct = new Set()
  for (let i = 0; i < pixels.length; i += 4)
    distinct.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
  return distinct.size
}

test('with no project open, the emulator view asks for one', async ({ page }) => {
  const state = await page.evaluate(async () => (await getWidget('hackbench.emulator-view')).state)
  expect(state.kind).toBe('no-project')
})

test('with no core registered, the emulator view offers to locate one', async ({ page }) => {
  const result = await setupProject(page, path.join(tmp, 'NoCore'), { withCore: false })
  expect(result.error).toBeUndefined()
  expect(result.state.kind).toBe('no-core')

  await page.evaluate(async () => {
    await revealEmulator()
  })
  await page.waitForSelector('#hackbench\\.emulator-view .hb-emulator-message button', {
    timeout: 15000,
  })
  const label = await page
    .locator('#hackbench\\.emulator-view .hb-emulator-message button')
    .textContent()
  expect(label).toMatch(/locate core/i)
})

test('a cartridge not on this machine asks to be located, mirroring the map explorer', async ({
  page,
}) => {
  const dir = path.join(tmp, 'Shared')
  const setup = await setupProject(page, dir)
  expect(setup.error).toBeUndefined()

  const manifestPath = setup.manifestPath
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const state = await page.evaluate(async mp => {
    const projects = getSvc('Symbol(ProjectService)')
    const ctx = getSvc('ProjectContext')
    const w = await getWidget('hackbench.emulator-view')
    ctx.current = await projects.openProject(mp)
    await w.refresh()
    return w.state
  }, manifestPath)

  expect(state.kind).toBe('rom-not-located')
  expect(state.title).toContain('SOMEONE ELSES CART')
})

/**
 * The core boot, run, canvas and honest-fps oracles together, since booting a
 * real core is the expensive part and these all need the same live instance.
 */
test('the core boots, runs at real speed, paints the canvas, and survives a restart', async ({
  page,
}) => {
  test.setTimeout(150000)

  const setup = await setupProject(page, path.join(tmp, 'Runs'))
  expect(setup.error).toBeUndefined()
  expect(setup.state.kind).toBe('ready')
  await page.evaluate(async () => {
    await revealEmulator()
  })

  await bootAndWaitForFrames(page, 30)

  // ── the honest oracle: sampled from the core's own frame counter ────────
  // 20s, not 3: a short sample cannot distinguish "runs at full speed" from
  // "ticked once and stalled," which is exactly the failure class this exists
  // to catch.
  await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    w.meter.start(() => w.driver.frameCount())
  })
  await page.waitForTimeout(20000)
  const stats = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    w.meter.stop()
    return w.meter.stats()
  })

  expect(stats.samples).toBeGreaterThan(10)
  // SNES is 60fps; generous band for CI/dev-machine variance, nowhere near
  // the ~60x gap a stalled core or a rAF-only meter would hide.
  expect(stats.overallFps).toBeGreaterThan(45)
  expect(stats.overallFps).toBeLessThan(75)
  // A single isolated span can be a shared-main-thread GC/layout hiccup, not
  // a stall; a real freeze shows as several in a row.
  expect(
    stats.longestFrozenRun,
    `span fps was ${JSON.stringify(stats.spanFps)}`,
  ).toBeLessThanOrEqual(1)

  // ── the canvas the widget renders is the one actually on screen ─────────
  const attachment = await liveCanvasIsAttached(page)
  expect(attachment.attached, `canvas geometry: ${JSON.stringify(attachment)}`).toBe(true)

  // ── the picture is not a black or uniform rectangle ──────────────────────
  // Pixel content comes from the core's own screenshot command, not a
  // browser-side canvas capture (see liveCanvasIsAttached's comment on why).
  // Retried a few times spaced out: this repo's own measurement puts the
  // title screen's FadeOutBackToTitle around 28s from boot, and a single
  // sample near that instant can catch a near-black transition frame that is
  // not a bug.
  let frame = null
  for (let attempt = 0; attempt < 4 && !frame; attempt++) {
    const png = await page.evaluate(async () => {
      const w = await getWidget('hackbench.emulator-view')
      return Array.from(await w.driver.screenshotPng())
    })
    const pixels = await page.evaluate(async bytes => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
      const bitmap = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const cx = c.getContext('2d')
      cx.drawImage(bitmap, 0, 0)
      return Array.from(cx.getImageData(0, 0, c.width, c.height).data)
    }, png)
    if (distinctColorCount(pixels) > 3) {
      frame = pixels
      break
    }
    await page.waitForTimeout(2000)
  }
  expect(frame, 'no attempt over four tries found a non-uniform frame').not.toBeNull()
  expect(
    distinctColorCount(frame),
    'a uniform canvas passes an "is it there" check and shows nothing',
  ).toBeGreaterThan(3)

  // ── start, stop, and start again: the exact leaked-loop defect shape ────
  // `before`/`after` are sampled around the SECOND start specifically, not
  // from the top of the test: sampling `before` any earlier already has the
  // core's own 20+ seconds of prior running satisfy `after > before` on its
  // own, regardless of whether the restart itself does anything. That is the
  // exact "test passes with the feature dead" shape -- e.g. someone adds
  // `this.module = null` to stop() as tidy-up (dispose() already does it),
  // and start()'s `!this.module` guard then makes every restart a permanent
  // black canvas while this test's name still says "survives a restart".
  const firstStartRate = await pumpTicksPerSecond(page)
  // Without this floor, a leak check further down could pass by both sides
  // collapsing toward zero under throttling, proving nothing.
  expect(firstStartRate, 'baseline pump rate before stop/start').toBeGreaterThan(30)

  await page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.stop())

  // stop() must actually kill the polling loop, not just flip a flag: a
  // missing generation bump there only shows up in THIS window, while the
  // widget's own state already says "stopped" and the frame-count/fps checks
  // above have long since passed.
  const stoppedTicks = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    const t0 = w.driver.pumpTicks
    await new Promise(r => setTimeout(r, 800))
    return w.driver.pumpTicks - t0
  })
  expect(
    stoppedTicks,
    'ticks accumulated while stopped; stop() must invalidate the loop, not just flip a flag',
  ).toBe(0)

  const beforeSecondStart = await page.evaluate(async () =>
    (await getWidget('hackbench.emulator-view')).driver.frameCount(),
  )
  await page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.start())
  await page.waitForTimeout(200)

  const secondStartRate = await pumpTicksPerSecond(page)
  // The floor is what actually catches a dead restart: without it, a
  // permanently frozen core after start() (secondStartRate === 0) still
  // satisfies "less than 1.5x the baseline".
  expect(
    secondStartRate,
    'pump rate after the second start must show real activity, not a frozen loop',
  ).toBeGreaterThan(30)
  expect(
    secondStartRate,
    `pump ticks/sec was ${firstStartRate} before stop/start and ${secondStartRate} after; ` +
      'a leaked loop would roughly double this',
  ).toBeLessThan(firstStartRate * 1.5)

  const afterSecondStart = await page.evaluate(async () =>
    (await getWidget('hackbench.emulator-view')).driver.frameCount(),
  )
  expect(
    afterSecondStart,
    'the frame counter must genuinely resume advancing after the SECOND start, not merely have advanced earlier',
  ).toBeGreaterThan(beforeSecondStart)
})

/**
 * The oracle proven able to fail, case 1: a meter built on rAF instead of the
 * core's own counter cannot tell a frozen core from a healthy one, because
 * rAF ticks at display rate regardless. Plant the freeze (pause the core
 * directly, bypassing the driver) and show the naive measurement lies while
 * the real one reports the truth.
 */
test('planted defect: a paused core reads as frozen on the real meter, not as ~60fps', async ({
  page,
}) => {
  test.setTimeout(60000)

  const setup = await setupProject(page, path.join(tmp, 'Frozen'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 10)

  const result = await page.evaluate(async () => {
    // Reach past the driver's own stop() to pause the core directly, so the
    // driver still believes it is running -- exactly the "meter that cannot
    // fail" shape: the widget's own state says nothing is wrong.
    const w = await getWidget('hackbench.emulator-view')
    w.driver.module.pauseMainLoop()

    let rafCount = 0
    let rafRunning = true
    const raf = () => {
      if (!rafRunning) return
      rafCount++
      requestAnimationFrame(raf)
    }
    requestAnimationFrame(raf)

    const honestStart = w.driver.frameCount()
    w.meter.start(() => w.driver.frameCount())
    await new Promise(r => setTimeout(r, 4000))
    w.meter.stop()
    rafRunning = false
    const honestEnd = w.driver.frameCount()

    return {
      honestDelta: honestEnd - honestStart,
      honestStats: w.meter.stats(),
      naiveRafFps: Math.round(rafCount / 4),
    }
  })

  // The naive rAF-counting oracle is exactly the bug class from the brief: it
  // reports a healthy framerate regardless of whether the core moved.
  expect(
    result.naiveRafFps,
    'rAF ticks at display rate whether or not the core does',
  ).toBeGreaterThan(30)
  // The real oracle, reading the core's own counter, is not fooled.
  expect(result.honestDelta, 'the core is paused; its own counter must not advance').toBe(0)
  expect(result.honestStats.frozenSpans).toBeGreaterThan(0)
  expect(result.honestStats.overallFps).toBeLessThan(2)
})

test('the emulator asking for an untitled ROM speaks of ROMs, never cartridges', async ({
  page,
}) => {
  const setup = await setupProject(page, path.join(tmp, 'Untitled'))
  expect(setup.error).toBeUndefined()
  makeUntitledAndUnlocated(setup.manifestPath)
  await page.evaluate(async mp => {
    const w = await revealEmulator()
    getSvc('ProjectContext').current = await getSvc('Symbol(ProjectService)').openProject(mp)
    await w.refresh()
  }, setup.manifestPath)
  const words = () => shownWords(page, '[id="hackbench.emulator-view"]')
  await expect.poll(words).toContain('Locate the base ROM')
  expect(await words()).not.toMatch(CART)
})
