/**
 * Hidden sprites are found by running their code and drawn whole in the screen door (#1132, acceptance 1 and 8).
 *
 * Two layers. The node reply (`mapSprites`) says what is drawn and why; the map view's composite canvas, read here
 * pixel by pixel, says what is on screen. A reply that carries `screenDoor` while the view paints the sprite solid
 * passes the first and fails the second, which is the defect this spec exists to catch.
 * - Map $105 (acceptance 1): the invisible mushroom ($C7) is drawn, not a marker, with a hover line from the
 *   condition ("Mario gets close to this spot", not an id). On the composite its pixels are the sprite's own colour on
 *   at most half of them (the door's full squares) and tinted on the rest; a placed mushroom ($74) on the same map is
 *   the control and is solid on at least 90% of its pixels. $C7 and $74 have the same shape.
 * - Maps $106 and $010 (acceptance 8): every Monty Mole ($4D) is drawn in the door, including $106 columns 235 and 247
 *   and $010 column 201, all moles of one map share one bitmap, and each shows the door pattern on the composite.
 * Plants for the verifier (each must turn this red; restore after):
 * - src/rom/model/ColorMath.ts top(): remove the `a *= ... hiddenPixelStrength(...)` door line (the view paints the
 *   sprite solid): the on-screen assertions fail, the reply ones do not;
 * - theia/extension/src/node/map-sprites.ts: drop the `screenDoor` property from the DTO: every assertion on it fails;
 * - src/rom/sprites/interp/RevealSearch.ts DISTANCES: `[0x00, 0x100]` (whole distances only): the two moles that drew
 *   nothing from Mario's start are drawn again as markers or lose `screenDoor`;
 * - src/rom/sprites/interp/RevealSearch.ts: `return { status: 'visible' }` first: $C7 is a marker again.
 * Vanilla ROM, one machine; skipped without the ROM.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const INVISIBLE_MUSHROOM = 0xc7
const MUSHROOM = 0x74
const MONTY_MOLE = 0x4d
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hidden-sprites-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
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

const opaque = s => {
  const rgba = Buffer.from(s.rgba, 'base64')
  let n = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) n++
  return n
}
/** The sprite's opaque pixels as a string of 0 and 1, row by row: its shape, whatever its colours. */
const shape = s => {
  const rgba = Buffer.from(s.rgba, 'base64')
  let out = `${s.box.x1 - s.box.x0}x${s.box.y1 - s.box.y0}:`
  for (let i = 3; i < rgba.length; i += 4) out += rgba[i] !== 0 ? '1' : '0'
  return out
}

/** Opens the project on the ROM and the map view on `index`; returns the served sprites. */
async function openMap(page, index) {
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, `MyHack${index}`) },
  )
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: project.manifestPath, index },
  )
  expect(reply.status).toBe('ok')
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index },
  )
  opened.push(`hackbench.map-view:${index}`)
  return reply.sprites
}

/**
 * What the map view's composite canvases hold under the sprite's opaque pixels: how many equal the sprite's own colour
 * (within 2 per channel, alpha 255), how many are opaque and differ, and how many opaque pixels there are. Screens run
 * left to right on a horizontal map and top to bottom on a vertical one, read from where the canvases sit.
 */
function onScreen(page, index, s) {
  return page.evaluate(
    ({ root, s }) => {
      const screens = [...document.querySelectorAll(`${root} canvas[data-layer="screen"]`)]
      const [cw, ch] = [screens[0].width, screens[0].height]
      const r0 = screens[0].getBoundingClientRect()
      const r1 = screens[1]?.getBoundingClientRect()
      const horizontal = !r1 || r1.left > r0.left + 1
      const sprite = Uint8Array.from(atob(s.rgba), c => c.charCodeAt(0))
      const w = s.box.x1 - s.box.x0
      const read = new Map()
      const data = n => {
        if (!read.has(n)) read.set(n, screens[n].getContext('2d').getImageData(0, 0, cw, ch).data)
        return read.get(n)
      }
      let total = 0
      let same = 0
      let differs = 0
      for (let i = 0; i < sprite.length; i += 4) {
        if (sprite[i + 3] === 0) continue
        const [mx, my] = [s.box.x0 + ((i / 4) % w), s.box.y0 + Math.floor(i / 4 / w)]
        const n = Math.floor(horizontal ? mx / cw : my / ch)
        const [lx, ly] = horizontal ? [mx - n * cw, my] : [mx, my - n * ch]
        if (n < 0 || n >= screens.length || lx < 0 || lx >= cw || ly < 0 || ly >= ch) continue
        total++
        const px = data(n).subarray((ly * cw + lx) * 4, (ly * cw + lx) * 4 + 4)
        if (px[3] !== 255) continue
        if ([0, 1, 2].every(k => Math.abs(px[k] - sprite[i + k]) <= 2)) same++
        else differs++
      }
      return { total, same, differs }
    },
    { root: `[id="hackbench.map-view:${index}"]`, s },
  )
}

/** The on-screen counts once the sprite's screen has painted it (some pixel is its own colour). */
async function painted(page, index, s) {
  const root = `[id="hackbench.map-view:${index}"]`
  const screen = await page.evaluate(
    ({ root, x }) => {
      const screens = [...document.querySelectorAll(`${root} canvas[data-layer="screen"]`)]
      return Math.min(Math.floor(x / screens[0].width), screens.length - 1)
    },
    { root, x: s.box.x0 },
  )
  await page
    .locator(`${root} canvas[data-layer="screen"][data-screen="${screen}"]`)
    .evaluate(el => el.scrollIntoView({ inline: 'center', block: 'nearest' }))
  let got
  await expect
    .poll(async () => ((got = await onScreen(page, index, s)), got.same), { timeout: 30000 })
    .toBeGreaterThan(0)
  return got
}

test('map $105 draws the invisible mushroom in the screen door, on screen as well as in the reply', async ({
  page,
}) => {
  const all = await openMap(page, 0x105)
  const found = all.filter(s => s.id === INVISIBLE_MUSHROOM)
  expect(found.length, 'invisible mushrooms placed on $105').toBeGreaterThan(0)
  for (const s of found) {
    expect(s.status, 'a picture, not the id marker').toBe('drawn')
    expect(s.screenDoor).toBe(true)
    expect(s.reveal).toContain('appears when Mario gets close to this spot')
    expect(s.reveal, 'the condition, never the id').not.toMatch(/c7|\$/i)
    expect(opaque(s), 'pixels to read').toBeGreaterThan(0)
    // Placed position (D142): the box covers the anchor's tile.
    expect(s.box.x0).toBeLessThanOrEqual(s.x + 16)
    expect(s.box.x1).toBeGreaterThanOrEqual(s.x)
    expect(s.box.y0).toBeLessThanOrEqual(s.y + 16)
    expect(s.box.y1).toBeGreaterThanOrEqual(s.y)

    // On screen: the door's full squares carry the sprite's colour, at most half the pixels; the rest are tinted.
    const door = await painted(page, 0x105, s)
    expect(door.total, 'the sprite lies on the map').toBeGreaterThan(0)
    expect(door.same, 'full squares: never more than half').toBeLessThanOrEqual(door.total / 2)
    expect(door.differs, 'dim squares: the rest are tinted').toBeGreaterThanOrEqual(door.total / 2 - 1) // prettier-ignore
  }

  // Control, acceptance 1: a placed mushroom ($74) is solid, and $C7 is the same picture.
  const placed = all.find(s => s.id === MUSHROOM && s.status === 'drawn')
  expect(placed, 'a drawn $74 on $105').toBeTruthy()
  expect(placed.screenDoor, 'a placed sprite is not in the door').toBeFalsy()
  const solid = await painted(page, 0x105, placed)
  expect(solid.same, 'a placed mushroom is solid on the composite').toBeGreaterThanOrEqual(solid.total * 0.9) // prettier-ignore
  for (const s of found) expect(shape(s), '$C7 draws the mushroom $74 draws').toBe(shape(placed))
})

for (const [index, columns] of [
  [0x106, [235, 247]],
  [0x010, [201]],
]) {
  test(`map $${index.toString(16).padStart(3, '0')} draws every Monty Mole alike, in the screen door on screen`, async ({
    page,
  }) => {
    const moles = (await openMap(page, index)).filter(s => s.id === MONTY_MOLE)
    expect(moles.length).toBeGreaterThan(0)
    for (const m of moles) {
      expect(m.status).toBe('drawn')
      expect(m.screenDoor).toBe(true)
      expect(opaque(m)).toBeGreaterThan(0)
    }
    for (const col of columns) {
      const at = moles.filter(m => m.x === col * 16)
      expect(at.length, `a mole at column ${col}`).toBeGreaterThan(0)
      for (const m of at) expect(m.status).toBe('drawn')
    }
    // Wherever it sits and wherever Mario starts, the picture is the same one.
    expect(new Set(moles.map(m => m.rgba)).size, 'one picture for every mole').toBe(1)
    // And every one of them shows the door on screen: full squares on at most half its pixels.
    for (const m of moles) {
      const door = await painted(page, index, m)
      expect(door.same, `mole #${m.index}: the door's full squares only`).toBeLessThanOrEqual(door.total / 2) // prettier-ignore
      expect(door.differs, `mole #${m.index}: the dim squares are tinted`).toBeGreaterThan(0)
    }
  })
}
