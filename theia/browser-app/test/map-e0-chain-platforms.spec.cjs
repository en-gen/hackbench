/**
 * Sprite $E0 draws three Grey Platforms on Chain from one placement, run from the ROM's own spawner (the $E0 issue,
 * docs/sprites/sprite-e0-chain-platforms.md).
 *
 * Vanilla map $135 places $E0 seven times; the first is at (368, 240). Before this change every one was a 16 x 16
 * placeholder. Checked from the RPC reply and the composite:
 * - seven $E0 sprites at the documented pixel positions, status 'drawn' (not 'placeholder'), no `unverified` and no
 *   `note` (a note reading "Only N of the 3 platforms appear" would mean fewer than three spawned);
 * - every one's pixel box is exactly (-57,-25)..(+74,+64) from its placement (131 x 89), the platforms at their spawn-frame offsets;
 * - its opaque pixels show in the composite of screen 1, and the sprite toggle (S) takes them out.
 * NOT covered: the pixels against hardware (no capture); hovering or selecting the sprite (#981). The platform COUNT
 * itself is pinned by test/suite/unit/sprites/ThreePlatforms.corpus.test.ts (spawned === 3); the reply carries no parts.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - map-sprites.ts `interpDrawer`: remove the line that routes $E0 to `platformsResult`: the placeholder returns;
 * - SpawnedChildren.ts: set SpriteLock to 0 (the travel frame returns): boxes shift 1-2 px by placement and the box assertion fails;
 * - the ROM: plant a 1 in the spawner's count immediate in the ROM the spec loads (not PLATFORM_COUNT, which draws one
 *   platform and shows no note): the box shrinks and the note appears.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

// The slot under test; each test sets it first (the hooks read it).
let SLOT = 0x135
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const rootOf = () => `[id="hackbench.map-view:${SLOT}"]`
let tmp
let manifestPath

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e0-platforms-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  manifestPath = project.manifestPath
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async id => {
    try {
      await getSvc('ApplicationShell').closeWidget(id)
    } catch {
      /* already closed */
    }
  }, `hackbench.map-view:${SLOT}`)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** The composite of screen `screen` at flat pixel indices, as "r,g,b,a" strings. */
const sample = (page, pixels, screen) =>
  page.evaluate(
    ({ rootSel, pixels, screen }) => {
      const c = planesOf(rootSel, screen)[0]
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      return pixels.map(p => [0, 1, 2, 3].map(k => d[p * 4 + k]).join(','))
    },
    { rootSel: rootOf(), pixels, screen },
  )

const share = (got, want) => got.filter((v, i) => v === want[i]).length / Math.max(got.length, 1)

/** Opens the map; returns once `screen` is scrolled to, fetched, and painted with its sprites. */
async function openMap(page, screen) {
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index: SLOT },
  )
  const at = kind => `${rootOf()} canvas[data-screen="${screen}"][data-plane="${kind}"]`
  await page
    .locator(at('l1Low'))
    .evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
  await expect(page.locator(at('l1Low'))).toHaveAttribute('data-drawn', /^\d+:0000:000:\d+$/, {
    timeout: 30000,
  })
  await expect(page.locator(at('sprites'))).toHaveAttribute('data-drawn', /^\d+:[1-9]\d*$/, {
    timeout: 30000,
  })
  const comp = `${rootOf()} canvas[data-layer="screen"][data-screen="${screen}"]`
  await expect(page.locator(comp).first()).toHaveAttribute('data-drawn', /:1111:[1-9]\d*:/, {
    timeout: 30000,
  })
}

test('the $E0 placements of map $135 are seven drawn sprites of three chain platforms each, in the composite, and follow the toggle', async ({
  page,
}) => {
  SLOT = 0x135
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const e0 = reply.sprites.filter(s => s.id === 0xe0)
  expect(e0.map(s => [s.x, s.y])).toEqual([
    [368, 240],
    [768, 192],
    [1712, 176],
    [2112, 320],
    [3056, 176],
    [3888, 160],
    [4496, 208],
  ])
  for (const s of e0) {
    expect(s.status, `entry ${s.index} is drawn, not the placeholder`).toBe('drawn')
    expect(s.unverified).toBeUndefined()
    expect(s.note, 'all three platforms spawned').toBeUndefined()
    expect(s.box.x1 - s.box.x0, `entry ${s.index} is wider than a 16 px placeholder`).toBeGreaterThan(64) // prettier-ignore
  }
  // Spawn-frame positions, no travel (D137): the group's box is the union of the three platforms and their chains at the
  // offsets the spawner put them (vanilla sweep, one machine, derived from the ROM's code: platform parts span
  // x -57..58 and y -25..48 from the placement, 16 px pieces), so every placement has the SAME box relative to its
  // spot, to the pixel. A frame of travel would move the platforms 1-2 px by bit 4 of the placement X and break this.
  // The reply carries no parts, so the box edges are the only position it exposes; per-platform offsets are pinned by
  // ThreePlatforms.corpus.test.ts.
  for (const e of e0) {
    expect([e.box.x0 - e.x, e.box.y0 - e.y, e.box.x1 - e.x, e.box.y1 - e.y], `entry ${e.index} box from its spot`).toEqual([-57, -25, 74, 64]) // prettier-ignore
  }
  const s = e0[0]

  // x 368 is on screen 1 (256..511); only the pixels inside that screen are compared.
  await openMap(page, 1)
  const rgba = Buffer.from(s.rgba, 'base64')
  const w = s.box.x1 - s.box.x0
  const open = []
  const want = []
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue
    const x = s.box.x0 + ((i / 4) % w) - 256
    const y = s.box.y0 + Math.floor(i / 4 / w)
    if (x < 0 || x > 255 || y < 0 || y > 431) continue
    open.push(y * 256 + x)
    want.push(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},255`)
  }
  expect(open.length, 'opaque platform pixels on screen 1').toBeGreaterThan(100)
  // Overlap with another sprite or a layer in front can hide some; 0.9 is sampling slack, the verifier records the measured share.
  expect(share(await sample(page, open, 1), want), 'platform colours show').toBeGreaterThan(0.9)

  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => share(await sample(page, open, 1), want), { timeout: 15000 })
    .toBeLessThan(0.5)
})
