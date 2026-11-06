/**
 * The rope ($64) is drawn at the length the game gives it (#1230, D152): the ROM's own draw run in the slot the level
 * loader would pick. Map $00F is sprite memory setting 1, where an odd 16 px column is long (9 tiles) and an even one
 * short (5). A tile is four 8x8 parts in the DTO. Vanilla ROM; skipped, never faked, without it.
 * - Odd columns 205 and 241 draw 9 tiles; even columns 164, 186, 210, 216 draw 5 (the Mesen capture, 4 of 4 runs).
 * - A project on an edited copy of the BASE ROM whose rope stands one column further right draws the other length (no
 *   sprite-move op exists on the node side; RopeEdits.corpus.test.ts moves it in the working-copy bytes instead).
 * - A project on a copy whose loader is edited keeps every rope at 5 tiles and the DTO says why.
 * The stream is located from the vanilla tables ($05EC00 pointers into bank $07, 3-byte entries after the header
 * byte): a vanilla-only assumption of this spec. Written, not run, by the implementer; the verifier runs it.
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

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-rope-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }))

const lo = a => ((a >> 16) & 0xff) * 0x8000 + (a & 0x7fff)
/** File offsets of the rope entries of map `index`: [{ at, column }], column = screen * 16 + X nibble. */
function ropeEntries(bytes, index) {
  const t = lo(0x05ec00) + index * 2
  const stream = lo(0x070000 | (bytes[t] | (bytes[t + 1] << 8)))
  const out = []
  for (let at = stream + 1; bytes[at] !== 0xff; at += 3)
    if (bytes[at + 2] === 0x64)
      out.push({ at: at + 1, column: (bytes[at + 1] & 0x0f) * 16 + (bytes[at + 1] >> 4) })
  return out
}

async function ropeTiles(page, romFile, name) {
  const project = await page.evaluate(
    ({ romPath, directory, name }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
    { romPath: romFile, directory: path.join(tmp, name), name },
  )
  const reply = await page.evaluate(
    ({ mp }) => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x0f),
    { mp: project.manifestPath },
  )
  expect(reply.status).toBe('ok')
  return reply.sprites
    .filter(s => s.id === 0x64)
    .map(s => ({
      column: (s.stored ?? s).x / 16,
      tiles: s.parts.length / 4,
      unverified: s.unverified,
    }))
}

test('map $00F: odd columns draw 9 tiles, even columns 5', async ({ page }) => {
  const got = Object.fromEntries(
    (await ropeTiles(page, ROM, 'Plain')).map(r => [r.column, r.tiles]),
  )
  for (const c of [205, 241]) expect(got[c], `column ${c}`).toBe(9)
  for (const c of [164, 186, 210, 216]) expect(got[c], `column ${c}`).toBe(5)
})

test('a rope moved one column right draws the other length', async ({ page }) => {
  const bytes = new Uint8Array(fs.readFileSync(ROM))
  const first = ropeEntries(bytes, 0x0f).find(e => (e.column & 15) < 15)
  const before = first.column
  bytes[first.at] += 0x10
  const edited = path.join(tmp, 'moved.sfc')
  fs.writeFileSync(edited, bytes)
  const got = Object.fromEntries(
    (await ropeTiles(page, edited, 'Moved')).map(r => [r.column, r.tiles]),
  )
  expect(got[before], `old column ${before} is gone`).toBeUndefined()
  expect(got[before + 1]).toBe((before + 1) % 2 === 1 ? 9 : 5)
})

test('an edited sprite loader keeps every rope at 5 tiles and says why', async ({ page }) => {
  const bytes = new Uint8Array(fs.readFileSync(ROM))
  bytes[lo(0x02a8e4) + 3] ^= 1
  const edited = path.join(tmp, 'loader.sfc')
  fs.writeFileSync(edited, bytes)
  const ropes = await ropeTiles(page, edited, 'Loader')
  expect(ropes.length).toBeGreaterThan(0)
  for (const r of ropes) {
    expect(r.tiles, `column ${r.column}`).toBe(5)
    expect(r.unverified).toMatch(/loader.*not the original/)
  }
})
