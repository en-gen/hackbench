/**
 * A priority layer 1 tile draws in FRONT of a sprite that overlaps it, and a
 * non-priority one draws behind it (en-gen/hackbench#529). The draw order the map
 * tab composes is L2, L1 non-priority, sprites, L1 priority (ScreenPlanes puts
 * 'sprites' between l1Low and l1High); map-view.spec.cjs only pins the plane NAMES
 * and z-indexes, so a composite that painted the sprites last would still pass
 * there. This spec reads PIXELS of the composite canvas.
 *
 * The case, measured on the vanilla ROM (one ROM, one run of the sprite and
 * screen modules): slot $20, screen 11. Three drawn sprites, id $33, OAM
 * priority 2 (the documented order), each lie under Map16 tile $004, whose four
 * subtile priority bits are set in the vanilla table. Where an opaque sprite
 * pixel lies under an opaque l1High pixel there are 176 pixels (56 + 56 + 64, in
 * boxes x 80-95 / y 384-394, x 112-127 / y 384-394, x 176-191 / y 384-395 of the
 * screen). Part (b) clears the four priority bits through the Map16 service's own
 * write path (the working-copy edit the Map16 view uses), which moves the tile to
 * l1Low, and the same pixels must show the sprite.
 *
 * Plant for the verifier: in src/rom/model/ScreenPlanes.ts, the line in `on`
 * that returns `[...bg.slice(0, at), 'sprites', ...bg.slice(at)]`, changed to
 * `[...bg, 'sprites']` (sprites above l1High), must turn part (a) red.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
// A named skip, not a createProject throw, when the ROM is not on this machine (docs/testing.md).
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x20
const SCREEN = 11
const TILE = 4
const MIN_OVERLAP = 100 // measured 176; a floor, so a placement tweak does not turn this red

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-priority-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    const shell = getSvc('ApplicationShell')
    for (const id of ids) {
      try {
        await shell.closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const root = `[id="hackbench.map-view:${SLOT}"]`
const plane = p => `${root} canvas[data-screen="${SCREEN}"][data-plane="${p}"]`

/**
 * What the pixels at `at` (or, with none given, at every pixel where a sprite pixel and an l1High
 * pixel are both opaque) hold in the sprite plane, the l1High plane and the composite. Alpha 255
 * only is compared, so a readback's premultiplying cannot matter.
 */
function probe(page, at) {
  return page.evaluate(
    ({ rootSel, sel, at }) => {
      const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const q = s => document.querySelector(s)
      const sprites = px(q(sel.sprites))
      const high = px(q(sel.high))
      const comp = px(planesOf(rootSel, sel.screen)[0])
      const pixels = at ?? [...Array(sprites.length / 4).keys()].filter(p => sprites[p * 4 + 3] === 255 && high[p * 4 + 3] === 255) // prettier-ignore
      const same = (a, b, p) => [0, 1, 2, 3].every(k => a[p * 4 + k] === b[p * 4 + k])
      return {
        pixels,
        spriteOpaque: pixels.filter(p => sprites[p * 4 + 3] === 255).length,
        highOpaque: pixels.filter(p => high[p * 4 + 3] === 255).length,
        compIsHigh: pixels.filter(p => same(comp, high, p)).length,
        compIsSprite: pixels.filter(p => same(comp, sprites, p)).length,
        highDiffersFromSprite: pixels.filter(p => !same(high, sprites, p)).length,
      }
    },
    {
      rootSel: root,
      sel: { sprites: plane('sprites'), high: plane('l1High'), screen: SCREEN },
      at,
    },
  )
}

test('an L1 priority tile draws over an overlapping sprite; with priority cleared the sprite is on top', async ({
  page,
}) => {
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index: SLOT },
  )
  opened.push(`hackbench.map-view:${SLOT}`)
  await page.locator(plane('l1Low')).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' })) // prettier-ignore
  await expect(page.locator(plane('l1Low'))).toHaveAttribute('data-drawn', /^\d+:0000:000:11$/, { timeout: 30000 }) // prettier-ignore
  await expect(page.locator(plane('sprites'))).toHaveAttribute('data-drawn', /^\d+:\d+$/, { timeout: 30000 }) // prettier-ignore

  // (a) Priority set: every overlap pixel shows the l1High pixel, which is not the sprite's.
  const before = await probe(page)
  const n = before.pixels.length
  expect(n, 'sprites sit under l1High pixels here').toBeGreaterThanOrEqual(MIN_OVERLAP)
  expect(before.highDiffersFromSprite, 'the two sources differ at the overlap, or this proves nothing').toBe(n) // prettier-ignore
  expect(before.compIsHigh, 'the composite shows l1High over the sprite').toBe(n)
  expect(before.compIsSprite).toBe(0)

  // (b) The same pixels with the tile's four priority bits cleared in the working copy.
  for (const which of ['tl', 'tr', 'bl', 'br']) {
    const edit = await page.evaluate(
      ({ mp, which, tile }) =>
        getSvc('Symbol(Map16Service)').setQuadrantField(mp, 1, 'fg', { bg: 0, fg: 0 }, tile, which, 'priority', false), // prettier-ignore
      { mp: project.manifestPath, which, tile: TILE },
    )
    expect(edit.status).toBe('ok')
  }
  await expect
    .poll(async () => (await probe(page, before.pixels)).compIsSprite, { timeout: 15000 })
    .toBe(n)
  const after = await probe(page, before.pixels)
  expect(after.highOpaque, 'the tile left the priority plane').toBe(0)
  expect(after.spriteOpaque, 'the sprites did not move: still opaque at every pixel').toBe(n)
  expect(after.compIsSprite, 'with priority clear the sprite is drawn over the tile').toBe(n)
  expect(after.compIsHigh).toBe(0)
})
