/**
 * Sprite $9C (the flying platform) draws the Hammer Bro it carries (#841).
 *
 * Map $006 (vanilla ROM): $9C at 1168,272 and its $9B at the same spot (list entries 10 and 11). The game's
 * platform code scans slots 0-9 for a $9B and draws it 16 px above itself (SMWDisX bank_02.asm:12118-12148,
 * HammerBroGfx 12044-12091: tiles at dy -24 to -8 from the bro, so rows y-24..y-17 are bro-only; the
 * platform's wings reach only y-10). The Mesen capture layers_v5/006 has 8 OAM entries for this sprite, the
 * bro's four at dy -16 and -24 (one machine). Checked from the node reply (mapSprites):
 * - the $9C bitmap reaches 24 px above its anchor and has opaque pixels in the bro-only rows;
 * - the $9B entry is still a placeholder marker (D52: a placed sprite never draws as nothing);
 * - the same for the $9C at 2176,272.
 * Plant for the verifier: in `runOnce` (SpriteRunner.ts) return `a` before the neighbour run; the first
 * assertion goes red (box top at y-10, no bro rows).
 * NOT covered here: the exact tiles (the unit tests and spriteGrade.captures.test.ts grade them).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hammer-bro-platform-'))
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

/** Opaque pixels of `s` in the rows y0 <= y < y1 (map pixels). */
function opaqueRows(s, y0, y1) {
  const rgba = Buffer.from(s.rgba, 'base64')
  const w = s.box.x1 - s.box.x0
  let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const y = s.box.y0 + Math.floor(i / 4 / w)
    if (rgba[i + 3] !== 0 && y >= y0 && y < y1) n++
  }
  return n
}

test('each $9C on map $006 draws the Hammer Bro above its platform, and its $9B stays a marker', async ({
  page,
}) => {
  const reply = await page.evaluate(
    ({ mp }) => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x6),
    { mp: manifestPath },
  )
  expect(reply.status).toBe('ok')
  for (const [platformIndex, broIndex, x] of [
    [10, 11, 1168],
    [21, 22, 2176],
  ]) {
    const platform = reply.sprites.find(s => s.index === platformIndex)
    expect(platform.id).toBe(0x9c)
    expect(platform.status).toBe('drawn')
    expect([platform.x, platform.y]).toEqual([x, 272])
    // The bro's top tiles sit at dy -24; the platform's own parts reach no higher than dy -10.
    expect(platform.box.y0).toBe(272 - 24)
    expect(opaqueRows(platform, 272 - 24, 272 - 16)).toBeGreaterThan(0)
    const bro = reply.sprites.find(s => s.index === broIndex)
    expect(bro.id).toBe(0x9b)
    expect(bro.status).toBe('placeholder')
  }
})
