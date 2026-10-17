/**
 * #981: a placed sprite on the map view shows its id and plain name, so a bug report can name it.
 *
 * Hover: the strip's native tooltip (its `title`) reads "Podoboo (sprite $33)" while the pointer is on an
 * opaque sprite pixel and is absent otherwise. Click: the same label in the status bar, cleared by a click on
 * empty ground. "On top" is the draw order of the sprite layer (column order on a horizontal map, the stream
 * index breaking ties, later on top): the expected owner is computed here from the node reply's own bitmaps
 * with that rule, independently of the view's code. Names come from the app's sprite name table
 * (src/rom/model/sprites/SpriteMetadata.ts), the table the reply's `name` is read from.
 * Vanilla ROM; the pinned slot, indexes and ids below were found by a mapSprites sweep (one run, one machine).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

// Map $105: a hidden (screen door) Jumping Piranha Plant, stream index 11, id $4F (#879, D52).
const HIDDEN = { slot: 0x105, index: 11, id: 0x4f, name: 'Piranha Plant (jumping)' }
// An overlapping pair, pinned by a mapSprites sweep over slots $100-$1FF (first hit, one run, one machine).
// Map $105: Banzai Bill (index 1, id $9F, x 496) and Rex (index 2, id $AB, x 528) share 207 opaque pixels.
const PAIR = { slot: 0x105, a: { index: 1, id: 0x9f }, b: { index: 2, id: 0xab } }

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
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sprite-label-'))
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

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    for (const id of ids) {
      try {
        await getSvc('ApplicationShell').closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const rootOf = slot => `[id="hackbench.map-view:${slot}"]`
const stripOf = slot => `${rootOf(slot)} .hb-map-view-strip`
const hex = id => '$' + id.toString(16).toUpperCase().padStart(2, '0')

/** Opens map `slot` and returns the node reply's sprites with a hit test on their own bitmaps. */
async function openMap(page, slot) {
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
  opened.push(`hackbench.map-view:${slot}`)
  await page.locator(stripOf(slot)).waitFor({ timeout: 30000 })
  const reply = await page.evaluate(
    ({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot),
    { mp: manifestPath, slot },
  )
  expect(reply.status).toBe('ok')
  const vertical = reply.orientation === 'vertical'
  const bitmaps = new Map(reply.sprites.map(s => [s, Buffer.from(s.rgba, 'base64')]))
  const opaque = (s, x, y) => {
    const { x0, y0, x1, y1 } = s.box
    return x >= x0 && x < x1 && y >= y0 && y < y1 && bitmaps.get(s)[((y - y0) * (x1 - x0) + (x - x0)) * 4 + 3] !== 0 // prettier-ignore
  }
  // Back to front: column order (row order when vertical), stream index breaking ties; flames are not hit.
  const stack = reply.sprites.filter(s => !s.fixedTo).sort((p, q) => (vertical ? p.y - q.y : p.x - q.x) || p.index - q.index) // prettier-ignore
  const ownerAt = (x, y) => [...stack].reverse().find(s => opaque(s, x, y))
  const mapW = vertical ? reply.width : reply.width * reply.screenCount
  const mapH = vertical ? reply.height * reply.screenCount : reply.height
  return { reply, stack, opaque, ownerAt, mapW, mapH }
}

/** Scrolls map pixel (x, y) to the middle of the view and returns its client position. */
function clientOf(page, slot, map, x, y) {
  return page.evaluate(
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
    { strip: stripOf(slot), mapW: map.mapW, mapH: map.mapH, x, y },
  )
}

/** Moves the pointer onto map pixel (x, y); true once the sprites are loaded enough to have a tooltip decision. */
async function pointAt(page, slot, map, x, y) {
  const p = await clientOf(page, slot, map, x, y)
  await page.mouse.move(p.x + 1, p.y)
  await page.mouse.move(p.x, p.y)
  return p
}

/** The map pixel nearest `near` (4 px steps, growing squares) where `pick(x, y)` holds, so scrolling to it moves the view little. */
function findPixel(map, pick, near = { x: 0, y: 0 }) {
  for (let r = 0; r < Math.max(map.mapW, map.mapH); r += 4) {
    for (let dy = -r; dy <= r; dy += 4) {
      for (let dx = -r; dx <= r; dx += 4) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const [x, y] = [near.x + dx, near.y + dy]
        if (x >= 0 && y >= 0 && x < map.mapW && y < map.mapH && pick(x, y)) return { x, y }
      }
    }
  }
  return undefined
}

/** True when `ok(x + dx, y + dy)` holds for every offset within `r` px, so a half-pixel of zoom rounding cannot land elsewhere. */
function allWithin(r, x, y, ok) {
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (!ok(x + dx, y + dy)) return false // prettier-ignore
  return true
}

/** No sprite has an opaque pixel within 3 px. */
const clearAround = (map, x, y) =>
  allWithin(3, x, y, (px, py) => !map.stack.some(s => map.opaque(s, px, py)))

/** An opaque pixel of `s` that `s` itself owns, with its 2 px neighbourhood owned too. */
function ownPixel(map, s) {
  const { x0, y0, x1, y1 } = s.box
  const own = (x, y) => map.ownerAt(x, y) === s
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (allWithin(2, x, y, own)) return { x, y } // prettier-ignore
  return undefined
}

/** Zoom levels the hover and select assertions sweep: fit, actual size, and one zoomed-in step (hit tests divide by the zoom). */
const ZOOMS = {
  fit: ['zoom-fit'],
  actual: ['zoom-actual'],
  'zoomed in': ['zoom-actual', 'zoom-in', 'zoom-in'],
}
async function setZoom(page, slot, steps) {
  for (const c of steps) await page.locator(`${rootOf(slot)} [data-control="${c}"]`).click()
}

const titleOf = (page, slot) => page.locator(stripOf(slot)).getAttribute('title')
const statusBar = page => page.locator('#theia-statusBar')

/** Re-points at map pixel `at` and reads the strip's title; for polling until the sprites have loaded. */
async function titleAt(page, slot, map, at) {
  await pointAt(page, slot, map, at.x, at.y)
  return titleOf(page, slot)
}

/** The first named, drawn sprite that owns at least one pixel of the map. */
const namedSprite = map =>
  map.stack.find(s => s.status === 'drawn' && s.name && map.ownerAt(s.x, s.y))

test('AC1, AC3: hovering a sprite titles it with its name and $id; clicking puts the same in the status bar; empty ground clears it (#981)', async ({
  page,
}) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = namedSprite(map)
  expect(sprite, 'a named, drawn sprite on the map').toBeTruthy()
  const at = ownPixel(map, sprite)
  const label = `${sprite.name} (sprite ${hex(sprite.id)})`
  const empty = findPixel(map, (x, y) => clearAround(map, x, y), at)
  for (const [zoom, steps] of Object.entries(ZOOMS)) {
    await setZoom(page, slot, steps)
    await expect
      .poll(() => titleAt(page, slot, map, at), { message: zoom, timeout: 30000 })
      .toBe(label)
    expect(label).toMatch(/\(sprite \$[0-9A-F]{2}\)$/)

    const p = await clientOf(page, slot, map, at.x, at.y)
    await page.mouse.click(p.x, p.y)
    await expect(statusBar(page), zoom).toContainText(label)

    const e = await clientOf(page, slot, map, empty.x, empty.y)
    await page.mouse.click(e.x, e.y)
    await expect(statusBar(page), zoom).not.toContainText(label)
    expect(await statusBar(page).innerText()).not.toContain('(sprite $')
  }

  // Selected again, the sprite toggle going off clears it, and a sprite that is not drawn has no tooltip.
  const again = await clientOf(page, slot, map, at.x, at.y)
  await page.mouse.click(again.x, again.y)
  await expect(statusBar(page)).toContainText(label)
  await page.locator(`${rootOf(slot)} [data-control="layer-sprites"]`).click()
  await expect(statusBar(page)).not.toContainText(label)
  await pointAt(page, slot, map, at.x, at.y)
  await expect.poll(() => titleOf(page, slot)).toBeNull()
})

test('AC2: hovering empty ground leaves the strip without a sprite tooltip', async ({ page }) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = namedSprite(map)
  const on = ownPixel(map, sprite)
  for (const [zoom, steps] of Object.entries(ZOOMS)) {
    await setZoom(page, slot, steps)
    // On the sprite first, so a missing tooltip is not just "sprites not loaded yet".
    await expect
      .poll(() => titleAt(page, slot, map, on), { message: zoom, timeout: 30000 })
      .toContain('(sprite $')
    const empty = findPixel(map, (x, y) => clearAround(map, x, y), on)
    await pointAt(page, slot, map, empty.x, empty.y)
    await expect.poll(() => titleOf(page, slot), { message: zoom }).toBeNull()
  }
})

test('AC4: where two sprites overlap, the tooltip names the one drawn on top (column order, stream index breaking ties)', async ({
  page,
}) => {
  const map = await openMap(page, PAIR.slot)
  const [a, b] = [PAIR.a, PAIR.b].map(k =>
    map.stack.find(s => s.index === k.index && s.id === k.id),
  )
  expect(a && b, 'the pinned pair is on the map').toBeTruthy()
  // Both opaque across a 2 px neighbourhood, as ownPixel guarantees, so zoom rounding cannot land on a single-sprite pixel.
  const both = findPixel(
    map,
    (x, y) => allWithin(2, x, y, (px, py) => map.opaque(a, px, py) && map.opaque(b, px, py)),
    a,
  )
  expect(both, 'the pair shares an opaque pixel').toBeTruthy()
  const [top, under] = map.ownerAt(both.x, both.y) === a ? [a, b] : [b, a]
  expect(map.stack.indexOf(top)).toBeGreaterThan(map.stack.indexOf(under))
  await expect
    .poll(() => titleAt(page, PAIR.slot, map, both), { timeout: 30000 })
    .toContain(hex(top.id))
  expect(await titleOf(page, PAIR.slot)).not.toContain(`(sprite ${hex(under.id)})`)
})

test('AC5: a hidden (screen door) sprite shows its id too', async ({ page }) => {
  const map = await openMap(page, HIDDEN.slot)
  const plant = map.stack.find(s => s.index === HIDDEN.index && s.id === HIDDEN.id)
  expect(plant, 'sprite 11 of map $105 is the jumping Piranha Plant').toBeTruthy()
  const at = ownPixel(map, plant)
  // The plant really is behind a tile: some screen's covered-door set holds its door id (the 1-based place in
  // the draw order), read off the widget, so the test cannot pass on a plant that merely is not covered.
  const door = map.stack.indexOf(plant) + 1
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ id, door }) => [...getSvc('ApplicationShell').getWidgetById(id).coveredIds.values()].some(set => set.has(door)), // prettier-ignore
          { id: `hackbench.map-view:${HIDDEN.slot}`, door },
        ),
      { timeout: 30000 },
    )
    .toBe(true)
  await expect
    .poll(() => titleAt(page, HIDDEN.slot, map, at), { timeout: 30000 })
    .toBe(`${HIDDEN.name} (sprite ${hex(HIDDEN.id)})`)
})
