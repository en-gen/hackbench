/**
 * Sprite $E6's castle candle flames draw on Layer 2, from the ROM's own cluster code (#894).
 *
 * Map $01F (vanilla ROM). The Mesen capture layers_v5/01f (frames 8-24, one machine) has Layer1YPos =
 * Layer2YPos = 192 and OAM 124-127 at X $50 $90 $D0 $10, screen Y $30 (= $F0 - 192), 16 x 16, attribute
 * $09/$49: so on the map the flames stand at X $10 $50 $90 $D0 (+256 per copy) and Y $F0 (+256 per
 * copy), as the node reply must say. Checked here from the RPC reply and the composite:
 * - the reply's flame bitmaps sit at exactly those positions, and the $E6 marker is still a sprite;
 * - toggled on, a flame pixel with no layer 1 over it shows in the composite (it differs from the
 *   sprites-hidden composite), and one with layer 1 over it does not (layer 1 covers the flames, the
 *   flames cover layer 2);
 * - the sprite toggle (S) off puts every open flame pixel back to layer 2.
 * Plants for the verifier: in map-sprites.ts `castleFlameSprites`, a wrong `y` for the copies moves the
 * positions (the first assertion goes red); in map-view-model.ts `withFlameKeys`, putting the flame keys
 * after `l1High` shows the flames over layer 1 (the covered-pixels assertion goes red).
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

const SLOT = 0x1f
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const root = `[id="hackbench.map-view:${SLOT}"]`
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
    { rootSel: root, pixels },
  )

test('the flames stand where the capture puts them, sit over layer 2 and under layer 1, and follow the sprite toggle', async ({
  page,
}) => {
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
  const l1Low = `${root} canvas[data-screen="0"][data-plane="l1Low"]`
  await expect(page.locator(l1Low)).toHaveAttribute('data-drawn', /^\d+:0000:000:\d+$/, {
    timeout: 30000,
  })

  // Opaque flame pixels on screen 0 as flat indices, split by whether layer 1 is opaque there.
  const split = await page.evaluate(
    ({ rootSel, flames, width }) => {
      const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const l1 = ['l1Low', 'l1High'].map(p =>
        px(document.querySelector(`${rootSel} canvas[data-screen="0"][data-plane="${p}"]`)),
      )
      const out = { open: [], covered: [] }
      for (const f of flames) {
        const rgba = Uint8Array.from(atob(f.rgba), c => c.charCodeAt(0))
        const w = f.box.x1 - f.box.x0
        for (let i = 0; i < rgba.length; i += 4) {
          if (rgba[i + 3] === 0) continue
          const x = f.box.x0 + ((i / 4) % w)
          const y = f.box.y0 + Math.floor(i / 4 / w)
          if (x >= width || y * width + x >= l1[0].length / 4) continue
          const p = y * width + x
          ;(l1.some(l => l[p * 4 + 3] > 0) ? out.covered : out.open).push(p)
        }
      }
      return out
    },
    { rootSel: root, flames, width: reply.width },
  )
  expect(split.open.length, 'flame pixels with no layer 1 over them').toBeGreaterThan(0)
  const all = [...split.open, ...split.covered]
  const on = await sample(page, all)

  const toggle = page.locator(`${root} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const differ = (a, b) => a.filter((v, i) => v !== b[i]).length
  await expect
    .poll(async () => differ(await sample(page, split.open), on.slice(0, split.open.length)), {
      timeout: 15000,
    })
    .toBeGreaterThan(split.open.length * 0.9)
  const off = await sample(page, all)
  expect(
    differ(off.slice(split.open.length), on.slice(split.open.length)),
    'layer 1 covers the flames: the pixels under it do not change',
  ).toBe(0)
})
