import * as fs from 'fs'
import * as path from 'path'
import type { FrameLocator, Locator, Page } from '@playwright/test'
import { test, expect, ROM_PATH, NO_ROM_REASON, webviewOf, quickInput, type Workbench } from './fixtures/workbench'

/**
 * T12 spike deliverable (libretro-view-engine, task A/B/C). The
 * project-deciding question: does patching bank $05/$06 ROM bytes into the
 * plain byte array BEFORE the core's first read (main.ts's boot(), see its
 * top comment) reach the game the way a bank-$00 patch already does, or does
 * the WRAM-survival hypothesis in CLAUDE.md's spike section block it too?
 *
 * One VS Code launch (the shared `workbench` fixture) runs every case:
 * EmulatorPreviewProvider.ts re-reads `.hackbench-e2e-scenario` next to the
 * ROM on every `open()` call, and every call already gets a fresh
 * panel/webview/core regardless of whether the surrounding process is
 * reused -- see that file's readScenario() comment.
 *
 * Frame-count discipline: TitleScreenInputSeq's 34 duration bytes
 * (bank_00.asm:3323, ROM offset 0x1C1F) sum to 1426 -- confirmed directly
 * against the ROM -- so the demo (and the level it shows) ends around frame
 * 1426 regardless of input. Five earlier agents measured near frame 1700,
 * past that end, and got false negatives. This suite measures at 400/500/600
 * and keeps one later frame as a clearly-labelled secondary for comparison.
 */
const EVIDENCE_DIR = path.join(__dirname, '../../spike/t12/evidence')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const RESULTS_PATH = path.join(EVIDENCE_DIR, 'results.json')

/** Read-modify-write so task A's and task B's tests (separate processes if
 *  Playwright shards them) don't clobber each other's half of the file. */
function saveResult(key: string, value: unknown): void {
  let all: Record<string, unknown> = {}
  try { all = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8')) } catch { /* first write */ }
  all[key] = value
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(all, null, 2))
}

function setScenario(dirs: Workbench['dirs'], scenario: string | undefined): void {
  const p = path.join(dirs.workspaceDir, '.hackbench-e2e-scenario')
  if (scenario) fs.writeFileSync(p, scenario)
  else { try { fs.unlinkSync(p) } catch { /* already absent */ } }
}

/**
 * The shared `closeActiveEditor` helper closes whatever tab is first in DOM
 * order, which is wrong here: openRom() leaves a preview tab for rom.sfc
 * open in its own editor group (a plain click opens files in VS Code's
 * preview-tab mode), so the emulator panel is a second, separate tab, not
 * necessarily the first. Target it by its title instead.
 */
async function closeEmulatorPanel(win: Page): Promise<void> {
  const tab = win.locator('.tabs-container .tab', { hasText: 'Emulator Preview' })
  if (await tab.count() === 0) return
  await tab.first().click({ button: 'middle' })
  await expect(tab).toHaveCount(0, { timeout: 20_000 })
}

async function openPanel(win: Page): Promise<{ webview: FrameLocator, status: Locator, openedAt: number }> {
  const openedAt = Date.now()
  await win.keyboard.press('Control+Shift+P')
  await quickInput(win).waitFor({ state: 'visible', timeout: 20_000 })
  await win.keyboard.type('HackBench: Open Emulator Preview')
  await win.keyboard.press('Enter')
  const webview = webviewOf(win)
  const status = webview.locator('#status')
  await status.waitFor({ timeout: 30_000 })
  return { webview, status, openedAt }
}

/** Polls the status text (set by main.ts's frame-count interval) for a target frame. */
async function waitForFrame(status: Locator, target: number, timeoutMs = 180_000): Promise<{ seen: number, atMs: number }> {
  let seen = 0
  await expect(async () => {
    const text = (await status.textContent()) ?? ''
    expect(text).not.toContain('error')
    const m = text.match(/frame (\d+)/)
    seen = m ? Number(m[1]) : 0
    expect(seen).toBeGreaterThanOrEqual(target)
  }).toPass({ timeout: timeoutMs, intervals: [500] })
  return { seen, atMs: Date.now() }
}

/**
 * Reading the live canvas fails: the core binds it as webgl2, so
 * getContext('2d') returns null. __hackbenchTest.screenshotPng() (main.ts)
 * goes through the core's own cmd_take_screenshot command instead, ported
 * from spike/t6/harness.js's T0.screenshot.
 */
async function capturePng(webview: FrameLocator, name: string): Promise<Buffer> {
  const bytes = await webview.locator('body').evaluate(async () => {
    const hook = (window as unknown as { __hackbenchTest: { screenshotPng: () => Promise<number[]> } }).__hackbenchTest
    return hook.screenshotPng()
  })
  const buf = Buffer.from(bytes)
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), buf)
  return buf
}

/**
 * Decodes a PNG buffer to raw RGBA using the workbench window's own browser
 * APIs (createImageBitmap + canvas, spike/t6 harness.js's T0.decodePng) --
 * needs no image library. Runs against `win`, not the emulator's frame:
 * decoding is plain browser API, unrelated to which core instance took it.
 */
async function decodeRgba(win: Page, png: Buffer): Promise<{ width: number, height: number, data: Buffer }> {
  const result = await win.evaluate(async (dataB64: string) => {
    const bytes = Uint8Array.from(atob(dataB64), c => c.charCodeAt(0))
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let binary = ''
    for (let i = 0; i < data.length; i += 8192) {
      binary += String.fromCharCode.apply(null, Array.from(data.subarray(i, i + 8192)) as unknown as number[])
    }
    return { width: bmp.width, height: bmp.height, b64: btoa(binary) }
  }, png.toString('base64'))
  return { width: result.width, height: result.height, data: Buffer.from(result.b64, 'base64') }
}

/** Count of differing pixels (any channel, any tolerance) plus their bounding box. */
function pixelDiff(a: Buffer, b: Buffer, w: number): { diffPixels: number, totalPixels: number, pct: number, bbox: unknown } {
  const total = Math.min(a.length, b.length) / 4
  let diff = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1
  for (let i = 0; i + 3 < a.length && i + 3 < b.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      diff++
      const px = (i / 4) % w, py = Math.floor((i / 4) / w)
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
    }
  }
  return { diffPixels: diff, totalPixels: total, pct: total ? (diff / total) * 100 : 0, bbox: diff ? { minX, minY, maxX, maxY } : null }
}

interface CaseResult { name: string, frames: Record<number, { width: number, height: number, data: Buffer }>, commandToFrame: Record<number, number> }

/** Runs one scenario end to end: fresh panel, capture at each target frame, close. */
async function runCase(
  win: Page, dirs: Workbench['dirs'], scenario: string | undefined, name: string, targets: number[],
): Promise<CaseResult> {
  setScenario(dirs, scenario)
  const { webview, status, openedAt } = await openPanel(win)
  const frames: CaseResult['frames'] = {}
  const commandToFrame: Record<number, number> = {}
  for (const target of targets) {
    const { seen, atMs } = await waitForFrame(status, target)
    commandToFrame[target] = atMs - openedAt
    const png = await capturePng(webview, `${name}-target${target}-seen${seen}.png`)
    frames[target] = await decodeRgba(win, png)
  }
  await closeEmulatorPanel(win)
  return { name, frames, commandToFrame }
}

test.describe('libretro pre-boot ROM patching (spike T12, not part of the extension surface)', () => {
  test.skip(!ROM_PATH, NO_ROM_REASON)

  test('task A: pre-boot patches, measured before the demo ends', async ({ workbench }) => {
    test.setTimeout(30 * 60_000)
    const { win, dirs } = workbench
    win.on('console', (msg) => {
      if (msg.text().includes('core loaded')) console.log('[webview]', msg.text())
    })

    const PRIMARY = [400, 500, 600]

    // Case 1: baseline, override only, no freeze -- demo plays, Mario walks.
    const baseline = await runCase(win, dirs, 'baseline', 'case1-baseline', PRIMARY)
    // Case 2: positive control -- override + freeze. Known-good: if this
    // doesn't visibly freeze, the pre-boot patch mechanism itself is broken.
    const positiveControl = await runCase(win, dirs, undefined, 'case2-positive-control', [...PRIMARY, 1500])
    // Case 3: THE TEST -- positive control plus $FF at 0x308E2 (L1 object
    // stream truncation). Run both with and without the freeze per the
    // coordinator note (freeze is not side-effect free on every level).
    const truncateFrozen = await runCase(win, dirs, 'truncate-l1', 'case3-truncate-l1-frozen', [...PRIMARY, 1500])
    const truncateMoving = await runCase(win, dirs, 'truncate-l1-no-freeze', 'case3-truncate-l1-moving', PRIMARY)
    // Case 4: secondary -- Mario spawn X, both with and without freeze.
    const spawnFrozen = await runCase(win, dirs, 'spawn-x', 'case4-spawn-x-frozen', PRIMARY)
    const spawnMoving = await runCase(win, dirs, 'spawn-x-no-freeze', 'case4-spawn-x-moving', PRIMARY)

    const diffs: Record<string, unknown> = {}
    // Harness sanity, both directions: baseline must visibly change between
    // two frames (demo not frozen); positive control must not (it is). An
    // oracle that can't fail either way is worthless (CLAUDE.md).
    diffs['baseline moves 400->600'] = pixelDiff(baseline.frames[400].data, baseline.frames[600].data, baseline.frames[400].width)
    diffs['positive-control frozen 400->600'] =
      pixelDiff(positiveControl.frames[400].data, positiveControl.frames[600].data, positiveControl.frames[400].width)

    // THE HEADLINE COMPARISON: same frozen frame count, only the L1 object
    // stream differs.
    for (const t of PRIMARY) {
      diffs[`truncate-l1(frozen) vs positive-control @frame${t}`] =
        pixelDiff(truncateFrozen.frames[t].data, positiveControl.frames[t].data, positiveControl.frames[t].width)
      diffs[`truncate-l1(moving) vs baseline @frame${t}`] =
        pixelDiff(truncateMoving.frames[t].data, baseline.frames[t].data, baseline.frames[t].width)
      diffs[`spawn-x(frozen) vs positive-control @frame${t}`] =
        pixelDiff(spawnFrozen.frames[t].data, positiveControl.frames[t].data, positiveControl.frames[t].width)
      diffs[`spawn-x(moving) vs baseline @frame${t}`] =
        pixelDiff(spawnMoving.frames[t].data, baseline.frames[t].data, baseline.frames[t].width)
    }
    // Secondary, clearly separate from the above: past the demo's ~1426-frame
    // end, to show the divergence rather than rely on it.
    diffs['truncate-l1(frozen) vs positive-control @frame1500 (secondary, post-demo)'] =
      pixelDiff(truncateFrozen.frames[1500].data, positiveControl.frames[1500].data, positiveControl.frames[1500].width)

    saveResult('taskA', {
      commandToFrameMs: {
        baseline: baseline.commandToFrame,
        positiveControl: positiveControl.commandToFrame,
        truncateFrozen: truncateFrozen.commandToFrame,
        truncateMoving: truncateMoving.commandToFrame,
        spawnFrozen: spawnFrozen.commandToFrame,
        spawnMoving: spawnMoving.commandToFrame,
      },
      diffs,
    })
    console.log('[taskA] diffs', JSON.stringify(diffs, null, 2))
  })

  test('task B: what actually pauses emulation (WRAM ground truth)', async ({ workbench }) => {
    test.setTimeout(5 * 60_000)
    const { win, dirs } = workbench
    win.on('console', (msg) => { if (msg.text().includes('[wram]')) console.log('[webview]', msg.text()) })

    // Screenshot-based pixel diffing (this file's earlier approach) is both
    // flaky here (cmd_take_screenshot intermittently never completes) and,
    // per the coordinator's correction, an indirect proxy: "Mario standing
    // still" only proves the demo is frozen, not that SNES frames stopped
    // executing. TrueFrame ($7E0013, rammap.asm) is a ground-truth counter
    // the game itself increments once per executed frame, read directly out
    // of WRAM -- ported from spike/t6/harness.js's cheat-signature technique
    // (T0.plantWramSignature), the only way to find WRAM in this JS-heap
    // environment. GameMode ($7E0100) is polled alongside it because the
    // title-screen/demo mode transitions on its own schedule (confirmed:
    // FadeToGameOver at 0x15 once a sprite reaches frozen Mario, then a
    // different level entirely by GameMode_Level); a frame captured after
    // that transition would attribute someone else's mode change to pause.
    setScenario(dirs, 'pause-test') // override + freeze + stretched demo duration
    const { webview, status } = await openPanel(win)
    await waitForFrame(status, 60)

    // Playwright's evaluate() ships `arg` over to the browser by value; it
    // does not close over other Node-side variables (an earlier version of
    // this test tried to route through Function.prototype.toString() + eval
    // to smuggle a closure across, which is broken for the same reason --
    // the closed-over variables don't exist in the browser realm). Every
    // call below goes through this one indirection instead: method name
    // plus plain-number args, both serializable.
    async function callHook(method: string, ...args: number[]): Promise<void> {
      await webview.locator('body').evaluate((_el, { method: m, args: a }) => {
        const hook = (window as unknown as { __hackbenchTest: Record<string, (...x: number[]) => unknown> }).__hackbenchTest
        hook[m](...a)
      }, { method, args })
    }
    async function readHook(method: string, ...args: number[]): Promise<number> {
      return webview.locator('body').evaluate((_el, { method: m, args: a }) => {
        const hook = (window as unknown as { __hackbenchTest: Record<string, (...x: number[]) => unknown> }).__hackbenchTest
        return hook[m](...a) as number
      }, { method, args })
    }

    await callHook('plantWramSignature')
    await win.waitForTimeout(500) // let a few real frames execute the planted cheat write
    const wramBase = await readHook('findWramBase')
    expect(wramBase, 'WRAM signature not found in heap').toBeGreaterThanOrEqual(0)

    const GAME_MODE = 0x100
    const TRUE_FRAME = 0x13
    async function readWram(offset: number): Promise<number> {
      return readHook('readWram', wramBase, offset)
    }

    const gameModeAtStart = await readWram(GAME_MODE)
    console.log('[taskB] wramBase', wramBase, 'GameMode at start', gameModeAtStart)

    // Harness sanity: TrueFrame must visibly advance with nothing paused,
    // over a real wall-clock interval, before any mechanism is trusted.
    const sanityA = await readWram(TRUE_FRAME)
    await win.waitForTimeout(500)
    const sanityB = await readWram(TRUE_FRAME)
    const sanityDelta = (sanityB - sanityA + 256) % 256
    console.log('[taskB] sanity: TrueFrame advanced', sanityDelta, 'over 500ms unpaused')

    async function call(mechanism: string): Promise<void> {
      if (mechanism === 'pauseMainLoop-pause') await callHook('pauseMainLoop')
      else if (mechanism === 'pauseMainLoop-resume') await callHook('resumeMainLoop')
      else if (mechanism === 'toggleMainLoop-pause') await callHook('toggleMainLoop', 1)
      else if (mechanism === 'toggleMainLoop-resume') await callHook('toggleMainLoop', 0)
      // 'noop' intentionally calls nothing -- a negative control.
    }

    const pauseResults: Record<string, unknown> = { wramBase, gameModeAtStart, sanityDeltaUnpaused500ms: sanityDelta }
    for (const mechanism of ['pauseMainLoop', 'toggleMainLoop', 'noop']) {
      const modeBefore = await readWram(GAME_MODE)
      if (mechanism !== 'noop') await call(`${mechanism}-pause`)
      const trueFrameBeforeWait = await readWram(TRUE_FRAME)
      await win.waitForTimeout(1500)
      const trueFrameAfterWait = await readWram(TRUE_FRAME)
      const modeAfterWait = await readWram(GAME_MODE)
      const deltaWhilePaused = (trueFrameAfterWait - trueFrameBeforeWait + 256) % 256

      if (mechanism !== 'noop') await call(`${mechanism}-resume`)
      const trueFrameAfterResumeStart = await readWram(TRUE_FRAME)
      await win.waitForTimeout(800)
      const trueFrameAfterResumeWait = await readWram(TRUE_FRAME)
      const deltaAfterResume = (trueFrameAfterResumeWait - trueFrameAfterResumeStart + 256) % 256

      pauseResults[mechanism] = {
        gameModeStayedAt: modeBefore === modeAfterWait ? modeBefore : { before: modeBefore, afterWait: modeAfterWait },
        trueFrameDeltaOver1500msWhilePaused: deltaWhilePaused,
        trueFrameDeltaOver800msAfterResume: deltaAfterResume,
      }
      console.log(`[taskB] ${mechanism}`, JSON.stringify(pauseResults[mechanism]))
    }

    saveResult('taskB', pauseResults)
    await closeEmulatorPanel(win)
  })
})
