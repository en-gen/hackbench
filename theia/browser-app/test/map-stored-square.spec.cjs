/**
 * #1176 (D154, Decisions 115-117, "1B 2A 3A") and #1231: a sprite the map draws away from the tile it is stored on gets a
 * thin dashed square on that tile; one drawn on its tile gets none. Selecting a moved sprite outlines its stored tile with the
 * solid highlight; clicking the drawing selects it; clicking a shown square selects ITS sprite even where another sprite's
 * drawing covers the square. Every expectation comes from the node reply's own DTO (`mapSprites`), the data the map draws
 * from; sprites are found by sweeping it, never by id. Vanilla ROM; skipped without it.
 *
 * Plants (each turns the named test red): offset the square one cell in map-view-widget.tsx (`stored.x + 16`) and the
 * $00F and $105 geometry tests go red; make `pickAt` try `spriteUnder` before the squares and the square-wins-the-click
 * test goes red; show a square for every sprite (drop the `stored` filter in `storedSquares`) and the "none on its own
 * cell" assertions go red.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x105
// Maps found by a sweep of the 512 vanilla replies: four sprites have a shown square that another sprite's drawing covers
// ($00F #11 and #23, $102 #26, $12C #29). The first that has one is used.
const COVERED_CANDIDATES = [0x00f, 0x102, 0x12c]
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
let projectDir
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`
/** The map's own rect (the edge element), not the strip, which now includes the canvas pad (#1004). */
const stripOf = slot => `${rootOf(slot)} [data-control="map-edge"]`
const squares = slot => `${rootOf(slot)} [data-control="stored-square"]`
const panel = page => page.locator('[id="hackbench.properties"]')

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sprite-props-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  projectDir = path.join(tmp, 'MyHack')
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: projectDir },
  )
  manifestPath = project.manifestPath
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const fetchSprites = (page, slot = SLOT) =>
  page.evaluate(({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot), {
    mp: manifestPath,
    slot,
  })

/** Opens the map; returns the node reply with a click helper on a sprite's own opaque pixel. */
async function openMap(page, slot = SLOT) {
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index: slot },
  )
  await page.locator(stripOf(slot)).waitFor({ timeout: 30000 })
  const reply = await fetchSprites(page, slot)
  expect(reply.status).toBe('ok')
  const vertical = reply.orientation === 'vertical'
  const bitmaps = new Map(reply.sprites.map(s => [s, Buffer.from(s.rgba, 'base64')]))
  const opaque = (s, x, y) => {
    const { x0, y0, x1, y1 } = s.box
    return x >= x0 && x < x1 && y >= y0 && y < y1 && bitmaps.get(s)[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3] !== 0 // prettier-ignore
  }
  const stack = reply.sprites.filter(s => !s.fixedTo).sort((p, q) => (vertical ? p.y - q.y : p.x - q.x) || p.index - q.index) // prettier-ignore
  const ownerAt = (x, y) => [...stack].reverse().find(s => opaque(s, x, y))
  const mapW = vertical ? reply.width : reply.width * reply.screenCount
  const mapH = vertical ? reply.height * reply.screenCount : reply.height
  /** A pixel the sprite itself owns with its 2 px neighbourhood, so zoom rounding cannot land on another. */
  const own = s => {
    for (let y = s.box.y0 + 2; y < s.box.y1 - 2; y++)
      for (let x = s.box.x0 + 2; x < s.box.x1 - 2; x++) {
        let all = true
        for (let dy = -2; dy <= 2 && all; dy++) for (let dx = -2; dx <= 2; dx++) if (ownerAt(x + dx, y + dy) !== s) all = false // prettier-ignore
        if (all) return { x, y }
      }
    return undefined
  }
  const click = async (x, y) => {
    const p = await page.evaluate(
      ({ strip, mapW, mapH, x, y }) => {
        const el = document.querySelector(strip)
        const sc = el.closest('[data-control="map-scroller"]')
        const at = () => {
          const r = el.getBoundingClientRect()
          return {
            x: r.left + ((x + 0.5) * r.width) / mapW,
            y: r.top + ((y + 0.5) * r.height) / mapH,
          }
        }
        const [first, view] = [at(), sc.getBoundingClientRect()]
        sc.scrollBy(first.x - (view.left + view.width / 2), first.y - (view.top + view.height / 2))
        return at()
      },
      { strip: stripOf(slot), mapW, mapH, x, y },
    )
    await page.mouse.click(p.x, p.y)
  }
  /** A pixel with no sprite pixel within 3 px. */
  const emptyPixel = () => {
    for (let y = 4; y < mapH; y += 4)
      for (let x = 4; x < mapW; x += 4)
        if (!stack.some(s => opaque(s, x, y) || opaque(s, x - 3, y - 3) || opaque(s, x + 3, y + 3))) return { x, y } // prettier-ignore
    return undefined
  }
  return { reply, stack, own, click, emptyPixel, ownerAt, opaque, mapW, mapH }
}

/** D154 1B: a square shows for a sprite with a stored tile whose drawing does not cover that whole tile. */
const showsSquare = s => {
  if (!s.stored) return false
  const c = { x0: s.stored.x, y0: s.stored.y, x1: s.stored.x + 16, y1: s.stored.y + 16 }
  return !(s.box.x0 <= c.x0 && s.box.y0 <= c.y0 && s.box.x1 >= c.x1 && s.box.y1 >= c.y1)
}

/** The on-screen box of the first element matching `sel`, in map pixels, from the map's edge element. */
const mapBox = (page, slot, sel, mapW) =>
  page.evaluate(
    ({ edge, sel, mapW }) => {
      const e = document.querySelector(edge).getBoundingClientRect()
      const t = document.querySelector(sel).getBoundingClientRect()
      const zoom = e.width / mapW
      return {
        x: (t.left - e.left) / zoom,
        y: (t.top - e.top) / zoom,
        w: t.width / zoom,
        h: t.height / zoom,
      }
    },
    { edge: stripOf(slot), sel, mapW },
  )

const near = (got, want) => Math.abs(got.x - want.x) < 1.5 && Math.abs(got.y - want.y) < 1.5 && Math.abs(got.w - 16) < 1.5 && Math.abs(got.h - 16) < 1.5 // prettier-ignore

test('$105: each moved $4F has a dashed square on its stored tile, the select highlight replaces it, and clicking the drawing selects it', async ({
  page,
}) => {
  const map = await openMap(page, SLOT)
  const moved = map.stack.filter(s => s.id === 0x4f && s.stored)
  expect(moved.length, 'moved $4F on $105').toBe(3)
  // The drawing is where INIT leaves it: the stored tile plus (+8, -1).
  for (const s of moved) expect([s.x - s.stored.x, s.y - s.stored.y]).toEqual([8, -1])
  const shown = map.reply.sprites.filter(showsSquare)
  await expect(page.locator(squares(SLOT))).toHaveCount(shown.length)
  for (const s of moved) {
    const sel = `${squares(SLOT)}[data-sprite-index="${s.index}"]`
    await expect(page.locator(sel)).toHaveCount(1)
    expect(near(await mapBox(page, SLOT, sel, map.mapW), { ...s.stored, w: 16, h: 16 }), `square of #${s.index} on its stored tile`).toBe(true) // prettier-ignore
  }
  // No line, no fill: the square is a bare dashed box (the center stays clear, so the art under it shows).
  const look = await page
    .locator(squares(SLOT))
    .first()
    .evaluate(e => {
      const c = getComputedStyle(e)
      return {
        style: c.borderTopStyle,
        width: c.borderTopWidth,
        bg: c.backgroundColor,
        kids: e.children.length,
      }
    })
  expect(look).toEqual({ style: 'dashed', width: '1px', bg: 'rgba(0, 0, 0, 0)', kids: 0 })
  // A sprite drawn on its own cell has none.
  const plain = map.reply.sprites.find(s => !s.stored && s.status === 'drawn')
  expect(plain, 'a sprite on its own cell').toBeTruthy()
  await expect(page.locator(`${squares(SLOT)}[data-sprite-index="${plain.index}"]`)).toHaveCount(0)

  // Select a moved one by clicking its DRAWING: the solid highlight is on its stored tile and its dashed square makes way for it.
  const pick = moved.find(s => map.own(s))
  const at = map.own(pick)
  await map.click(at.x, at.y)
  const tile = `${rootOf(SLOT)} [data-control="stored-tile"]`
  await expect(page.locator(tile)).toHaveCount(1)
  expect(near(await mapBox(page, SLOT, tile, map.mapW), { ...pick.stored, w: 16, h: 16 })).toBe(
    true,
  )
  await expect(page.locator(`${squares(SLOT)}[data-sprite-index="${pick.index}"]`)).toHaveCount(0)
  await expect(panel(page).locator('[data-field="position"]')).toHaveText(
    `Column ${Math.floor(pick.stored.x / 16)}, row ${Math.floor(pick.stored.y / 16)}`,
  )
  const e = map.emptyPixel()
  await map.click(e.x, e.y)
  await expect(page.locator(tile)).toHaveCount(0)
  await expect(page.locator(`${squares(SLOT)}[data-sprite-index="${pick.index}"]`)).toHaveCount(1)
})

test('$00F: an odd-column chainsaw drawn 15 px right of its tile has its square on the stored cell, not on the drawing; the even-column ones that never appear have none', async ({
  page,
}) => {
  const map = await openMap(page, 0x00f)
  const saws = map.reply.sprites.filter(s => s.id === 0x65 && s.status === 'drawn' && s.stored)
  expect(saws.length, 'moved chainsaws on $00F').toBeGreaterThan(0)
  const saw = saws[0]
  expect(saw.x, 'the drawing is not on the stored cell').not.toBe(saw.stored.x)
  const sel = `${squares(0x00f)}[data-sprite-index="${saw.index}"]`
  await expect(page.locator(sel)).toHaveCount(1)
  const box = await mapBox(page, 0x00f, sel, map.mapW)
  expect(near(box, { ...saw.stored, w: 16, h: 16 }), `square at ${JSON.stringify(box)}`).toBe(true)
  // One cell off would be 16 px away; the drawing's own corner is 15 px away. Neither is acceptable.
  expect(Math.abs(box.x - saw.x) + Math.abs(box.y - saw.y)).toBeGreaterThan(8)
  const never = map.reply.sprites.filter(s => s.id === 0x65 && s.note === 'never appears in play')
  expect(never.length).toBe(7)
  for (const s of never) await expect(page.locator(`${squares(0x00f)}[data-sprite-index="${s.index}"]`)).toHaveCount(0) // prettier-ignore
})

test("a shown square wins the click over another sprite's drawing on top of it (D154 3A)", async ({
  page,
}) => {
  let found
  for (const slot of COVERED_CANDIDATES) {
    const map = await openMap(page, slot)
    for (const a of map.reply.sprites.filter(showsSquare)) {
      const c = a.stored
      // Two pixels in from the square's edge and with the covering sprite 2 px on every side: a click is truncated to a whole
      // screen pixel, so a pixel on the square's edge can land in the cell next to it, where the drawing rightly wins.
      for (let y = c.y + 2; y < c.y + 14 && !found; y++)
        for (let x = c.x + 2; x < c.x + 14 && !found; x++) {
          const b = map.ownerAt(x, y)
          const ring = [-2, -1, 0, 1, 2].flatMap(dy => [-2, -1, 0, 1, 2].map(dx => [dx, dy]))
          if (b && b !== a && ring.every(([dx, dy]) => map.ownerAt(x + dx, y + dy) === b)) found = { slot, map, a, b, x, y } // prettier-ignore
        }
      if (found) break
    }
    if (found) break
  }
  expect(found, 'a map with a stored square under another sprite drawing').toBeTruthy()
  const { slot, map, a, b, x, y } = found
  expect(map.ownerAt(x, y), 'without the square the drawing would take the click').toBe(b)
  await map.click(x, y)
  await expect(panel(page).locator('[data-field="position"]')).toHaveText(
    `Column ${Math.floor(a.stored.x / 16)}, row ${Math.floor(a.stored.y / 16)}`,
  )
  await expect(page.locator(`${rootOf(slot)} [data-control="stored-tile"]`)).toHaveCount(1)
})

test('hovering a shown square says in plain words that the sprite is stored there and drawn elsewhere (D154, #1176 AC8)', async ({
  page,
}) => {
  const map = await openMap(page, SLOT)
  const s = map.stack.find(q => q.id === 0x4f && q.stored)
  const sel = `${squares(SLOT)}[data-sprite-index="${s.index}"]`
  await expect(page.locator(sel)).toHaveCount(1)
  // Scroll the square into view first, then hover its center.
  await page.locator(sel).scrollIntoViewIfNeeded()
  const b = await page.locator(sel).boundingBox()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  const tip = page.locator('.hb-map-sprite-hover')
  await expect(tip).toHaveText(/stored here.*drawn elsewhere/i, { timeout: 10000 })
  await expect(tip).not.toContainText(/github|#\d/i)
})
