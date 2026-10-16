/**
 * Sprites $E2 / $E3 draw as a ring of 10 pieces, run from the ROM's own cluster code (#983). Related: #839.
 *
 * Map $107 (vanilla ROM). Its first $E3 is list entry 2 at (496, 320); the Mesen frames layers_v5/107 (windows
 * screen_01 and screen_02, OAM 76-85, 16 x 16, attribute $73) show the ring of that entry with each piece 80 px
 * from the entry's position, 40/512 of a turn apart (a 253 degree arc: 10 pieces, not a closed circle). The unit
 * test test/suite/unit/sprites/RotatingRing.test.ts pins the ROM-run OAM to those frames exactly (10 of 10, at the
 * angles the frames held). The map view shows the spawn state, angle 0 (owner call A).
 * Checked here from the RPC reply and the composite:
 * - exactly one $E3 sprite, at its real stream index 2, drawn (not a marker), unflagged, whose bitmap holds an
 *   opaque pixel in each of the 10 squares where the pieces stand (80 px round the entry, computed here from the
 *   geometry above, not from the code under test, to within 2 px);
 * - the ring's colours show in the composite on both screens it spans, and the sprite toggle (S) takes them out;
 * - no OTHER sprite's bitmap holds the ring (each is small and stays within 32 px of its anchor, #809/#839).
 * NOT covered: hovering or selecting the sprite (index 2). The map view has no sprite selection yet (#981, open);
 * the reply's single stream-indexed entry is what it will key on, which is asserted. The $E2 ring (also on $107,
 * entry 14) is covered by the unit sweep over all 10 vanilla placements.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - RotatingRing.ts: `run(SPAWN, { a: e.id })` replaced by a call that skips the spawn: no pieces, a marker;
 * - map-sprites.ts `interpDrawer`: remove the `RING_LEFT` / `RING_RIGHT` line: the marker returns.
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

const SLOT = 0x107
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-rotating-ring-'))
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

/** Opens the map; returns once each of `screens` is scrolled to, fetched, and painted with its sprites. */
async function openMap(page, screens) {
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
  for (const s of screens) {
    const at = kind => `${rootOf()} canvas[data-screen="${s}"][data-plane="${kind}"]`
    await page
      .locator(at('l1Low'))
      .evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
    await expect(page.locator(at('l1Low'))).toHaveAttribute('data-drawn', /^\d+:0000:000:\d+$/, {
      timeout: 30000,
    })
    await expect(page.locator(at('sprites'))).toHaveAttribute('data-drawn', /^\d+:[1-9]\d*$/, {
      timeout: 30000,
    })
    const comp = `${rootOf()} canvas[data-layer="screen"][data-screen="${s}"]`
    await expect(page.locator(comp).first()).toHaveAttribute('data-drawn', /:1111:[1-9]\d*:/, {
      timeout: 30000,
    })
  }
}

/** The ring's opaque pixels on one screen: flat indices into that screen's canvas, with colours. */
function ringPixels(reply, ring, screen) {
  const out = { open: [], openRgb: [] }
  const x0 = screen * reply.width
  const rgba = Buffer.from(ring.rgba, 'base64')
  const w = ring.box.x1 - ring.box.x0
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue
    const x = ring.box.x0 + ((i / 4) % w) - x0
    const y = ring.box.y0 + Math.floor(i / 4 / w)
    if (x < 0 || x >= reply.width || y < 0 || y >= reply.height) continue
    out.open.push(y * reply.width + x)
    out.openRgb.push(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},255`)
  }
  return out
}

test('the $E3 ring of map $107 is one drawn sprite of 10 pieces 80 px round its entry, shows in the composite, and follows the toggle', async ({
  page,
}) => {
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const rings = reply.sprites.filter(s => s.id === 0xe3)
  expect(rings.length, 'one $E3 in the list of $107').toBe(1)
  const ring = rings[0]
  expect([ring.index, ring.x, ring.y, ring.status, ring.unverified]).toEqual([2, 496, 320, 'drawn', undefined]) // prettier-ignore

  // Ten 16 x 16 squares, top-left at the entry + 80 * (sin, cos) of 40/512 of a turn per piece (the Mesen frames).
  const squares = Array.from({ length: 10 }, (_, k) => {
    const a = (2 * Math.PI * 40 * k) / 512
    return [496 + 80 * Math.sin(a), 320 + 80 * Math.cos(a)]
  })
  const w = ring.box.x1 - ring.box.x0
  const rgba = Buffer.from(ring.rgba, 'base64')
  const opaqueIn = (sx, sy) => {
    let n = 0
    for (let y = Math.round(sy) - 2; y < Math.round(sy) + 18; y++)
      for (let x = Math.round(sx) - 2; x < Math.round(sx) + 18; x++) {
        const bx = x - ring.box.x0
        const by = y - ring.box.y0
        if (bx < 0 || by < 0 || bx >= w || by * w + bx >= rgba.length / 4) continue
        if (rgba[(by * w + bx) * 4 + 3]) n++
      }
    return n
  }
  squares.forEach(([sx, sy], k) =>
    expect(opaqueIn(sx, sy), `piece ${k} at ${sx.toFixed(0)},${sy.toFixed(0)}`).toBeGreaterThan(0),
  )
  // The envelope of the pieces is the box (16 wide each), to within 2 px of the geometry.
  const xs = squares.map(s => s[0])
  const ys = squares.map(s => s[1])
  expect(Math.abs(ring.box.x0 - Math.min(...xs))).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.box.x1 - (Math.max(...xs) + 16))).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.box.y0 - Math.min(...ys))).toBeLessThanOrEqual(2)
  expect(Math.abs(ring.box.y1 - (Math.max(...ys) + 16))).toBeLessThanOrEqual(2)

  // No other sprite carries the ring (#809/#839): each stays small and near its anchor.
  const stray = reply.sprites
    .filter(s => s.id !== 0xe3 && s.id !== 0xe2 && s.status === 'drawn')
    .filter(s => {
      const [bw, bh] = [s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]
      return bw > 32 || bh > 32 || s.box.x0 < s.x - 32 || s.box.x1 > s.x + 32 || s.box.y0 < s.y - 32 || s.box.y1 > s.y + 32 // prettier-ignore
    })
  expect(stray.map(s => `$${s.id.toString(16)} at ${s.x},${s.y}`)).toEqual([])

  // The ring spans x 416..592: screens 1 and 2 (256 px each).
  await openMap(page, [1, 2])
  const kept = { open: [], openRgb: [] }
  for (const s of [1, 2]) {
    const px = ringPixels(reply, ring, s)
    expect(px.open.length, `opaque ring pixels on screen ${s}`).toBeGreaterThan(0)
    const got = await sample(page, px.open, s)
    expect(share(got, px.openRgb), `screen ${s}: ring colours show`).toBeGreaterThan(0.9)
    if (s === 2) Object.assign(kept, px)
  }

  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => share(await sample(page, kept.open, 2), kept.openRgb), { timeout: 15000 })
    .toBeLessThan(0.5)
})
