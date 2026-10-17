/**
 * Sprite $E6's castle candle flames draw on Layer 2, from the ROM's own cluster code (#894).
 *
 * Map $01F (vanilla ROM). The Mesen capture layers_v5/01f (frames 8-24, one machine) has Layer1YPos =
 * Layer2YPos = 192 and OAM 124-127 at X $50 $90 $D0 $10, screen Y $30 (= $F0 - 192), 16 x 16, attribute
 * $09/$49: so on the map the flames stand at X $10 $50 $90 $D0 (+256 per copy) and Y $F0 (+256 per
 * copy), as the node reply must say. Checked here from the RPC reply and the composite:
 * - the reply's flame bitmaps sit at exactly those positions, and the $E6 marker is still a sprite;
 * - the flames' own colours show in the composite (the pixels asserted are non-empty first);
 * - the sprite toggle (S) off takes the flame colours out of those pixels.
 * Map $01F is a split-list map (OBJ on the main screen, layer 2 on the sub screen, CGADSUB 32), the shape of all 7
 * flame maps, so this also guards `withFlameKeys` placing the flame planes on the OBJ screen.
 * "Flames under Layer 1" is covered by the $101 test below, not by $01F: the verifier measured no opaque Layer 1 pixel
 * under a $01F flame (all 6 screens, one run, real app), but $101 has 80 flame pixels under Layer 1 on screen 0.
 * The unit tests (test/suite/unit/MapFlamePlanes.test.ts, castle shape) cover the order too.
 * NOT covered by Playwright (all 7 vanilla flame maps have dy = 0): a mutant ignoring `dy` in castleFlameSprites; the
 * synthetic cases in test/suite/unit/sprites/CastleFlames.test.ts catch it (7 red, one run).
 * NOT pinned here: flame COLOURS. The expected colour comes from the same mapSprites reply that is drawn, so a wrong
 * palette row in castleFlameSprites passes. A synthetic unit test is filed as a follow-up.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - map-sprites.ts `castleFlameSprites`: a wrong `y` for the copies moves the positions (the first assertion);
 * - map-view-model.ts `withFlameKeys` returning `{ ...lists }` unchanged: no flame planes on this split list, the flames
 *   never show and the "flame colours show" assertion goes red.
 * - `out.splice(out.length, 0, ...missing)` in `withFlameKeys` (flames over Layer 1): not caught by the $01F test, caught
 *   by the $101 test (flame colour under Layer 1; the unit tests catch it too, 4 red in MapFlamePlanes.test.ts).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT || 3000}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

// The slot under test; each test sets it first (the hooks read it).
let SLOT = 0x1f
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-castle-flames-'))
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
const sample = (page, pixels, screen = 0) =>
  page.evaluate(
    ({ rootSel, pixels, screen }) => {
      const c = planesOf(rootSel, screen)[0]
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      return pixels.map(p => [0, 1, 2, 3].map(k => d[p * 4 + k]).join(','))
    },
    { rootSel: rootOf(), pixels, screen },
  )

/** Per pixel: is Layer 1 opaque there (l1Low or l1High plane canvas of that screen)? */
const underLayer1 = (page, pixels, screen) =>
  page.evaluate(
    ({ rootSel, pixels, screen }) => {
      const read = plane => {
        const c = document.querySelector(
          `${rootSel} canvas[data-screen="${screen}"][data-plane="${plane}"]`,
        )
        return c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      }
      const [lo, hi] = [read('l1Low'), read('l1High')]
      return pixels.map(p => lo[p * 4 + 3] !== 0 || hi[p * 4 + 3] !== 0)
    },
    { rootSel: rootOf(), pixels, screen },
  )

/** Share of `got` entries equal to the same index of `want`. */
const share = (got, want) => got.filter((v, i) => v === want[i]).length / Math.max(got.length, 1)

/** Opens the map; returns once each of `screens` is scrolled to, fetched, and painted with its sprites. */
async function openMap(page, screens = [0]) {
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
    // Screens are fetched when scrolled into view.
    await page
      .locator(at('l1Low'))
      .evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' }))
    await expect(page.locator(at('l1Low'))).toHaveAttribute('data-drawn', /^\d+:0000:000:\d+$/, {
      timeout: 30000,
    })
    // The sprites reply lands after the planes; version 0 is "not yet", and sampling then reads no flames.
    await expect(page.locator(at('sprites'))).toHaveAttribute('data-drawn', /^\d+:[1-9]\d*$/, {
      timeout: 30000,
    })
    const comp = `${rootOf()} canvas[data-layer="screen"][data-screen="${s}"]`
    await expect(page.locator(comp).first()).toHaveAttribute('data-drawn', /:1111:[1-9]\d*:/, {
      timeout: 30000,
    })
  }
}

/** The flames' opaque pixels on one screen of the reply: flat indices into that screen's canvas, with colours. */
function flamePixels(reply, screen = 0) {
  const out = { open: [], openRgb: [] }
  const x0 = screen * reply.width
  for (const f of reply.sprites.filter(s => s.fixedTo === 'layer2')) {
    const rgba = Buffer.from(f.rgba, 'base64')
    const w = f.box.x1 - f.box.x0
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i + 3] === 0) continue
      const x = f.box.x0 + ((i / 4) % w) - x0
      const y = f.box.y0 + Math.floor(i / 4 / w)
      if (x < 0 || x >= reply.width || y >= reply.height) continue
      out.open.push(y * reply.width + x)
      out.openRgb.push(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},255`)
    }
  }
  return out
}

test('the flames stand where the capture puts them, sit over layer 2, and follow the sprite toggle', async ({
  page,
}) => {
  SLOT = 0x1f
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const flames = reply.sprites.filter(s => s.fixedTo === 'layer2')
  const origins = flames.map(f => `${f.box.x0},${f.box.y0}`)
  for (const x of [0x10, 0x50, 0x90, 0xd0])
    expect(origins, `a flame at X $${x.toString(16)}, Y $F0`).toContain(`${x},240`)
  expect(flames.every(f => f.box.x1 - f.box.x0 === 16 && f.box.y1 - f.box.y0 === 16)).toBe(true)
  expect(
    reply.sprites.some(s => s.id === 0xe6 && !s.fixedTo),
    'the $E6 marker stays',
  ).toBe(true)

  await openMap(page)
  const split = flamePixels(reply)
  expect(split.open.length, 'opaque flame pixels on screen 0').toBeGreaterThan(0)
  const onOpen = await sample(page, split.open)
  expect(share(onOpen, split.openRgb), 'open flame pixels show the flame colour').toBeGreaterThan(
    0.9,
  )

  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // Measured on the flame colour itself: it leaves the flame pixels (not "something changed"); they were >90% flame colour above.
  await expect
    .poll(async () => share(await sample(page, split.open), split.openRgb), { timeout: 15000 })
    .toBeLessThan(0.1)
})

// Map $101 (#887): the flames draw on Layer 2 (#907) and no flame tile joins another sprite's parts (#809, #849).
test('on map $101 the flames draw on layer 2 and no other sprite draws a flame tile', async ({
  page,
}) => {
  SLOT = 0x101
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  expect(reply.orientation).toBe('horizontal')
  const flames = reply.sprites.filter(s => s.fixedTo === 'layer2')

  // Positions pinned from the capture, not from the code under test: per 256 px, X $10 $50 $90 $D0 at Y $F0
  // (the layers_v5/01f citation above; $101 has the same $E6 and dy = 0, one run, one machine), 16 x 16 each.
  const want = []
  for (let x = 0; x < reply.width * reply.screenCount; x += 256)
    for (const o of [0x10, 0x50, 0x90, 0xd0]) want.push(`${x + o},240`)
  expect(want.length, '4 flames per screen over 8 screens').toBe(32)
  expect(flames.map(f => `${f.box.x0},${f.box.y0}`).sort()).toEqual(want.sort())
  expect(flames.every(f => f.box.x1 - f.box.x0 === 16 && f.box.y1 - f.box.y0 === 16)).toBe(true)

  const screens = [...Array(reply.screenCount).keys()]
  await openMap(page, screens)
  // Every screen: a flame pixel shows the flame colour exactly where Layer 1 is clear, and never under Layer 1
  // (flames sit under Layer 1 and never overlap each other). Vanilla, one machine, one run: screen 0: 288 flame pixels, 208 clear, 80 under Layer 1 (vanilla, node composer, one run).
  let total = 0
  let free0 = { open: [], openRgb: [] }
  for (const s of screens) {
    const px = flamePixels(reply, s)
    const got = await sample(page, px.open, s)
    const under = await underLayer1(page, px.open, s)
    const bad = []
    px.open.forEach((p, i) => {
      if ((got[i] === px.openRgb[i]) === under[i])
        bad.push(
          `screen ${s} px ${p}: under Layer 1 = ${under[i]}, composite ${got[i]}, flame ${px.openRgb[i]}`,
        )
    })
    expect(bad.slice(0, 5), `screen ${s}: flame colour exactly where Layer 1 is clear`).toEqual([])
    expect(
      under.filter(u => !u).length,
      `screen ${s}: flame pixels with no Layer 1`,
    ).toBeGreaterThan(0)
    total += px.open.length
    if (s === 0)
      free0 = {
        open: px.open.filter((_, i) => !under[i]),
        openRgb: px.openRgb.filter((_, i) => !under[i]),
      }
  }
  expect(total, 'opaque flame pixels over the map').toBeGreaterThan(0)

  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => share(await sample(page, free0.open, 0), free0.openRgb), { timeout: 15000 })
    .toBeLessThan(0.1)

  // Another sprite's bitmap holds no opaque pixel where a flame draws: before #849 the cluster flames' OAM read as
  // part of every sprite, so each bitmap carried the flame tiles at the flame positions.
  const leaks = await page.evaluate(
    ({ sprites, flames }) => {
      const key = (x, y) => `${x},${y}`
      const at = new Set()
      for (const f of flames) {
        const w = f.box.x1 - f.box.x0
        const rgba = Uint8Array.from(atob(f.rgba), c => c.charCodeAt(0))
        for (let i = 0; i < rgba.length; i += 4)
          if (rgba[i + 3]) at.add(key(f.box.x0 + ((i / 4) % w), f.box.y0 + Math.floor(i / 4 / w)))
      }
      const out = []
      const bounds = []
      for (const s of sprites) {
        if (s.fixedTo === 'layer2') continue
        const [w, h] = [s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]
        // The overlap test alone passes a leak that widens every sprite yet misses the flame pixels (#809 made each
        // box 208 wide). A drawn sprite is at most 32 x 32 and within 32 px of its anchor (vanilla $101: 16 x 32 at
        // most, one run, one machine).
        const far = d =>
          s.box.x0 < s.x - d || s.box.x1 > s.x + d || s.box.y0 < s.y - d || s.box.y1 > s.y + d
        if (s.status === 'drawn' && (w > 32 || h > 32 || far(32)))
          bounds.push(
            `sprite $${s.id.toString(16)} at ${s.x},${s.y}: box ${w}x${h} from ${s.box.x0},${s.box.y0}`,
          )
        const rgba = Uint8Array.from(atob(s.rgba), c => c.charCodeAt(0))
        let n = 0
        for (let i = 0; i < rgba.length; i += 4)
          if (
            rgba[i + 3] &&
            at.has(key(s.box.x0 + ((i / 4) % w), s.box.y0 + Math.floor(i / 4 / w)))
          )
            n++
        if (n)
          out.push(`sprite $${s.id.toString(16)} at ${s.box.x0},${s.box.y0}: ${n} px on a flame`)
      }
      return { out, bounds, others: sprites.filter(s => s.fixedTo !== 'layer2').length }
    },
    { sprites: reply.sprites, flames },
  )
  expect(leaks.others, 'sprites checked').toBeGreaterThan(0)
  expect(leaks.out).toEqual([])
  expect(leaks.bounds, 'drawn sprites stay within 32 px of their anchor').toEqual([])
})
