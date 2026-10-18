/**
 * The map view draws each sprite at rest (#980): its start-up code (INIT) runs for the picture only (D139 D,
 * D138 A), and the drawing stays at the placed (list) position (D134, D91), so INIT's moves wait for
 * play/simulate. Vanilla ROM; skipped, never faked, without it.
 *
 * The sprite list is not served over the RPC, so the placed position is read as the list's own grid: a list
 * entry is a map tile (x and y multiples of 16), while the INIT-on anchor is off it (a chainsaw or grinder
 * is moved 15 px right and 320 px left or so by InitLineGuidedSpr, bank_01.asm:11788-11799). The exact
 * list coordinates are pinned against the parsed list in test/suite/unit/sprites/PlacedAtRest.test.ts.
 * - Map $00F: every chainsaw ($65) is on the tile grid; 23 draw, 7 show the not-drawn marker (D52).
 * - Map $01A: every grinder ($67) is on the tile grid; 10 draw, 3 show the marker (INIT's X move takes
 *   them off the screen the sprite is run on, so they put no tile in OAM).
 * - Map $106: the P-switch ($3E) draws its picture (INIT's look) at its placed spot.
 * Goes red on develop (INIT-on): the chainsaw and grinder anchors are off the grid.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-placed-at-rest-'))
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

async function spritesOf(page, index, id) {
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: manifestPath, index },
  )
  expect(reply.status).toBe('ok')
  const found = reply.sprites.filter(s => s.id === id)
  expect(found.length, `sprites $${id.toString(16)} on map $${index.toString(16)}`).toBeGreaterThan(
    0,
  )
  return found
}

const offGrid = s => `#${s.index} at ${s.x},${s.y}`

test('map $00F: every chainsaw sits at its placed tile, not moved by its setup code', async ({
  page,
}) => {
  const saws = await spritesOf(page, 0x00f, 0x65)
  expect(saws.filter(s => s.status === 'drawn')).toHaveLength(23)
  const markers = saws.filter(s => s.status === 'placeholder')
  expect(markers).toHaveLength(7)
  for (const m of markers) expect(m.reason).toMatch(/drew no OAM tile/)
  expect(saws.filter(s => s.x % 16 !== 0 || s.y % 16 !== 0).map(offGrid)).toEqual([])
})

test('map $01A: every grinder sits at its placed tile, not moved by its setup code', async ({
  page,
}) => {
  const grinders = await spritesOf(page, 0x01a, 0x67)
  expect(grinders.filter(s => s.status === 'drawn')).toHaveLength(10)
  const markers = grinders.filter(s => s.status === 'placeholder')
  expect(markers).toHaveLength(3)
  for (const m of markers) expect(m.reason).toMatch(/drew no OAM tile/)
  expect(grinders.filter(s => s.x % 16 !== 0 || s.y % 16 !== 0).map(offGrid)).toEqual([])
})

test('map $106: the P-switch draws its picture at its placed spot', async ({ page }) => {
  const [pswitch] = await spritesOf(page, 0x106, 0x3e)
  expect(pswitch).toMatchObject({ status: 'drawn', x: 4512, y: 272 })
  expect(pswitch.box).toEqual({ x0: 4512, y0: 272, x1: 4528, y1: 288 })
})
