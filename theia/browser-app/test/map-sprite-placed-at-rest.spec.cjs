/**
 * The map view draws each sprite at rest (#980): its start-up code (INIT) runs for the picture only (D139 D,
 * D138 A), and the drawing stays at the placed (list) position (D134, D91), so INIT's moves wait for
 * play/simulate. Except the chainsaws and grinders ($65-$68), which are drawn where their own INIT leaves them
 * (R16 / D85 B); their list position is the DTO's `stored`. Vanilla ROM; skipped, never faked, without it.
 *
 * The sprite list is not served over the RPC, so the placed position is read as the list's own grid: a list
 * entry is a map tile (x and y multiples of 16), while the INIT-on anchor is off it (a chainsaw or grinder
 * is moved 15 px right and 320 px left or so by InitLineGuidedSpr, bank_01.asm:11788-11799). The exact
 * list coordinates are pinned below and in test/suite/unit/sprites/PlacedAtRest.test.ts.
 * - Map $00F: every chainsaw ($65) is drawn and on the tile grid.
 * - Map $01A: every grinder ($67) is drawn and on the tile grid (INIT's X move takes them off the screen
 *   the sprite is run on, so the picture is taken again with the camera moved).
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

// The stored (list) position: a chainsaw or grinder is drawn where its setup code leaves it (R16), so its DTO carries the
// list position as `stored`; every other sprite is drawn on it.
const listPos = s => s.stored ?? s
const offGrid = s => `#${s.index} at ${listPos(s).x},${listPos(s).y}`
const at = list => list.map(([i, x, y]) => `#${i} at ${x},${y}`)
const placedOf = found => found.map(offGrid).sort()

// The parsed list's own placement ([list index, x, y] in map pixels), read with the unit test's pipeline
// (test/suite/unit/sprites/PlacedAtRest.test.ts: parseLevelSprites, x and y times 16). A sprite shifted by
// exactly one tile still sits on the grid, so the grid check alone would not see it; this does.
const CHAINSAWS_00F = [
  [2, 464, 384],
  [4, 656, 336],
  [5, 944, 400],
  [6, 1088, 352],
  [7, 1104, 272],
  [8, 1232, 400],
  [9, 1248, 288],
  [10, 1296, 256],
  [11, 1360, 400],
  [12, 1376, 400],
  [13, 1616, 256],
  [14, 1696, 352],
  [15, 1872, 240],
  [16, 1936, 240],
  [17, 1984, 400],
  [18, 2000, 256],
  [19, 2080, 304],
  [20, 2096, 400],
  [21, 2144, 384],
  [22, 2160, 304],
  [23, 2192, 256],
  [24, 2288, 256],
  [32, 3984, 304],
  [33, 4080, 352],
  [34, 4176, 304],
  [35, 4240, 400],
  [36, 4336, 320],
  [37, 4432, 368],
  [38, 4528, 320],
  [39, 4528, 416],
]

const GRINDERS_01A = [
  [4, 720, 352],
  [5, 832, 352],
  [6, 912, 352],
  [7, 1024, 352],
  [10, 1216, 352],
  [11, 1360, 304],
  [12, 1488, 320],
  [13, 1712, 336],
  [14, 1840, 320],
  [15, 1904, 368],
  [16, 2064, 256],
  [17, 2160, 272],
  [18, 2224, 288],
]

test('map $00F: every chainsaw is stored on its placed tile and drawn where its setup code leaves it', async ({
  page,
}) => {
  const saws = await spritesOf(page, 0x00f, 0x65)
  expect(saws.filter(s => s.status !== 'drawn').map(offGrid)).toEqual([])
  expect(saws.filter(s => listPos(s).x % 16 !== 0 || listPos(s).y % 16 !== 0).map(offGrid)).toEqual([]) // prettier-ignore
  expect(placedOf(saws)).toEqual(at(CHAINSAWS_00F).sort())
  // ... and drawn where INIT leaves them: 320 px left of an even column, 15 px right of an odd one (R16).
  expect(saws.filter(s => s.x - s.stored.x !== (s.stored.x & 0x10 ? 15 : -320)).map(offGrid)).toEqual([]) // prettier-ignore
})

test('map $01A: every grinder is stored on its placed tile and drawn where its setup code leaves it', async ({
  page,
}) => {
  const grinders = await spritesOf(page, 0x01a, 0x67)
  expect(grinders.filter(s => s.status !== 'drawn').map(offGrid)).toEqual([])
  expect(grinders.filter(s => listPos(s).x % 16 !== 0 || listPos(s).y % 16 !== 0).map(offGrid)).toEqual([]) // prettier-ignore
  expect(placedOf(grinders)).toEqual(at(GRINDERS_01A).sort())
  expect(grinders.filter(s => s.x - s.stored.x !== (s.stored.x & 0x10 ? 15 : -320)).map(offGrid)).toEqual([]) // prettier-ignore
})

test('map $106: the P-switch draws its picture at its placed spot', async ({ page }) => {
  const [pswitch] = await spritesOf(page, 0x106, 0x3e)
  expect(pswitch).toMatchObject({ status: 'drawn', x: 4512, y: 272 })
  expect(pswitch.box).toEqual({ x0: 4512, y0: 272, x1: 4528, y1: 288 })
})
