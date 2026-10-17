/**
 * The Podoboo ($33) draws the chars its graphics routine points Mario's tile DMA at, not the map's SP1 chars (#980).
 *
 * Map $11C (vanilla ROM, one machine, one run): 7 Podoboos in the sprite list. The node reply draws each as a
 * 16 x 16 bitmap with 184 opaque pixels. The same 184 is what the four hardware chars hold (slot 3 of both rows
 * of the layers_v5/11c VRAM samples, nonzero pixels; MarioGraphics.corpus.test.ts compares them per pixel).
 * The map's SP1 chars at those slots are other art, so a draw from SP1 has a different count or a note.
 * Checked from the RPC reply: every Podoboo is drawn, none carries an `unverified` note (the vanilla buffer is
 * read), each has exactly 184 opaque pixels, and the 7 bitmaps are identical (one frame, one palette).
 * Plants for the verifier (each must turn this red; restore after):
 * - theia/extension/src/node/map-sprites.ts `drawSprites`: `upload = undefined` after the charsFromUploads call
 *   (SP1 chars drawn): the opaque count leaves 184;
 * - src/rom/MarioGraphics.ts `charsFromUploads`: `slotChars(slot + 1)`: the chars land on the wrong cells, the count
 *   or the identical-bitmaps assertion goes red;
 * - theia/extension/src/node/map-sprites.ts `drawSprites`: `upload?.get(p.charNum ^ 1)` (each char swapped for its
 *   twin, which has the same shape and the colors of index 4 and 6 exchanged): the opaque count stays 184, only the
 *   color-sharing counts below move (56 and 82 swap), so they are what makes this plant red.
 * The counts 56 / 82 were measured from the same node reply (vanilla ROM, one machine, one run) and agree with the
 * per-pixel comparison against the hardware chars and the map palette in MarioGraphics.corpus.test.ts (12 maps, 72 Podoboos).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x11c
const OPAQUE = 184
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-podoboo-gfx-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('map $11C draws each Podoboo from the player buffer: 184 opaque pixels, no note, identical bitmaps', async ({
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
  const pods = reply.sprites.filter(s => s.id === 0x33)
  expect(pods.length, 'Podoboos in the list').toBe(7)
  const opaque = s => {
    const rgba = Buffer.from(s.rgba, 'base64')
    let n = 0
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) n++
    return n
  }
  for (const p of pods) {
    expect(p.status).toBe('drawn')
    expect(p.unverified, 'a vanilla ROM reads the buffer, so no note').toBeUndefined()
    expect(opaque(p)).toBe(OPAQUE)
  }
  expect(new Set(pods.map(p => p.rgba)).size, 'one frame, one picture').toBe(1)
  // Pixels sharing the color of the outer top pixel (5, 0) and of the inner pixel (5, 2) of the 16 x 16 bitmap.
  const rgba = Buffer.from(pods[0].rgba, 'base64')
  const at = (x, y) => rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4).toString('hex')
  const sharing = (x, y) => {
    let n = 0
    for (let i = 0; i < 256; i++)
      if (rgba.subarray(i * 4, i * 4 + 4).toString('hex') === at(x, y)) n++
    return n
  }
  expect(at(5, 0)).not.toBe(at(5, 2))
  expect([sharing(5, 0), sharing(5, 2)], 'the outer and inner colors of the face').toEqual([56, 82])
})
