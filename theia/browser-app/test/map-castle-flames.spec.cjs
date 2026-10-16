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
 * NOT covered here: "flames under Layer 1". The verifier measured no vanilla flame map with an opaque Layer 1 pixel
 * under a flame ($01F, all 6 screens, one run, real app), so that order is proven by the unit tests
 * (test/suite/unit/MapFlamePlanes.test.ts, castle shape), not by this spec.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - map-sprites.ts `castleFlameSprites`: a wrong `y` for the copies moves the positions (the first assertion);
 * - map-view-model.ts `withFlameKeys` returning `{ ...lists }` unchanged: no flame planes on this split list, the flames
 *   never show and the "flame colours show" assertion goes red.
 * Plant NOT caught here: `out.splice(out.length, 0, ...missing)` in `withFlameKeys` (flames over Layer 1); the unit
 * tests catch it (4 red in MapFlamePlanes.test.ts).
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

/** The composite of screen 0 at flat pixel indices, as "r,g,b,a" strings. */
const sample = (page, pixels) =>
  page.evaluate(
    ({ rootSel, pixels }) => {
      const c = planesOf(rootSel, 0)[0]
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      return pixels.map(p => [0, 1, 2, 3].map(k => d[p * 4 + k]).join(','))
    },
    { rootSel: rootOf(), pixels },
  )

/** Share of `got` entries equal to the same index of `want`. */
const share = (got, want) => got.filter((v, i) => v === want[i]).length / Math.max(got.length, 1)

/** Opens the map, waits for screen 0, and returns the flames' opaque pixels on it with their colours. */
async function openAndFlamePixels(page, reply) {
  const flames = reply.sprites.filter(s => s.fixedTo === 'layer2')
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
  const l1Low = `${rootOf()} canvas[data-screen="0"][data-plane="l1Low"]`
  await expect(page.locator(l1Low)).toHaveAttribute('data-drawn', /^\d+:0000:000:\d+$/, {
    timeout: 30000,
  })

  return page.evaluate(
    ({ flames, width, height }) => {
      const out = { open: [], openRgb: [] }
      for (const f of flames) {
        const rgba = Uint8Array.from(atob(f.rgba), c => c.charCodeAt(0))
        const w = f.box.x1 - f.box.x0
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i + 3] === 0) continue
          const x = f.box.x0 + ((i / 4) % w)
          const y = f.box.y0 + Math.floor(i / 4 / w)
          if (x >= width || y >= height) continue
          out.open.push(y * width + x)
          out.openRgb.push(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},255`)
        }
      }
      return out
    },
    { flames, width: reply.width, height: reply.height },
  )
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

  const split = await openAndFlamePixels(page, reply)
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
  const flames = reply.sprites.filter(s => s.fixedTo === 'layer2')
  expect(flames.length, 'layer 2 flames on $101').toBeGreaterThan(0)
  const split = await openAndFlamePixels(page, reply)
  expect(split.open.length, 'opaque flame pixels on screen 0').toBeGreaterThan(0)
  // Measured 0.72 of 288 pixels (one machine): the rest sit under Layer 1 or another flame, so a floor, not 0.9.
  expect(
    share(await sample(page, split.open), split.openRgb),
    'flame colours show',
  ).toBeGreaterThan(0.6)
  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => share(await sample(page, split.open), split.openRgb), { timeout: 15000 })
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
      for (const s of sprites) {
        if (s.fixedTo === 'layer2') continue
        const w = s.box.x1 - s.box.x0
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
      return { out, others: sprites.filter(s => s.fixedTo !== 'layer2').length }
    },
    { sprites: reply.sprites, flames },
  )
  expect(leaks.others, 'sprites checked').toBeGreaterThan(0)
  expect(leaks.out).toEqual([])
})
