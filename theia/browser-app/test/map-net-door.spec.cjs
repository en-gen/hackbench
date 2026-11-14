/**
 * The climbing net door ($54) on map $101 (#1002). The game draws nothing for it at rest: its routine returns before the
 * flip panel unless a punch-armed timer runs (SMWDisX bank_01.asm:8026-8057). So the map view shows the quiet marker at
 * each placed spot, never the failure box, and none of it lands on the castle flames ($E6) that fill the same rows.
 *
 * Vanilla ROM only; the whole file skips without it (the synthetic case is test/suite/unit/TimerGatedSprite.test.ts).
 * Placements measured on the vanilla ROM 2026-11-13: (1280,272), (1536,304), (1696,304).
 *
 * Planted defects for the verifier (each turns the named case red):
 *   N1 map-sprites.ts `render`: drop the empty-run quiet verdict (never return quiet): case 1 (reply) and case 2 (ring and dot pixels); not case 3 (flames).
 *   N2 map-sprites.ts `ring()`: fill the interior (return an opaque 16 x 16): the interior pixel case.
 *   N3 map-sprites.ts `quiet(...)`: offset x by 1: the reply case (placed spot).
 *   N4 map-sprites.ts `quiet(...)`: return a box 16 px larger at x1 and y1 than the placed spot: case 1 (the 16 x 16 box assertion) and case 2 (ring and dot pixels).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
const SLOT = 0x101
const PLACED = [
  [1280, 272],
  [1536, 304],
  [1696, 304],
]
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`

test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

let tmp
let mp
test.beforeEach(async ({ page }) => {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-net-door-'))
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  mp = project.manifestPath
  await page.evaluate(
    async ({ mp, slot }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', {
        index: slot,
      })
      await w.open({ manifestPath: mp, index: slot, label: slot.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp, slot: SLOT },
  )
  await page.locator(`${rootOf(SLOT)} .hb-map-view-strip`).waitFor({ timeout: 30000 })
  await page.locator(`${rootOf(SLOT)} [data-control="zoom-actual"]`).click()
})
test.afterEach(async ({ page }) => {
  await page.evaluate(
    id =>
      getSvc('ApplicationShell')
        .closeWidget(id)
        .then(
          () => undefined,
          () => undefined,
        ), // not the widget: page.evaluate must serialize the result
    'hackbench.map-view:' + SLOT,
  )
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** The node service's sprite reply for map $101. */
const reply = page => page.evaluate(({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot), { mp, slot: SLOT }) // prettier-ignore

/** The page position of the map pixel (x, y), scrolling it to the middle of the view first; zoom is read from the strip. */
const locate = (page, mapW, mapH, x, y) =>
  page.evaluate(
    ({ edge, mapW, mapH, x, y }) => {
      const el = document.querySelector(edge)
      const sc = el.closest('[data-control="map-scroller"]')
      const pos = () => {
        const r = el.getBoundingClientRect()
        return {
          x: r.left + (x * r.width) / mapW,
          y: r.top + (y * r.height) / mapH,
          z: r.width / mapW,
        }
      }
      const [first, view] = [pos(), sc.getBoundingClientRect()]
      sc.scrollBy(first.x - (view.left + view.width / 2), first.y - (view.top + view.height / 2))
      return pos()
    },
    { edge: `${rootOf(SLOT)} [data-control="map-edge"]`, mapW, mapH, x, y },
  )

/**
 * Screenshots of map-local clips [lx, ly, w, h] from the map pixel (x, y), with the sprite layer on and then off.
 * One scroll position for all clips: `locate` scrolls the pixel to the middle, so a second call would move the first.
 */
async function onOff(page, r, x, y, clips) {
  const origin = await locate(page, r.width * r.screenCount, r.height, x, y)
  // The scroll repaints the canvases over a few frames; the spec helpers offer no settled signal, so wait a fixed time.
  await page.waitForTimeout(1500)
  await page.mouse.move(0, 0)
  const shoot = () =>
    Promise.all(
      clips.map(([lx, ly, w, h]) =>
        page.screenshot({
          clip: {
            x: Math.round(origin.x + lx * origin.z),
            y: Math.round(origin.y + ly * origin.z),
            width: Math.round(w * origin.z),
            height: Math.round(h * origin.z),
          },
        }),
      ),
    )
  const toggle = page.locator(`${rootOf(SLOT)} [data-control="layer-sprites"]`)
  const on = await shoot()
  await toggle.click()
  await page.waitForTimeout(500) // the layer repaint
  const off = await shoot()
  await toggle.click()
  return { on, off }
}

test('the three doors are the quiet marker at their placed spots, 16 x 16, never the failure box', async ({
  page,
}) => {
  const r = await reply(page)
  expect(r.status).toBe('ok')
  const doors = r.sprites.filter(s => s.id === 0x54)
  expect(doors.map(d => [d.x, d.y])).toEqual(PLACED)
  for (const d of doors) {
    expect(d.status).toBe('quiet')
    expect(d.reason).toBe('unrevealed')
    expect(d.box).toEqual({ x0: d.x, y0: d.y, x1: d.x + 16, y1: d.y + 16 })
  }
})

test('at each door the ring and dot are drawn and the tile under the clear interior is untouched', async ({
  page,
}) => {
  const r = await reply(page)
  for (const [x, y] of PLACED) {
    // Local pixels: x 3..5, y 7..8 are inside the ring (clear); x 0..2, y 7..8 the ring and its edge; x 7..8, y 7..8 the dot.
    const clips = [[3, 7, 3, 2], [0, 7, 3, 2], [7, 7, 2, 2]] // prettier-ignore
    const { on, off } = await onOff(page, r, x, y, clips)
    expect(on[0].equals(off[0]), `interior at ${x},${y} is the bare tile`).toBe(true)
    expect(on[1].equals(off[1]), `ring at ${x},${y} is drawn`).toBe(false)
    expect(on[2].equals(off[2]), `dot at ${x},${y} is drawn`).toBe(false)
  }
})

test('the castle flames beside the doors are drawn, and no door box touches a flame box', async ({
  page,
}) => {
  const r = await reply(page)
  const flames = r.sprites.filter(s => s.id === 0xe6 && s.status === 'drawn')
  expect(flames.length).toBe(32)
  const touches = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
  const doors = r.sprites.filter(s => s.id === 0x54)
  expect(doors.length).toBe(PLACED.length)
  for (const { x, y, box } of doors) {
    for (const f of flames)
      expect(touches(box, f.box), `door ${x},${y} and flame at ${f.box.x0},${f.box.y0}`).toBe(false)
    // The flame nearest the door still draws its own pixels: sprite layer on against off.
    const dist = f => Math.hypot(f.box.x0 - x, f.box.y0 - y)
    const near = flames.reduce((a, b) => (dist(a) <= dist(b) ? a : b))
    const [w, h] = [near.box.x1 - near.box.x0, near.box.y1 - near.box.y0]
    const { on, off } = await onOff(page, r, near.box.x0, near.box.y0, [[0, 0, w, h]])
    expect(on[0].equals(off[0]), `flame at ${near.box.x0},${near.box.y0} is drawn`).toBe(false)
  }
})
