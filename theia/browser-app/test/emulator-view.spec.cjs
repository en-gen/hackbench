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

/**
 * Boot by clicking the real Start button, the path a user takes. Note what
 * this cannot show: Playwright's headless Chromium runs an AudioContext with
 * no gesture at all (measured: 'running' on a bare page), so these tests
 * would not notice a browser that blocked autoplay. The frame-rate checks do
 * run with the core's audio live; the tests assert its context is 'running'.
 */
async function bootAndWaitForFrames(page, minFrames = 10) {
  await page.locator(`${VIEW} button[aria-label="Start"]`).click()
  // An explicit poll: waitForFunction took an async predicate's pending
  // Promise as truthy and returned before the core had booted.
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.frameCount()),
      { timeout: 60000 },
    )
    .toBeGreaterThan(minFrames)
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

const VIEW = '#hackbench\\.emulator-view'

/**
 * Energy before and after the volume stage, over windows where the core is
 * actually playing. Two taps, not one: the game's music swells, rests and
 * has gaps between cues, so a lone post-gain level cannot tell "turned down"
 * from "a quiet bar". Only windows with sound on the pre tap count, so a
 * gap cannot pass as muted; too few of them is a failure, not a pass.
 */
async function measureOutput(page, windows = 15) {
  return page.evaluate(async windows => {
    const w = await getWidget('hackbench.emulator-view')
    const out = w.driver.audioOutput()
    if (!out) return { error: 'the driver captured no audio output' }
    const tap = node => {
      const a = out.context.createAnalyser()
      a.fftSize = 2048
      node.connect(a)
      return a
    }
    const pre = tap(out.input)
    const post = tap(out.master)
    const buf = new Float32Array(2048)
    const energy = a => {
      a.getFloatTimeDomainData(buf)
      let s = 0
      for (const v of buf) s += v * v
      return s
    }
    let preSum = 0
    let postSum = 0
    let counted = 0
    const end = performance.now() + 20000
    while (counted < windows && performance.now() < end) {
      const e = energy(pre)
      if (e > 0.01) {
        preSum += e
        postSum += energy(post)
        counted++
      }
      await new Promise(r => setTimeout(r, 45))
    }
    out.input.disconnect(pre)
    out.master.disconnect(post)
    return {
      state: out.context.state,
      counted,
      pre: preSum,
      post: postSum,
      ratio: postSum / preSum,
    }
  }, windows)
}

async function bootByClickAndWaitForSound(page) {
  await bootAndWaitForFrames(page, 30)
  return measureOutput(page)
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
  expect(
    await page.evaluate(
      async () => (await getWidget('hackbench.emulator-view')).driver.audioOutput()?.context.state,
    ),
    'the frame rate below must be measured with the core audio actually running',
  ).toBe('running')

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

/**
 * Sound, and the volume split button, judged by what reaches the output.
 * An icon that flips to "muted" while the game keeps playing passes every
 * check on the button; only the measured level can fail it.
 */
test('the core is audible, and the volume split button mutes and scales what comes out', async ({
  page,
}) => {
  test.setTimeout(150000)
  const setup = await setupProject(page, path.join(tmp, 'Sound'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })

  const mute = page.locator(`${VIEW} .hb-volume-mute`)
  const dropdown = page.locator(`${VIEW} .hb-volume-dropdown`)
  // Leave nothing from a previous run's saved volume in play.
  if ((await mute.getAttribute('aria-pressed')) === 'true') await mute.click()

  const playing = await bootByClickAndWaitForSound(page)
  expect(playing.error).toBeUndefined()
  expect(playing.state, 'autoplay left the context suspended').toBe('running')
  expect(playing.counted, 'the core emitted no audio at all').toBe(15)
  expect(playing.ratio).toBeGreaterThan(0.95)
  expect(playing.ratio).toBeLessThan(1.05)

  // ── mute: the button's main half ──────────────────────────────────────
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await expect(mute.locator('.codicon')).toHaveClass(/codicon-mute\b/)
  const muted = await measureOutput(page)
  expect(muted.counted, 'muting must not stop the core producing sound').toBe(15)
  expect(muted.post, 'muted, yet sound still reaches the output').toBe(0)

  // ── the popover half: a slider that sets the level ────────────────────
  await expect(page.locator(`${VIEW} .hb-volume-popover`)).toHaveCount(0)
  await dropdown.click()
  await expect(dropdown).toHaveAttribute('aria-expanded', 'true')
  const slider = page.locator(`${VIEW} .hb-volume-popover input[type="range"]`)
  await expect(slider).toBeVisible()
  await slider.fill('30')
  // Moving the slider unmutes, as it does in every media player.
  await expect(mute).toHaveAttribute('aria-pressed', 'false')
  const quieter = await measureOutput(page)
  expect(quieter.counted).toBe(15)
  // 0.3 amplitude is 0.09 energy. The band allows for the two taps being
  // read in separate calls, which can straddle an audio render quantum.
  expect(quieter.ratio).toBeGreaterThan(0.075)
  expect(quieter.ratio).toBeLessThan(0.105)

  await page.keyboard.press('Escape')
  await expect(page.locator(`${VIEW} .hb-volume-popover`)).toHaveCount(0)

  // Unmute returns to the chosen level, not to full volume.
  await mute.click()
  await mute.click()
  const restored = await measureOutput(page)
  expect(restored.ratio).toBeGreaterThan(0.075)
  expect(restored.ratio).toBeLessThan(0.105)

  // ── the level survives a reload of the whole shell ─────────────────────
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await setupProject(page, path.join(tmp, 'Sound2'))
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await page.locator(`${VIEW} .hb-volume-dropdown`).click()
  await expect(page.locator(`${VIEW} .hb-volume-popover input[type="range"]`)).toHaveValue('30')
})

/**
 * The level oracle proven able to fail: leave the button saying "muted" but
 * put the gain back behind its back. Every assertion on the button still
 * passes; the measured output must not.
 */
test('planted defect: a mute button that only changes its icon is caught by the level', async ({
  page,
}) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'FakeMute'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const mute = page.locator(`${VIEW} .hb-volume-mute`)
  if ((await mute.getAttribute('aria-pressed')) === 'true') await mute.click()
  const playing = await bootByClickAndWaitForSound(page)
  expect(playing.counted).toBe(15)

  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  await page.evaluate(async () => {
    ;(await getWidget('hackbench.emulator-view')).driver.audioOutput().master.gain.value = 1
  })
  const m = await measureOutput(page)
  expect(m.counted).toBe(15)
  // The negation of the muted assertion above (post === 0): the same oracle, red.
  expect(m.post, 'the oracle must see sound the button claims is muted').toBeGreaterThan(0)
  await mute.click()
})

/**
 * Closing the tab stops the emulator completely. The core's startup hooks
 * timers and listeners into the document it runs in (measured: a 25ms
 * OpenAL scheduler, resize/visibility/fullscreen listeners) that pausing
 * never removes. Its code runs in an iframe in a page-level host, outside
 * the widget, so only the driver discarding it ends them.
 *
 * The heartbeat is a timer started INSIDE the core's document, standing in
 * for every timer the core owns there: it firing after close means the
 * document is still alive, whatever the driver believes.
 */
test('closing the tab stops the emulator completely', async ({ page }) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'Close'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)

  const before = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    const frame = document.querySelector('iframe.hb-emulator-frame')
    // Held so they can still be read after the widget lets go of them.
    window.__hbCore = {
      frame,
      module: w.driver.module,
      context: w.driver.audioOutput()?.context,
      beats: 0,
    }
    frame.contentWindow.setInterval(() => window.__hbCore.beats++, 20)
    await new Promise(r => setTimeout(r, 300))
    return { context: window.__hbCore.context?.state, beats: window.__hbCore.beats }
  })
  expect(before.context).toBe('running')
  // The heartbeat must be seen running, or "stopped" below proves nothing.
  expect(before.beats).toBeGreaterThan(5)

  // The tab's own close button, the way a user closes it.
  const tab = page.locator('.lm-TabBar-tab[id$="hackbench.emulator-view"]')
  await tab.hover()
  await tab.locator('.lm-TabBar-tabCloseIcon').click()
  await expect(page.locator(VIEW)).toHaveCount(0)

  const after = await page.evaluate(async () => {
    const core = window.__hbCore
    const frames0 = core.module._get_current_frame_count()
    const beats0 = core.beats
    await new Promise(r => setTimeout(r, 2000))
    return {
      framesAdvanced: core.module._get_current_frame_count() - frames0,
      context: core.context?.state,
      heartbeats: core.beats - beats0,
      frameConnected: core.frame.isConnected,
      documentAlive: core.frame.contentWindow !== null,
    }
  })
  expect(after.framesAdvanced, 'the core kept stepping after its tab closed').toBe(0)
  expect(after.context, 'the audio output was left open').toBe('closed')
  expect(after.heartbeats, "timers in the core's document still fire after close").toBe(0)
  expect(after.frameConnected, "the core's iframe is still in the page").toBe(false)
  expect(after.documentAlive, "the core's document was not discarded").toBe(false)

  // Taking all of that back must not break the next emulator: reopen the
  // view, which WidgetManager builds fresh, and it boots and plays again.
  await setupProject(page, path.join(tmp, 'Reopen'))
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const reopened = await bootByClickAndWaitForSound(page)
  expect(reopened.error).toBeUndefined()
  expect(reopened.state).toBe('running')
  expect(reopened.counted).toBe(15)
})

/**
 * Reload is for a running core the working copy has moved past: enabled only
 * then, and it leaves the emulator stopped, with nothing of the old core
 * left behind (its document, timers, canvas). Start then boots the working
 * copy as it is. The edit is a palette colour, the same one undo-redo.spec
 * uses on the vanilla ROM.
 */
test('reload is enabled only by new edits, and stops the stale core completely', async ({
  page,
}) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'Reload'))
  expect(setup.error).toBeUndefined()
  const mp = setup.manifestPath
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)
  const reload = page.locator(`${VIEW} button[aria-label="Reload"]`)
  const toggle = page.locator(`${VIEW} .hb-emulator-controls button`).first()
  const setColor = (from, to) =>
    page.evaluate(
      ({ mp, from, to }) => getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, from, to),
      { mp, from, to },
    )

  await expect(reload, 'nothing has changed since boot').toBeDisabled()
  expect((await setColor('$391F', '$03E0')).status).toBe('ok')
  await expect(reload, 'an edit since boot must enable Reload').toBeEnabled()
  // Undo back to exactly what the core runs: nothing left to reload.
  await page.evaluate(mp => getSvc('Symbol(ProjectService)').undo(mp), mp)
  await expect(reload, 'undone back to the booted ROM').toBeDisabled()
  expect((await setColor('$391F', '$03E0')).status).toBe('ok')
  await expect(reload).toBeEnabled()

  const beatsBefore = await page.evaluate(async () => {
    const frame = document.querySelector('iframe.hb-emulator-frame')
    const canvas = (await getWidget('hackbench.emulator-view')).node.querySelector('canvas')
    window.__hbOld = { frame, canvas, beats: 0 }
    frame.contentWindow.setInterval(() => window.__hbOld.beats++, 20)
    await new Promise(r => setTimeout(r, 300))
    return window.__hbOld.beats
  })
  expect(beatsBefore).toBeGreaterThan(5)

  await reload.click()
  const after = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    const b0 = window.__hbOld.beats
    await new Promise(r => setTimeout(r, 1000))
    return {
      booted: w.driver.isBooted(),
      heartbeats: window.__hbOld.beats - b0,
      oldDocumentAlive: window.__hbOld.frame.contentWindow !== null,
      coreFrames: document.querySelectorAll('iframe.hb-emulator-frame').length,
      oldCanvasConnected: window.__hbOld.canvas.isConnected,
      canvases: w.node.querySelectorAll('canvas').length,
    }
  })
  expect(after.booted, 'Reload must not start emulation').toBe(false)
  expect(after.heartbeats, "timers in the old core's document still fire").toBe(0)
  expect(after.oldDocumentAlive, "the old core's document was not discarded").toBe(false)
  expect(after.coreFrames).toBe(0)
  // The core hooks listeners and its GL context onto its canvas; leaving it
  // would keep the old core reachable from the page.
  expect(after.oldCanvasConnected, "the old core's canvas is still in the page").toBe(false)
  expect(after.canvases).toBe(0)
  await expect(page.locator(`${VIEW} .hb-emulator-status`)).toHaveText('stopped')
  await expect(toggle).toHaveAttribute('aria-label', 'Start')
  await expect(reload).toBeDisabled()

  // Start boots the working copy as it is now, edit included.
  await toggle.click()
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.frameCount()),
      { timeout: 60000 },
    )
    .toBeGreaterThan(30)
  const digests = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.emulator-view')
    return {
      booted: w.bootedDigest,
      current: await getSvc('Symbol(EmulatorService)').romDigest(mp),
    }
  }, mp)
  expect(digests.booted).toBe(digests.current)
  await expect(reload).toBeDisabled()
})

/**
 * Maximize and moving the tab re-parent the widget's DOM node. An iframe
 * moved in the DOM reloads and loses its document, which is why the core's
 * iframe lives outside the widget: this fails if it is ever put back inside.
 */
test('the core keeps running through maximize and moving the tab to another area', async ({
  page,
}) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'Move'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)
  await page.evaluate(() => {
    window.__hbCoreWindow = document.querySelector('iframe.hb-emulator-frame').contentWindow
  })

  for (const [step, area] of [
    ['maximize', 'main'],
    ['restore', 'main'],
    ['bottom', 'bottom'],
    ['main', 'main'],
  ]) {
    const s = await page.evaluate(async step => {
      const w = await getWidget('hackbench.emulator-view')
      const shell = getSvc('ApplicationShell')
      if (step === 'maximize' || step === 'restore') shell.toggleMaximized(w)
      else await shell.addWidget(w, { area: step })
      await shell.activateWidget(w.id)
      await new Promise(r => setTimeout(r, 300))
      const f0 = w.driver.frameCount()
      await new Promise(r => setTimeout(r, 1500))
      return {
        fps: (w.driver.frameCount() - f0) / 1.5,
        sameCore:
          document.querySelector('iframe.hb-emulator-frame')?.contentWindow ===
          window.__hbCoreWindow,
        audio: w.driver.audioOutput()?.context.state,
        area: shell.getAreaFor(w),
        aspect: (() => {
          const r = w.node.querySelector('canvas').getBoundingClientRect()
          return r.height > 0 ? r.width / r.height : 0
        })(),
      }
    }, step)
    expect(s.area, step).toBe(area)
    expect(s.sameCore, `${step}: the core's document was replaced, so the game restarted`).toBe(
      true,
    )
    expect(s.fps, `${step}: the core stopped advancing`).toBeGreaterThan(45)
    expect(s.audio, step).toBe('running')
    // SNES output is 256:224 whatever the panel's shape.
    expect(Math.abs(s.aspect - 256 / 224), `${step}: aspect ${s.aspect}`).toBeLessThan(0.02)
  }
})

/**
 * Keyboard reaches the core as controller input through its exported
 * simulate_input. The spike showed the game acting on those calls (Mario
 * ran right on command, spike/FINDINGS.md), so the assertion is that the
 * right calls are made from real key presses, and nothing is left held
 * when focus leaves.
 */
test('keys drive the controller while the screen has focus, and release when it leaves', async ({
  page,
}) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'Keys'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)
  await page.evaluate(async () => {
    const m = (await getWidget('hackbench.emulator-view')).driver.module
    const real = m._simulate_input
    window.__hbInput = []
    m._simulate_input = (port, button, value) => {
      window.__hbInput.push([port, button, value])
      return real(port, button, value)
    }
  })
  const calls = () => page.evaluate(() => window.__hbInput.splice(0))

  // Clicking the screen is how a user gives the game the keyboard.
  await page.locator(`${VIEW} canvas`).click()
  await page.keyboard.down('ArrowRight')
  await page.keyboard.down('ArrowRight') // auto-repeat must not re-press
  await page.keyboard.down('KeyX')
  await page.keyboard.up('ArrowRight')
  expect(await calls()).toEqual([
    [0, 7, 1],
    [0, 8, 1],
    [0, 7, 0],
  ])

  // The shoulders, and Select on either of its two keys. Select stays held
  // until the last key holding it is let go.
  await page.keyboard.press('KeyQ')
  await page.keyboard.press('KeyW')
  await page.keyboard.down('ShiftRight')
  await page.keyboard.down('Space')
  await page.keyboard.up('ShiftRight')
  expect(await calls()).toEqual([
    [0, 10, 1],
    [0, 10, 0],
    [0, 11, 1],
    [0, 11, 0],
    [0, 2, 1],
  ])
  await page.keyboard.up('Space')
  expect(await calls()).toEqual([[0, 2, 0]])
  // And in the other order, so a button owned by its latest key fails.
  await page.keyboard.down('ShiftRight')
  await page.keyboard.down('Space')
  await page.keyboard.up('Space')
  expect(await calls()).toEqual([[0, 2, 1]])
  await page.keyboard.up('ShiftRight')
  expect(await calls()).toEqual([[0, 2, 0]])

  // Focus leaving the panel with A still held must release it.
  await page.evaluate(() => document.activeElement.blur())
  expect(await calls()).toEqual([[0, 8, 0]])
  await page.keyboard.up('KeyX')

  // A key let go after Ctrl went down is still released, not left held.
  await page.locator(`${VIEW} canvas`).click()
  await page.keyboard.down('KeyZ')
  await page.keyboard.down('Control')
  await page.keyboard.up('KeyZ')
  await page.keyboard.up('Control')
  expect(await calls()).toEqual([
    [0, 0, 1],
    [0, 0, 0],
  ])
  // So is one let go after focus moved to a control inside this panel.
  await page.keyboard.down('ArrowUp')
  await page.locator(`${VIEW} .hb-volume-dropdown`).focus()
  await page.keyboard.up('ArrowUp')
  expect(await calls()).toEqual([
    [0, 4, 1],
    [0, 4, 0],
  ])
  await page.evaluate(() => document.activeElement.blur())

  // Keys pressed while the panel does not have focus never reach the game.
  await page.keyboard.press('ArrowLeft')
  expect(await calls()).toEqual([])
  // Nor do modified keys, which stay Theia's shortcuts.
  await page.locator(`${VIEW} canvas`).click()
  await page.keyboard.press('Control+KeyZ')
  expect(await calls()).toEqual([])
})

/**
 * The game itself acts on the keyboard, not just the input API: Start on
 * the title screen opens the player-select menu, drawn as white text over
 * the hills. The control is the title screen left alone for as long as the
 * presses take, so a fade finishing or the demo drawing something white in
 * that band cannot pass for the menu. Vanilla ROM layout.
 */
test('pressing Start on the title screen opens the player-select menu', async ({ page }) => {
  test.setTimeout(150000)
  const setup = await setupProject(page, path.join(tmp, 'Start'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)

  const menuWhite = () =>
    page.evaluate(async () => {
      const w = await getWidget('hackbench.emulator-view')
      const png = await w.driver.screenshotPng()
      const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }))
      const c = document.createElement('canvas')
      c.width = bitmap.width
      c.height = bitmap.height
      const cx = c.getContext('2d')
      cx.drawImage(bitmap, 0, 0)
      // The menu band, as a fraction of the frame so a 2x capture reads the same.
      const x0 = Math.round(c.width * 0.25)
      const y0 = Math.round(c.height * 0.54)
      const d = cx.getImageData(x0, y0, Math.round(c.width * 0.5), Math.round(c.height * 0.14)).data
      let white = 0
      let lit = 0
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) white++
        if (d[i] + d[i + 1] + d[i + 2] > 60) lit++
      }
      return { white, lit, frame: w.driver.frameCount() }
    })

  // Wait for the title screen proper (the band lit, not a fade), then
  // sample it with no input: the control that makes the comparison mean
  // something.
  let first
  await expect
    .poll(async () => (first = await menuWhite()).lit, { timeout: 60000, intervals: [1000] })
    .toBeGreaterThan(2000)
  const idleSamples = [first]
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(1350)
    idleSamples.push(await menuWhite())
  }
  const idle = idleSamples.reduce((a, b) => (b.white > a.white ? b : a))

  await page.locator(`${VIEW} canvas`).click()
  let pressed = idle
  for (let i = 0; i < 4 && pressed.white <= idle.white + 200; i++) {
    await page.keyboard.down('Enter')
    await page.waitForTimeout(150)
    await page.keyboard.up('Enter')
    await page.waitForTimeout(1200)
    pressed = await menuWhite()
  }
  console.log('menu band white pixels', { idleSamples, pressed })
  expect(idle.white, 'the title screen left alone already shows white there').toBeLessThan(200)
  expect(pressed.white, 'Start did not bring up the player-select menu').toBeGreaterThan(
    idle.white + 200,
  )
})

/**
 * Start fetches the core over RPC before booting. A project change during
 * that await replaces the screen the boot was aimed at; booting anyway puts
 * a running, audible core into a node nobody can see.
 */
test('a project closed while Start is still loading the core boots nothing', async ({ page }) => {
  test.setTimeout(60000)
  const setup = await setupProject(page, path.join(tmp, 'Race'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const result = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    // Close the project inside the await start() is parked on, so the view
    // has already left 'ready' by the time the core files arrive. Nothing
    // disposes the driver after that point, so a boot here would stick.
    const rpc = w.emulator
    w.emulator = new Proxy(rpc, {
      get: (target, key) =>
        key === 'coreFiles'
          ? async () => {
              const files = await target.coreFiles()
              getSvc('ProjectContext').current = undefined
              await w.refresh()
              return files
            }
          : target[key],
    })
    try {
      await w.start()
    } finally {
      w.emulator = rpc
    }
    await new Promise(r => setTimeout(r, 500))
    return {
      state: w.state.kind,
      booted: w.driver.isBooted(),
      coreFrames: document.querySelectorAll('iframe.hb-emulator-frame').length,
    }
  })
  expect(result.state).toBe('no-project')
  expect(result.booted, 'a core booted for a project that is no longer open').toBe(false)
  expect(result.coreFrames).toBe(0)
})

/**
 * The transport: play and pause are ONE toggle, Stop discards the core, and
 * Start after Stop boots a fresh one. Judged by the core, not the glyph.
 */
test('one play/pause toggle; Stop discards the core and Start boots a fresh one', async ({
  page,
}) => {
  test.setTimeout(120000)
  const setup = await setupProject(page, path.join(tmp, 'Transport'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const controls = page.locator(`${VIEW} .hb-emulator-controls`)
  const toggle = controls.locator('button').first()
  const stop = controls.locator('button[aria-label="Stop"]')
  const frames = () =>
    page.evaluate(async () => (await getWidget('hackbench.emulator-view')).driver.frameCount())
  const advancing = async () => {
    const f0 = await frames()
    await page.waitForTimeout(500)
    return (await frames()) > f0
  }

  // No separate Pause button next to the toggle.
  await expect(controls.locator('button[aria-label="Pause"]')).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-label', 'Start')
  await expect(stop).toBeDisabled()

  await toggle.click()
  await expect.poll(frames, { timeout: 60000 }).toBeGreaterThan(30)
  await expect(toggle).toHaveAttribute('aria-label', 'Pause')
  // Play hands the keyboard to the game: the panel has focus, with no click
  // on the screen, and a key reaches the core's input.
  expect(
    await page.evaluate(
      async () => document.activeElement === (await getWidget('hackbench.emulator-view')).node,
    ),
    'Play did not give the emulator panel focus',
  ).toBe(true)
  await page.evaluate(async () => {
    const m = (await getWidget('hackbench.emulator-view')).driver.module
    const real = m._simulate_input
    const seen = []
    m._simulate_input = (p, b, v) => (seen.push([p, b, v]), real(p, b, v))
    window.__hbSeen = seen
  })
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => window.__hbSeen)).toEqual([
    [0, 7, 1],
    [0, 7, 0],
  ])
  await expect(toggle.locator('.codicon')).toHaveClass(/codicon-debug-pause/)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-label', 'Resume')
  expect(await advancing(), 'paused, yet the core kept stepping').toBe(false)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-label', 'Pause')
  expect(await advancing(), 'resumed, yet the core did not step').toBe(true)

  await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    window.__hbStopped = {
      frame: document.querySelector('iframe.hb-emulator-frame'),
      context: w.driver.audioOutput()?.context,
    }
  })
  await stop.click()
  const stopped = await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    await new Promise(r => setTimeout(r, 300))
    return {
      booted: w.driver.isBooted(),
      documentAlive: window.__hbStopped.frame.contentWindow !== null,
      audio: window.__hbStopped.context?.state,
      coreFrames: document.querySelectorAll('iframe.hb-emulator-frame').length,
    }
  })
  expect(stopped.booted).toBe(false)
  expect(stopped.documentAlive, "Stop left the core's document alive").toBe(false)
  expect(stopped.audio).toBe('closed')
  expect(stopped.coreFrames).toBe(0)
  await expect(toggle).toHaveAttribute('aria-label', 'Start')
  await expect(stop).toBeDisabled()
  await expect(page.locator(`${VIEW} .hb-emulator-status`)).toHaveText('stopped')

  // A fresh core, not the old one resumed: a new document of its own.
  await toggle.click()
  await expect.poll(frames, { timeout: 60000 }).toBeGreaterThan(30)
  const fresh = await page.evaluate(() => {
    const frame = document.querySelector('iframe.hb-emulator-frame')
    return { exists: !!frame, same: frame === window.__hbStopped.frame }
  })
  expect(fresh.exists).toBe(true)
  expect(fresh.same, 'Start after Stop resumed the old core').toBe(false)
})

/**
 * WCAG relative-luminance contrast of a CSS color over an opaque background
 * color. A translucent foreground is composited first, or a faint border
 * would score as if it were solid.
 */
function contrast(fg, bg) {
  const parse = c => c.match(/[\d.]+/g).map(Number)
  const [br, bgG, bb] = parse(bg)
  const [fr, fgG, fb, alpha = 1] = parse(fg)
  const blended = `rgb(${fr * alpha + br * (1 - alpha)}, ${fgG * alpha + bgG * (1 - alpha)}, ${fb * alpha + bb * (1 - alpha)})`
  const lum = c => {
    const [r, g, b] = parse(c)
      .slice(0, 3)
      .map(v => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi, lo] = [lum(blended), lum(bg)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The volume control reads as ONE split button: a single visible border
 * around both halves, the halves touching, and a visible divider between
 * them. Two borderless icons side by side pass every presence check and
 * read as two controls.
 */
test('the volume control is drawn as one split button, and its popover never changes width', async ({
  page,
}) => {
  test.setTimeout(60000)
  const setup = await setupProject(page, path.join(tmp, 'Split'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('#hackbench\\.emulator-view .hb-volume')
    const mute = root.querySelector('.hb-volume-mute').getBoundingClientRect()
    const drop = root.querySelector('.hb-volume-dropdown')
    const dropRect = drop.getBoundingClientRect()
    const rootStyle = getComputedStyle(root)
    const dropStyle = getComputedStyle(drop)
    let bg = 'rgba(0, 0, 0, 0)'
    for (let el = root.parentElement; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor
      if (!/rgba\(.*, 0\)$/.test(c)) {
        bg = c
        break
      }
    }
    return {
      gap: dropRect.left - mute.right,
      sameRow: Math.abs(dropRect.top - mute.top) < 1,
      borderWidth: parseFloat(rootStyle.borderTopWidth),
      borderColor: rootStyle.borderTopColor,
      dividerWidth: parseFloat(dropStyle.borderLeftWidth),
      dividerColor: dropStyle.borderLeftColor,
      panelBackground: bg,
    }
  })
  expect(geometry.sameRow).toBe(true)
  expect(Math.abs(geometry.gap), 'the halves must touch').toBeLessThan(1.5)
  expect(geometry.borderWidth, 'no border around the pair').toBeGreaterThanOrEqual(1)
  expect(geometry.dividerWidth, 'no divider between the halves').toBeGreaterThanOrEqual(1)
  // A border drawn in the panel's own color is present and invisible.
  expect(contrast(geometry.borderColor, geometry.panelBackground)).toBeGreaterThan(1.2)
  expect(contrast(geometry.dividerColor, geometry.panelBackground)).toBeGreaterThan(1.2)

  // The popover keeps one width whether the readout says 5%, 50%, 150% or Muted.
  await page.locator(`${VIEW} .hb-volume-dropdown`).click()
  const slider = page.locator(`${VIEW} .hb-volume-popover input[type="range"]`)
  const popover = page.locator(`${VIEW} .hb-volume-popover`)
  // It takes focus on open; the theme's focus ring must not frame it.
  await expect(slider).toBeFocused()
  expect(
    await slider.evaluate(el => {
      const st = getComputedStyle(el)
      return st.outlineStyle === 'none' || parseFloat(st.outlineWidth) === 0
    }),
    'focus outline drawn around the volume slider',
  ).toBe(true)
  const widths = []
  for (const v of ['5', '50', '150']) {
    await slider.fill(v)
    widths.push((await popover.boundingBox()).width)
  }
  // Mute is part of the same control, so the popover stays open.
  await page.locator(`${VIEW} .hb-volume-mute`).click()
  const readout = popover.locator('.hb-volume-readout')
  await expect(readout).toHaveText('Muted')
  widths.push((await popover.boundingBox()).width)
  // Constant width means nothing if the widest text spills out of it.
  expect(
    await readout.evaluate(el => el.scrollWidth <= el.clientWidth),
    '"Muted" overflows the readout',
  ).toBe(true)
  await page.locator(`${VIEW} .hb-volume-mute`).click()
  expect(new Set(widths).size, `popover widths ${widths}`).toBe(1)
})

test('the emulator speaks of ROMs, never cartridges', async ({ page }) => {
  const setup = await setupProject(page, path.join(tmp, 'Words'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  await expect(page.locator(`${VIEW} button[aria-label="Reload"]`)).toHaveAttribute(
    'title',
    'Reload from working copy',
  )
  const words = await page.evaluate(() => {
    const view = document.querySelector('#hackbench\\.emulator-view')
    const titles = [...view.querySelectorAll('[title],[aria-label]')].map(
      el => `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
    )
    return [view.textContent, ...titles].join(' ')
  })
  expect(words).not.toMatch(/cartridge|\bcarts?\b/i)
})

/**
 * Switching to another project mid-Start: both projects render 'ready', so
 * a state check alone lets the boot through with the PREVIOUS project's ROM
 * still in hand, and nothing disposes it afterwards.
 */
test('switching project while Start is loading the core never boots the old ROM', async ({
  page,
}) => {
  test.setTimeout(60000)
  const setup = await setupProject(page, path.join(tmp, 'SwitchA'))
  expect(setup.error).toBeUndefined()
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const result = await page.evaluate(
    async ({ romPath, directory }) => {
      const w = await getWidget('hackbench.emulator-view')
      const other = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Other',
        directory,
      })
      const rpc = w.emulator
      let switched
      w.emulator = new Proxy(rpc, {
        get: (target, key) =>
          key === 'coreFiles'
            ? async () => {
                const files = await target.coreFiles()
                // Start the switch but do not let it finish: its ROM is still
                // in flight when start() resumes, as with a real slow RPC.
                getSvc('ProjectContext').current = other
                switched = w.refresh()
                return files
              }
            : target[key],
      })
      try {
        await w.start()
      } finally {
        w.emulator = rpc
      }
      await switched
      await new Promise(r => setTimeout(r, 300))
      return { booted: w.driver.isBooted(), state: w.state.kind }
    },
    { romPath: ROM, directory: path.join(tmp, 'SwitchB') },
  )
  expect(result.state).toBe('ready')
  expect(result.booted, "a core booted with the previous project's ROM").toBe(false)
})

/**
 * Save games persist in the project's saves/ folder: loaded into the core
 * at boot, and written back on Stop, on the periodic poll, and on closing
 * the tab. New SRAM is put into the core the way EmulatorJS reloads save
 * files (its exported refresh_save_files), so each write-back starts from
 * the core's memory, not from a file the test wrote.
 */
test('save games live in the project and survive Stop, the poll and closing the tab', async ({
  page,
}) => {
  test.setTimeout(150000)
  const dir = path.join(tmp, 'Saves')
  const setup = await setupProject(page, dir)
  expect(setup.error).toBeUndefined()
  // Seeded as the single game.srm from before save slots: it must come
  // back as slot 1, <ROM header title>.1.srm.
  const legacy = path.join(dir, 'saves', 'game.srm')
  const title = JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')).baseRom.title
  const saveFile = path.join(dir, 'saves', `${title}.1.srm`)
  const pattern = seed => Array.from({ length: 2048 }, (_, i) => (i * 7 + seed) & 0xff)
  const onDisk = () => Array.from(fs.readFileSync(saveFile))
  fs.mkdirSync(path.dirname(legacy), { recursive: true })
  fs.writeFileSync(legacy, Buffer.from(pattern(1)))

  await page.evaluate(async () => {
    await revealEmulator()
  })
  await bootAndWaitForFrames(page, 30)
  const inCore = () =>
    page.evaluate(async () => {
      const w = await getWidget('hackbench.emulator-view')
      return w.driver.saveProblem ?? Array.from(w.driver.readSave() ?? [])
    })
  // Put new SRAM into the running core, as a game saving would.
  const coreSaves = bytes =>
    page.evaluate(async bytes => {
      const d = (await getWidget('hackbench.emulator-view')).driver
      d.module.FS.writeFile(d.savePath, new Uint8Array(bytes))
      d.module._refresh_save_files()
    }, bytes)

  // The game writes its own SRAM as it runs (SMW checks and rewrites its
  // save files), so every comparison below is made with the core paused:
  // the SRAM then holds exactly what the test put there.
  const pause = () => page.locator(`${VIEW} button[aria-label="Pause"]`).click()
  // Stops the periodic write, so the flush under test is the only writer.
  const holdPoll = () =>
    page.evaluate(async () => clearInterval((await getWidget('hackbench.emulator-view')).saveTimer))

  await pause()
  expect(await inCore(), "the project's save was not loaded at boot").toEqual(pattern(1))

  await holdPoll()
  await coreSaves(pattern(2))
  expect(await inCore()).toEqual(pattern(2))
  await page.locator(`${VIEW} button[aria-label="Stop"]`).click()
  await expect.poll(onDisk, { message: 'Stop did not write the save' }).toEqual(pattern(2))

  // Start again: the save made before Stop is what the new core loads.
  await bootAndWaitForFrames(page, 30)
  await pause()
  expect(await inCore()).toEqual(pattern(2))

  // No Stop: the periodic write alone must get it to disk.
  await coreSaves(pattern(3))
  await expect
    .poll(onDisk, { timeout: 12000, message: 'the periodic save never reached disk' })
    .toEqual(pattern(3))

  // A write that fails (a locked file, a backend restarting) is retried by
  // the next poll, not dropped because the bytes were already "seen".
  await page.evaluate(async () => {
    const w = await getWidget('hackbench.emulator-view')
    const rpc = w.emulator
    let failed = false
    w.emulator = new Proxy(rpc, {
      get: (target, key) =>
        key === 'storeSave' && !failed
          ? () => {
              failed = true
              return Promise.reject(new Error('disk said no'))
            }
          : target[key],
    })
  })
  await coreSaves(pattern(5))
  await expect
    .poll(onDisk, { timeout: 15000, message: 'a failed write was never retried' })
    .toEqual(pattern(5))

  // Closing the tab flushes whatever the poll has not written yet.
  await holdPoll()
  await coreSaves(pattern(4))
  const tab = page.locator('.lm-TabBar-tab[id$="hackbench.emulator-view"]')
  await tab.hover()
  await tab.locator('.lm-TabBar-tabCloseIcon').click()
  await expect.poll(onDisk, { message: 'closing the tab lost the save' }).toEqual(pattern(4))
})

/**
 * The save-slot dropdown, judged by what lands on disk and in the core:
 * rename, duplicate and delete are icon buttons on each row, delete asks
 * first, the running game's slot cannot be deleted, switching slot while
 * running stops the game and the next Start loads the chosen slot, and New
 * save picks the next free number.
 */
test('save slots: rename, duplicate, delete with confirmation, switch and new', async ({
  page,
}) => {
  test.setTimeout(150000)
  const dir = path.join(tmp, 'Slots')
  const setup = await setupProject(page, dir)
  expect(setup.error).toBeUndefined()
  const title = JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')).baseRom.title
  const savesDir = path.join(dir, 'saves')
  const slotPath = n => path.join(savesDir, `${title}.${n}.srm`)
  const bytes = seed => Array.from({ length: 2048 }, (_, i) => (i * 3 + seed) & 0xff)
  fs.mkdirSync(savesDir, { recursive: true })
  fs.writeFileSync(slotPath(1), Buffer.from(bytes(1)))
  fs.writeFileSync(slotPath(2), Buffer.from(bytes(2)))
  fs.writeFileSync(
    path.join(savesDir, 'labels.json'),
    JSON.stringify({ [`${title}.1.srm`]: 'castle' }),
  )
  // A save another emulator made, named after the ROM file.
  const foreign = 'Super Mario World (USA).vanilla.srm'
  fs.writeFileSync(path.join(savesDir, foreign), Buffer.from(bytes(9)))

  // Reopen so the view reads the seeded slots.
  await page.evaluate(async mp => {
    const ctx = getSvc('ProjectContext')
    ctx.current = await getSvc('Symbol(ProjectService)').openProject(mp)
    const w = await getWidget('hackbench.emulator-view')
    await w.refresh()
    await w.loadSaveChoice(mp)
    await revealEmulator()
  }, setup.manifestPath)

  const toggle = page.locator(`${VIEW} .hb-saves-toggle`)
  const menu = page.locator(`${VIEW} .hb-saves-menu`)
  const row = n => menu.locator(`.hb-saves-item[data-slot="${n}"]`)
  const names = () => menu.locator('.hb-saves-name').allTextContents()
  await expect(toggle).toContainText('Save 1 · castle')

  await toggle.click()
  expect(await names()).toEqual(['Save 1 · castle', 'Save 2'])
  await expect(row(1).locator('.hb-saves-pick')).toHaveAttribute('aria-current', 'true')

  // Rename: the label becomes a text field with a save button.
  await row(2).locator('button[aria-label="Rename save 2"]').click()
  await row(2).locator('input').fill('boss')
  await row(2).locator('button[aria-label="Save label"]').click()
  await expect(row(2).locator('.hb-saves-name')).toHaveText('Save 2 · boss')
  expect(JSON.parse(fs.readFileSync(path.join(savesDir, 'labels.json'), 'utf8'))).toEqual({
    [`${title}.1.srm`]: 'castle',
    [`${title}.2.srm`]: 'boss',
  })
  expect(fs.existsSync(slotPath(2)), 'renaming must not rename the file').toBe(true)

  // Another emulator's save is offered for import, and importing moves it
  // into the next free slot under its old name.
  const foreignRow = menu.locator(`.hb-saves-foreign [data-file="${foreign}"]`)
  await expect(foreignRow).toBeVisible()
  await foreignRow.locator(`button[aria-label="Import ${foreign}"]`).click()
  await expect(row(3).locator('.hb-saves-name')).toHaveText(
    'Save 3 · Super Mario World (USA).vanilla',
  )
  await expect(menu.locator('.hb-saves-foreign')).toHaveCount(0)
  expect(fs.existsSync(path.join(savesDir, foreign))).toBe(false)
  expect(Array.from(fs.readFileSync(slotPath(3)))).toEqual(bytes(9))
  await row(3).locator('button[aria-label="Delete save 3"]').click()
  await page.locator('.dialogBlock button', { hasText: 'Delete' }).click()
  await expect(row(3)).toHaveCount(0)
  await toggle.click()

  // Duplicate: a new row with the next number, same bytes.
  await row(1).locator('button[aria-label="Duplicate save 1"]').click()
  await expect(row(3).locator('.hb-saves-name')).toHaveText('Save 3 · castle (copy)')
  expect(Array.from(fs.readFileSync(slotPath(3)))).toEqual(bytes(1))

  // Delete asks first; Cancel keeps the save.
  const dialog = page.locator('.dialogBlock')
  await row(3).locator('button[aria-label="Delete save 3"]').click()
  await expect(dialog).toBeVisible()
  await dialog.locator('button', { hasText: 'Cancel' }).click()
  expect(fs.existsSync(slotPath(3))).toBe(true)
  await toggle.click()
  await row(3).locator('button[aria-label="Delete save 3"]').click()
  await dialog.locator('button', { hasText: 'Delete' }).click()
  await expect.poll(() => fs.existsSync(slotPath(3))).toBe(false)
  await expect(row(3)).toHaveCount(0)

  // Boot slot 1: it is in use, so it cannot be deleted.
  await page.keyboard.press('Escape')
  await bootAndWaitForFrames(page, 30)
  await page.locator(`${VIEW} button[aria-label="Pause"]`).click()
  const inCore = () =>
    page.evaluate(async () =>
      Array.from((await getWidget('hackbench.emulator-view')).driver.readSave() ?? []),
    )
  expect(await inCore()).toEqual(bytes(1))
  await toggle.click()
  await expect(row(1).locator('button[aria-label="Delete save 1"]')).toBeDisabled()

  // Paused: switching slot stops the game; the next Start loads it.
  await row(2).locator('.hb-saves-pick').click()
  await expect(page.locator(`${VIEW} .hb-emulator-status`)).toHaveText('stopped')
  await expect(toggle).toContainText('Save 2 · boss')
  await bootAndWaitForFrames(page, 30)
  await page.locator(`${VIEW} button[aria-label="Pause"]`).click()
  expect(await inCore(), 'Start did not load the chosen slot').toEqual(bytes(2))

  // Running: switching slot resets the game onto the chosen slot, and it
  // keeps playing: a fresh core, loaded with that slot's save.
  await page.locator(`${VIEW} button[aria-label="Resume"]`).click()
  await page.evaluate(() => {
    window.__hbSlotCore = document.querySelector('iframe.hb-emulator-frame')
  })
  await toggle.click()
  await row(1).locator('.hb-saves-pick').click()
  await expect(page.locator(`${VIEW} button[aria-label="Pause"]`)).toBeVisible({ timeout: 60000 })
  expect(
    await page.evaluate(
      () => document.querySelector('iframe.hb-emulator-frame') !== window.__hbSlotCore,
    ),
    'switching while running did not reset onto a new core',
  ).toBe(true)
  // The restarted game has the keyboard, as after Play.
  expect(
    await page.evaluate(
      async () => document.activeElement === (await getWidget('hackbench.emulator-view')).node,
    ),
    'the save switch restarted the game but left focus on the dropdown',
  ).toBe(true)
  await page.locator(`${VIEW} button[aria-label="Pause"]`).click()
  expect(await inCore(), 'the reset did not load the chosen slot').toEqual(bytes(1))
  // Back to slot 2 (paused, so it just stops) for the steps below.
  await toggle.click()
  await row(2).locator('.hb-saves-pick').click()
  await expect(page.locator(`${VIEW} .hb-emulator-status`)).toHaveText('stopped')

  // New save: the next free number, marked new until the game writes it.
  await toggle.click()
  await menu.locator('.hb-saves-new').click()
  await expect(toggle).toContainText('Save 3')
  await toggle.click()
  await expect(row(3).locator('.hb-saves-note')).toHaveText('new')
  // A duplicate made now must not take the new save's number: it has no
  // file yet, and the game's first write would overwrite the copy.
  await row(1).locator('button[aria-label="Duplicate save 1"]').click()
  await expect(row(4).locator('.hb-saves-name')).toHaveText('Save 4 · castle (copy)')
  expect(fs.existsSync(slotPath(3)), 'the duplicate landed on the new save').toBe(false)
  await page.keyboard.press('Escape')
  await bootAndWaitForFrames(page, 30)
  // Its first write creates the file, and the row stops saying new.
  await expect.poll(() => fs.existsSync(slotPath(3)), { timeout: 15000 }).toBe(true)
  await toggle.click()
  await expect(row(3).locator('.hb-saves-note')).toHaveCount(0)
})

/**
 * The saves/ folder is watched: files copied in, moved in or deleted
 * outside HackBench show up in the open dropdown by themselves. The menu
 * stays open throughout, so its refresh-on-open cannot be what updates it.
 */
test('the save list follows files and labels changed in saves/ outside HackBench', async ({
  page,
}) => {
  test.setTimeout(90000)
  const dir = path.join(tmp, 'Watch')
  const setup = await setupProject(page, dir)
  expect(setup.error).toBeUndefined()
  const title = JSON.parse(fs.readFileSync(setup.manifestPath, 'utf8')).baseRom.title
  await page.evaluate(async () => {
    await revealEmulator()
  })
  const menu = page.locator(`${VIEW} .hb-saves-menu`)
  await page.locator(`${VIEW} .hb-saves-toggle`).click()
  await expect(menu).toBeVisible()
  // Let the folder watch settle before touching the folder.
  await page.waitForTimeout(1500)

  const savesDir = path.join(dir, 'saves')
  const slot5 = path.join(savesDir, `${title}.5.srm`)
  const foreign = path.join(savesDir, 'From RetroArch.srm')
  fs.mkdirSync(savesDir, { recursive: true })
  fs.writeFileSync(slot5, Buffer.alloc(2048, 5))
  fs.writeFileSync(foreign, Buffer.alloc(2048, 6))

  const row5 = menu.locator('.hb-saves-item[data-slot="5"]')
  const foreignRow = menu.locator('.hb-saves-foreign [data-file="From RetroArch.srm"]')
  await expect(row5, 'a save copied into saves/ never appeared').toBeVisible({ timeout: 15000 })
  await expect(foreignRow).toBeVisible({ timeout: 15000 })

  // labels.json lives in saves/ too: editing it by hand relabels the row.
  fs.writeFileSync(
    path.join(savesDir, 'labels.json'),
    JSON.stringify({ [`${title}.5.srm`]: 'edited by hand' }),
  )
  await expect(row5.locator('.hb-saves-name')).toHaveText('Save 5 · edited by hand', {
    timeout: 15000,
  })

  fs.rmSync(slot5)
  fs.rmSync(foreign)
  await expect(row5, 'a save deleted from saves/ was still listed').toHaveCount(0, {
    timeout: 15000,
  })
  await expect(foreignRow).toHaveCount(0, { timeout: 15000 })
  await expect(menu, 'the menu must have stayed open for this to mean anything').toBeVisible()
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
