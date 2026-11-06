/**
 * The rope ($64) at the length the game gives it (#1230, D152). Map $00F is sprite memory setting 1: odd columns 9 tiles,
 * even 5 (the Mesen capture, 4 of 4 runs); a tile is four 8x8 parts in the DTO. Vanilla ROM; skipped without it.
 * A rope moved one column in an edited copy of the BASE ROM (no sprite-move op exists on the node side; the unit tests move
 * it in the working-copy bytes) draws the other length; an edited loader keeps 5 tiles and the DTO says why. The stream
 * is found from the vanilla tables ($05EC00 into bank $07): vanilla-only.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')

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
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
  await page.waitForFunction(() => window.theia?.container && getSvc('Symbol(ProjectService)'))
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
      mp: project.manifestPath,
      box: s.box,
      column: (s.stored ?? s).x / 16,
      tiles: s.parts.length / 4,
      unverified: s.unverified,
      door: Buffer.from(s.priority, 'base64').filter(b => b & 4).length, // pixels of the extra length drawn in the screen door
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

/** The rope's own rows of map $0F read off the canvases: [pixels, pixels the composed picture draws as the sprite plane has them], solid tiles then door rows. */
async function composedRows(page, rope) {
  const root = '[id="hackbench.map-view:15"]'
  const open = async ({ mp }) => {
    const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: 15 })
    await w.open({ manifestPath: mp, index: 15, label: 'f', iconClass: '' })
    await getSvc('ApplicationShell').addWidget(w, { area: 'main' })
    await getSvc('ApplicationShell').activateWidget(w.id)
  }
  await page.evaluate(open, { mp: rope.mp })
  const screen = Math.floor(rope.box.x0 / 256)
  const plane = `${root} canvas[data-screen="${screen}"][data-plane="sprites"]`
  await page.locator(plane).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' })) // prettier-ignore
  await expect(page.locator(plane)).toHaveAttribute('data-drawn', /^\d+:\d+$/, { timeout: 30000 })
  const rows = await page.evaluate(({ plane, root, screen, box }) => {
    const [x, y, w, h] = [box.x0 - screen * 256, box.y0, box.x1 - box.x0, box.y1 - box.y0]
    const sp = document.querySelector(plane).getContext('2d').getImageData(x, y, w, h).data
    const comp = composeCanvases(planesOf(root, screen), x, y, w, h)
    const out = { solid: [0, 0], door: [0, 0] }
    for (let i = 0; i < w * h; i++) {
      if (sp[i * 4 + 3] !== 255) continue
      const part = Math.floor(i / w) < 80 ? out.solid : out.door
      part[0]++
      if ([0, 1, 2, 3].every(k => sp[i * 4 + k] === comp[i * 4 + k])) part[1]++
    }
    return out
  }, { plane, root, screen, box: rope.box }) // prettier-ignore
  await page.evaluate(() => getSvc('ApplicationShell').closeWidget('hackbench.map-view:15'))
  return rows
}

test('a rope on a free-slot setting draws its extra length in the screen door, and on setting 1 the same 9 tiles are solid', async ({
  page,
}) => {
  const bytes = new Uint8Array(fs.readFileSync(ROM))
  const t = lo(0x05ec00) + 0x0f * 2
  const stream = lo(0x070000 | (bytes[t] | (bytes[t + 1] << 8)))
  bytes[stream] = (bytes[stream] & 0xc0) | 2 // setting 2: the top sprite slots are shared with ordinary sprites
  const edited = path.join(tmp, 'setting2.sfc')
  fs.writeFileSync(edited, bytes)
  const at = async (rom, name) => (await ropeTiles(page, rom, name)).find(r => r.column === 205)
  const [door, solid] = [await at(edited, 'Door'), await at(ROM, 'Solid')]
  expect([door.tiles, solid.tiles]).toEqual([9, 9])
  // Composed picture at the rope's rows: the 5 solid tiles are the sprite plane as it is; below them the door tints about
  // half the pixels (on setting 1 the same rows are untouched).
  const [d, s] = [await composedRows(page, door), await composedRows(page, solid)]
  const same = ([total, n]) => n / total
  expect([same(d.solid) > 0.9, same(d.door) < 0.75, same(s.door) > 0.9, d.door[0] > 0]).toEqual([true, true, true, true]) // prettier-ignore
})
