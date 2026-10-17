/**
 * Sprite $DE draws five Wave Eeries from one placement, run from the ROM's own spawner (#1015).
 *
 * Map $021 (vanilla ROM) places $DE twice: list entry 4 at (944, 336) and entry 15 at (2464, 272). The Mesen capture
 * layers_v5/021 has one hardware record per placement (the Eerie that carries the list index, +$20 from the entry; the
 * other four have none, because Load5Eeries sets SpriteLoadIndex on its first spawn only, SMWDisX bank_02.asm:6305-6308).
 * The unit test test/suite/unit/sprites/FiveEeries.corpus.test.ts pins that Eerie to the capture to the pixel and tile
 * (x 968, y 346 eight frames after the spawn). The map view shows the spawn state with Mario at the level start, so Mario
 * is left of the entry and every Eerie moves left: each piece stands 2 px left of entry X + (-32, -16, 0, 16, 32).
 * Checked here from the RPC reply and the composite:
 * - two $DE sprites at their real stream indices 4 and 15, drawn (not a marker), unflagged, with their boxes pinned
 *   (910,333 to 990,354 and 2430,269 to 2510,290), so a uniform shift of the five goes red;
 * - each of the FIVE pieces holds an opaque pixel inside its own 16 px column (entry X + offset - 2), in the band of the
 *   data byte's Y (336 and 272, plus the wave: within 5 px), so a draw of one Eerie or a shifted spread goes red;
 * - the Eeries' colours show in the composite of screen 3, and the sprite toggle (S) takes them out.
 * - map $11D (four-slot range): four pieces, box 1550..1614, and the map's note line says "Only 4 of the 5 Eeries appear".
 * NOT covered: hovering or selecting the sprite (#981); $1E8 and $1E9, which share $11D's list and spawn four too, are covered
 * by the unit sweep in FiveEeries.corpus.test.ts.
 * Plants for the verifier (each must turn the spec red; restore after):
 * - map-sprites.ts `interpDrawer`: remove the `FIVE_EERIES` line: the marker returns;
 * - FiveEeries.ts: `nth: n` replaced by `nth: 0`: five copies of one Eerie, four columns empty.
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
let SLOT = 0x021
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-five-eeries-'))
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

/** Count of a sprite reply's opaque pixels inside a map-pixel rectangle. */
function opaqueIn(s, x0, y0, x1, y1) {
  const rgba = Buffer.from(s.rgba, 'base64')
  const w = s.box.x1 - s.box.x0
  let n = 0
  for (let y = Math.max(y0, s.box.y0); y < Math.min(y1, s.box.y1); y++)
    for (let x = Math.max(x0, s.box.x0); x < Math.min(x1, s.box.x1); x++)
      if (rgba[((y - s.box.y0) * w + (x - s.box.x0)) * 4 + 3]) n++
  return n
}

test('the $DE placements of map $021 are two drawn sprites of five Eeries each, in the composite, and follow the toggle', async ({
  page,
}) => {
  SLOT = 0x021
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const de = reply.sprites.filter(s => s.id === 0xde)
  expect(de.map(s => [s.index, s.x, s.y, s.status, s.unverified])).toEqual([
    [4, 944, 336, 'drawn', undefined],
    [15, 2464, 272, 'drawn', undefined],
  ])
  // The box is pinned, not only its width (the sweep table in docs/sprites/sprite-de-five-eeries.md): a uniform shift goes red.
  expect(de.map(s => [s.box.x0, s.box.y0, s.box.x1, s.box.y1])).toEqual([
    [910, 333, 990, 354],
    [2430, 269, 2510, 290],
  ])

  // Each piece: 16 px wide at entry X + offset - 2 (the Eeries move left from the spawn), inside the data byte's Y band.
  for (const s of de) {
    for (const off of [-32, -16, 0, 16, 32]) {
      const x = s.x + off - 2
      const n = opaqueIn(s, x, s.y - 5, x + 16, s.y + 5 + 16)
      expect(n, `entry ${s.index}: a piece at x ${x}`).toBeGreaterThan(0)
    }
  }

  // Entry 4 spans x 910..990: screen 3 (768..1023).
  await openMap(page, 3)
  const s = de[0]
  const rgba = Buffer.from(s.rgba, 'base64')
  const w = s.box.x1 - s.box.x0
  const open = []
  const want = []
  for (let i = 0; i < rgba.length; i += 4) {
    if (!rgba[i + 3]) continue
    const x = s.box.x0 + ((i / 4) % w) - 3 * 256
    const y = s.box.y0 + Math.floor(i / 4 / w)
    open.push(y * 256 + x)
    want.push(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},255`)
  }
  expect(open.length, 'opaque Eerie pixels on screen 3').toBeGreaterThan(0)
  // Overlap with another sprite or a layer in front can hide some; 0.9 is sampling slack, the verifier records the measured share.
  expect(share(await sample(page, open, 3), want), 'Eerie colours show').toBeGreaterThan(0.9)

  const toggle = page.locator(`${rootOf()} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // With sprites off those pixels show the background; matching an Eerie colour only by chance, so 0.5 is a loose ceiling.
  await expect
    .poll(async () => share(await sample(page, open, 3), want), { timeout: 15000 })
    .toBeLessThan(0.5)
})

test('map $11D spawns four Eeries (its sprite memory setting has room for four): four pieces draw and the map says so in words', async ({
  page,
}) => {
  SLOT = 0x11d
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const de = reply.sprites.filter(s => s.id === 0xde)
  expect(de.map(s => [s.index, s.x, s.y, s.status, s.unverified])).toEqual([
    [16, 1568, 208, 'drawn', undefined],
  ])
  // Four pieces, 64 px wide, as the sweep table says; the -32 Eerie never exists, so nothing stands in its column.
  expect([de[0].box.x0, de[0].box.y0, de[0].box.x1, de[0].box.y1]).toEqual([1550, 205, 1614, 226])
  for (const off of [-16, 0, 16, 32]) {
    const x = de[0].x + off - 2
    expect(opaqueIn(de[0], x, de[0].y - 5, x + 16, de[0].y + 5 + 16), `a piece at x ${x}`).toBeGreaterThan(0) // prettier-ignore
  }
  expect(reply.note).toContain('Only 4 of the 5 Eeries appear')

  // The note shows on the map's own note line (entry x 1568 is on screen 6).
  await openMap(page, 6)
  await expect(page.locator(`${rootOf()} [data-note="sprites"]`)).toContainText(
    'Only 4 of the 5 Eeries appear',
  )
})
