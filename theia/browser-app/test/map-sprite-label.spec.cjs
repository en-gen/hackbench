/**
 * #981: hovering a placed sprite on the map view shows its plain name, and only the name, in Theia's own
 * themed hover (the `.theia-hover` box, colours from the editor hover theme variables), never a native `title`.
 * The status bar carries no sprite id or name, on hover or on click. "On top" is the draw order of the sprite
 * layer (column order on a horizontal map, the stream index breaking ties, later on top): the expected owner is
 * computed here from the node reply's own bitmaps with that rule, independently of the view's code. Names come
 * from the app's sprite name table (src/rom/model/sprites/SpriteMetadata.ts), the table the reply's `name` is read from.
 *
 * Plants (what turns each assertion red): giving the strip a `title` again fails "no native title" in AC1; showing
 * the id beside the name (e.g. "Podoboo (sprite $33)") fails every exact-text check; dropping the `hoverService`
 * request, or showing a plain div instead of it, fails the hover and theme checks; publishing the name to the
 * status bar again fails the status bar checks (hover and click).
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
/** Clicks the zoom controls and returns the zoom indicator's text, so a sweep can prove its levels differ. */
async function setZoom(page, slot, steps) {
  for (const c of steps) await page.locator(`${rootOf(slot)} [data-control="${c}"]`).click()
  return page.locator(`${rootOf(slot)} [data-control="zoom-indicator"]`).innerText()
}

/** The text of Theia's open hover box, or null when none is open. */
const hoverOf = page =>
  page.evaluate(() => {
    const h = document.querySelector('.theia-hover')
    return h && h.isConnected && h.matches(':popover-open') ? h.textContent : null
  })
const nativeTitleOf = (page, slot) => page.locator(stripOf(slot)).getAttribute('title')
const statusBar = page => page.locator('#theia-statusBar')

/** The open hover's colours against what the editor hover theme variables resolve to (a probe element resolves them). */
const hoverIsThemed = page =>
  page.evaluate(() => {
    const h = document.querySelector('.theia-hover')
    const probe = document.createElement('div')
    probe.style.cssText = 'color: var(--theia-editorHoverWidget-foreground); background-color: var(--theia-editorHoverWidget-background); border: 1px solid var(--theia-editorHoverWidget-border);' // prettier-ignore
    document.body.append(probe)
    const [want, got] = [getComputedStyle(probe), getComputedStyle(h)]
    const same = ['color', 'backgroundColor', 'borderTopColor'].every(k => want[k] === got[k])
    probe.remove()
    return same
  })

/** Re-points at map pixel `at` and reads the open hover's text; for polling until the sprites have loaded. */
async function hoverAt(page, slot, map, at) {
  await pointAt(page, slot, map, at.x, at.y)
  return hoverOf(page)
}

/** The first named, drawn sprite that owns at least one pixel of the map. */
const namedSprite = map =>
  map.stack.find(s => s.status === 'drawn' && s.name && map.ownerAt(s.x, s.y))

test('AC1, AC3: hovering a sprite opens a themed hover whose text is exactly its name; no native title, nothing in the status bar (#981)', async ({
  page,
}) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = namedSprite(map)
  expect(sprite, 'a named, drawn sprite on the map').toBeTruthy()
  const at = ownPixel(map, sprite)
  const empty = findPixel(map, (x, y) => clearAround(map, x, y), at)
  const levels = []
  for (const [zoom, steps] of Object.entries(ZOOMS)) {
    levels.push(await setZoom(page, slot, steps))
    await expect
      .poll(() => hoverAt(page, slot, map, at), { message: zoom, timeout: 30000 })
      .toBe(sprite.name)
    expect(await hoverIsThemed(page), `${zoom}: theme colours`).toBe(true)
    expect(await nativeTitleOf(page, slot), `${zoom}: no native title`).toBeNull()
    expect(await statusBar(page).innerText(), `${zoom}: hover`).not.toContain(sprite.name)

    // A click does not select anything or reach the status bar either.
    const p = await clientOf(page, slot, map, at.x, at.y)
    await page.mouse.click(p.x, p.y)
    expect(await statusBar(page).innerText(), `${zoom}: click`).not.toContain(sprite.name)
    expect(await statusBar(page).innerText(), `${zoom}: click`).not.toMatch(/\$[0-9A-F]{2}\b/)

    await pointAt(page, slot, map, empty.x, empty.y)
    await expect.poll(() => hoverOf(page), { message: `${zoom}: empty ground` }).toBeNull()
  }
  // The sweep really covered three zoom levels (fit equal to 100% on this map would collapse two of them).
  expect(new Set(levels).size, `zoom indicators ${levels}`).toBe(Object.keys(ZOOMS).length)

  // The sprite toggle going off removes the hover, and a sprite that is not drawn has none.
  await page.locator(`${rootOf(slot)} [data-control="layer-sprites"]`).click()
  await pointAt(page, slot, map, at.x, at.y)
  await expect.poll(() => hoverOf(page)).toBeNull()
})

test('AC2: hovering empty ground opens no sprite hover', async ({ page }) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = namedSprite(map)
  const on = ownPixel(map, sprite)
  const levels = []
  for (const [zoom, steps] of Object.entries(ZOOMS)) {
    levels.push(await setZoom(page, slot, steps))
    // On the sprite first, so a missing hover is not just "sprites not loaded yet".
    await expect
      .poll(() => hoverAt(page, slot, map, on), { message: zoom, timeout: 30000 })
      .toBe(sprite.name)
    const empty = findPixel(map, (x, y) => clearAround(map, x, y), on)
    await pointAt(page, slot, map, empty.x, empty.y)
    await expect.poll(() => hoverOf(page), { message: zoom }).toBeNull()
  }
  expect(new Set(levels).size, `zoom indicators ${levels}`).toBe(Object.keys(ZOOMS).length)
})

test('AC4: where two sprites overlap, the hover names the one drawn on top (column order, stream index breaking ties)', async ({
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
  expect(top.name, 'the pair is named, by different names').not.toBe(under.name)
  await expect.poll(() => hoverAt(page, PAIR.slot, map, both), { timeout: 30000 }).toBe(top.name)
})

test('AC5: a hidden (screen door) sprite shows its name too', async ({ page }) => {
  const map = await openMap(page, HIDDEN.slot)
  const plant = map.stack.find(s => s.index === HIDDEN.index && s.id === HIDDEN.id)
  expect(plant, 'sprite 11 of map $105 is the jumping Piranha Plant').toBeTruthy()
  const at = ownPixel(map, plant)
  // The plant really is behind a tile: some screen's covered-door set holds its door id (the 1-based place in
  // the draw order), read off the widget (this reads the protected `coveredIds` field by name, so a rename breaks it loudly), so the test cannot pass on a plant that merely is not covered.
  const door = map.stack.indexOf(plant) + 1
  // Only the screens in view (plus a margin) are painted, and only a painted screen fills `coveredIds`: scroll the plant into view first.
  await clientOf(page, HIDDEN.slot, map, at.x, at.y)
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
  await expect.poll(() => hoverAt(page, HIDDEN.slot, map, at), { timeout: 30000 }).toBe(HIDDEN.name)
})
