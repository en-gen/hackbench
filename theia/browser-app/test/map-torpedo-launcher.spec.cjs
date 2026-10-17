/**
 * Sprite $CA, the Torpedo Ted launcher (#985), draws the frame at launch on map $011: the launcher hand and the
 * torpedo it releases, from the ROM's own shooter code (LaunchTorpedo / LauncherArm, SMWDisX bank_02.asm:6835-6902,
 * 3969-4003), instead of the 16 x 16 placeholder box with the hex "CA".
 *
 * Map $011 (vanilla ROM) places 19 of them (the stream parsed once, one run). Per launcher, from the RPC reply:
 * - it is `drawn`, not a placeholder, and its bitmap is larger than the 16 x 16 marker (hand plus torpedo);
 * - no pixel is the marker's frame colour (the placeholder's blue frame, 90,200,255);
 * - the hand's 16 x 16 area at shooter X + 8, Y - 9 holds opaque pixels, and the strip of it above the torpedo
 *   (Y - 9 .. Y - 1, where only the hand draws) is not empty.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - map-sprites.ts `interpDrawer`: delete the `TORPEDO_LAUNCHER_ID` branch (the marker returns, first assertion);
 * - map-sprites.ts `launcherResult`: drop `l.arm` from `interpParts([...shifted, ...l.arm])` (no hand pixels above
 *   the torpedo, the hand-area assertion);
 * - TorpedoLauncher.ts: `+ 8` of the hand is the game's, so the unit test (TorpedoLauncher.test.ts) pins the offset.
 * NOT covered here: the colours (the reply's own palette is what is read); the unit tests pin tile and attribute.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x11
const LAUNCHERS = 19
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
let tmp
let manifestPath

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-torpedo-launcher-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  manifestPath = project.manifestPath
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('on map $011 every $CA draws the launcher hand and the torpedo, not the placeholder box', async ({
  page,
}) => {
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const launchers = reply.sprites.filter(s => s.id === 0xca)
  expect(launchers, 'the $CA launchers of map $011').toHaveLength(LAUNCHERS)

  const bad = []
  for (const s of launchers) {
    const w = s.box.x1 - s.box.x0
    const h = s.box.y1 - s.box.y0
    if (s.status !== 'drawn') {
      bad.push(`#${s.index} at ${s.x},${s.y}: status ${s.status} (${s.reason})`)
      continue
    }
    if (w <= 16 || h <= 16) bad.push(`#${s.index}: bitmap ${w}x${h} is not larger than the marker`)
    const rgba = Buffer.from(s.rgba, 'base64')
    const px = (x, y) => {
      const i = ((y - s.box.y0) * w + (x - s.box.x0)) * 4
      return x < s.box.x0 || x >= s.box.x1 || y < s.box.y0 || y >= s.box.y1
        ? [0, 0, 0, 0]
        : [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }
    // The marker's blue frame (90,200,255): no pixel of a real preview has it.
    let frame = 0
    for (let i = 0; i < rgba.length; i += 4)
      if (rgba[i] === 90 && rgba[i + 1] === 200 && rgba[i + 2] === 255 && rgba[i + 3] === 255)
        frame++
    if (frame) bad.push(`#${s.index}: ${frame} pixels in the marker's frame colour`)
    // The hand: 16 x 16 at the shooter's X + 8, Y - 9. Its top strip (Y - 9 .. Y - 1) is above the torpedo.
    const handTop = []
    for (let y = s.y - 9; y < s.y; y++)
      for (let x = s.x + 8; x < s.x + 24; x++) handTop.push(px(x, y))
    const opaque = handTop.filter(p => p[3] !== 0).length
    if (opaque === 0) bad.push(`#${s.index} at ${s.x},${s.y}: no hand pixels above the torpedo`)
    const handAll = []
    for (let y = s.y - 9; y < s.y + 7; y++)
      for (let x = s.x + 8; x < s.x + 24; x++) handAll.push(px(x, y))
    if (handAll.filter(p => p[3] !== 0).length <= opaque)
      bad.push(`#${s.index}: nothing in the hand area below its top strip`)
  }
  expect(bad).toEqual([])
})
