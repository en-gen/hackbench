/**
 * Hidden sprites are found by running their code and drawn whole in the screen door (#1132, acceptance 1 and 8).
 *
 * Checked from the node reply (`mapSprites`), which is what the view draws from: the screen door itself is the
 * view model's `spriteLayer` (unit tested in MapSpritesReveal.test.ts, alpha on alternating squares).
 * - Map $105: the invisible mushroom ($C7) is drawn, not a marker, with `screenDoor` set, a hover line from the
 *   condition ("Mario gets close to this spot", not an id), and opaque pixels where it is placed.
 * - Maps $106 and $010: every Monty Mole ($4D) is drawn with `screenDoor`, including $106 column 235, $010 column 201
 *   and $106 column 247, and all the moles of one map draw the same bitmap whatever their position.
 * Plants for the verifier (each must turn this red; restore after):
 * - src/rom/sprites/interp/RevealSearch.ts DISTANCES: `[0x00, 0x100]` (whole distances only): the two moles that drew
 *   nothing from Mario's start are drawn again as markers or lose `screenDoor`;
 * - theia/extension/src/node/map-sprites.ts: drop the `screenDoor` property from the DTO: every assertion on it fails;
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

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hidden-sprites-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const opaque = s => {
  const rgba = Buffer.from(s.rgba, 'base64')
  let n = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) n++
  return n
}

async function spritesOf(page, index) {
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
  return reply.sprites
}

test('map $105 draws the invisible mushroom in the screen door, with the condition in its hover', async ({
  page,
}) => {
  const all = await spritesOf(page, 0x105)
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
  }
})

for (const [index, columns] of [
  [0x106, [235, 247]],
  [0x010, [201]],
]) {
  test(`map $${index.toString(16).padStart(3, '0')} draws every Monty Mole alike, in the screen door`, async ({
    page,
  }) => {
    const moles = (await spritesOf(page, index)).filter(s => s.id === MONTY_MOLE)
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
  })
}
