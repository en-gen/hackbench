/**
 * The Magikoopa ($1F) on map $11C is drawn in the blue the game leaves in CGRAM once its teleport fade has
 * finished, not in the level's pink row 15 (#1097). Vanilla ROM, one machine.
 *
 * Checked from the RPC reply, as map-podoboo-gfx does: the sprite is a 24 x 32 bitmap; five pixels at known offsets
 * must equal the colors of the fade's last rung. The rung is read from the ROM under test at run time (the `CMP #imm`
 * that ends the fade at $01:C01C, SMWDisX bank_01.asm:8726, gives imm - 2; the table address is the operand of the
 * `LDA.L MagiKoopaPals,X` at $01:C036, bank_01.asm:8743, 8 colors per entry), so no color value is written in this
 * file. Each offset sits on a different palette column (3-7), and those columns differ between every pair of rungs
 * in the vanilla table, so a sprite on the wrong rung or on the level row fails. The offsets name the pose the map
 * draws (the casting pose it draws on leaving state 0); a change of pose is a change to this spec.
 * Hardware reference: layers_v5/11c windows/screen_00 CGRAM row 15 columns 0-7 equal this rung
 * (MapSpritesMagikoopaPalette.corpus.test.ts checks every pixel is one of those colors).
 * Plants for the verifier (each must turn this red; restore after):
 * - theia/extension/src/node/map-sprites.ts `runtimeColors`: `netColors(m, m.chosen ?? 0)` for the end colors (the
 *   first drawn pass, no upload yet);
 * - same function: `netColors(m, last - 40)` (an earlier rung).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const { bgr555ToRgbTriplet } = require('./palette-color.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x11c
const WIDTH = 24
/** [x, y, palette column] inside the sprite's bitmap, one per column 3-7 the drawn pose uses. */
const SAMPLES = [
  [6, 1, 3],
  [4, 1, 4],
  [21, 16, 5],
  [7, 10, 6],
  [5, 12, 7],
]
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
let tmp

/** The finished fade's colors from the ROM under test: file offset of an SNES LoROM address, header skipped. */
function restingRung(rom) {
  const skip = rom.length % 1024 === 512 ? 512 : 0
  const file = snes => skip + (snes >> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
  const cmp = file(0x01c01c)
  if (rom[cmp] !== 0xc9)
    throw new Error('the fade-end CMP #imm is not where the vanilla ROM has it')
  const entry = rom[cmp + 1] - 2
  const op = file(0x01c036)
  if (rom[op] !== 0xbf)
    throw new Error('the MagiKoopaPals load is not where the vanilla ROM has it')
  const table = rom[op + 1] | (rom[op + 2] << 8) | (rom[op + 3] << 16)
  const base = file(table) + entry * 16
  return Array.from({ length: 8 }, (_, c) => rom[base + c * 2] | (rom[base + c * 2 + 1] << 8))
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-magikoopa-palette-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('map $11C draws the Magikoopa in the colors of its finished teleport fade', async ({
  page,
}) => {
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  const reply = await page.evaluate(
    ({ mp, index }) => getSvc('Symbol(ProjectService)').mapSprites(mp, index),
    { mp: project.manifestPath, index: SLOT },
  )
  expect(reply.status).toBe('ok')
  const koopas = reply.sprites.filter(s => s.id === 0x1f)
  expect(koopas, 'Magikoopas in the list').toHaveLength(1)
  expect(koopas[0].status).toBe('drawn')
  const rgba = Buffer.from(koopas[0].rgba, 'base64')
  const rung = restingRung(fs.readFileSync(ROM))
  for (const [x, y, col] of SAMPLES) {
    const o = (y * WIDTH + x) * 4
    expect(
      [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]],
      `pixel (${x}, ${y}), column ${col}`,
    ).toEqual([...bgr555ToRgbTriplet(rung[col]), 255])
  }
})
