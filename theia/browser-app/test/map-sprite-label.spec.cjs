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
const HIDDEN = { slot: 0x105, index: 11, id: 0x4f, name: 'Jumping Piranha Plant' }
// An overlapping pair, pinned by a sweep: see PAIR_NOTE.
const PAIR = { slot: 0, a: { index: 0, id: 0 }, b: { index: 0, id: 0 } }

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

/** A map pixel where `pick(x, y)` holds: scans in 4 px steps, so the choice does not depend on the view. */
function findPixel(map, pick) {
  for (let y = 0; y < map.mapH; y += 4) for (let x = 0; x < map.mapW; x += 4) if (pick(x, y)) return { x, y } // prettier-ignore
  return undefined
}

/** An opaque pixel of `s` that `s` itself owns (nothing above it). */
function ownPixel(map, s) {
  const { x0, y0, x1, y1 } = s.box
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (map.ownerAt(x, y) === s) return { x, y } // prettier-ignore
  return undefined
}

const titleOf = (page, slot) => page.locator(stripOf(slot)).getAttribute('title')
const statusText = page => page.locator('#theia-statusBar').innerText()

test('AC1, AC3: hovering a sprite titles it with its name and $id; clicking puts the same in the status bar; empty ground clears it (#981)', async ({
  page,
}) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = map.stack.find(s => s.status === 'drawn' && s.name && map.ownerAt(s.x, s.y))
  expect(sprite, 'a named, drawn sprite on the map').toBeTruthy()
  const at = ownPixel(map, sprite)
  const label = `${sprite.name} (sprite ${hex(sprite.id)})`
  await expect.poll(async () => { await pointAt(page, slot, map, at.x, at.y); return titleOf(page, slot) }, { timeout: 30000 }).toBe(label) // prettier-ignore
  expect(label).toMatch(/\(sprite \$[0-9A-F]{2}\)$/)

  const p = await clientOf(page, slot, map, at.x, at.y)
  await page.mouse.click(p.x, p.y)
  await expect(page.locator('#theia-statusBar')).toContainText(label)

  const empty = findPixel(
    map,
    (x, y) => !map.ownerAt(x, y) && !map.stack.some(s => map.opaque(s, x, y)),
  )
  const e = await clientOf(page, slot, map, empty.x, empty.y)
  await page.mouse.click(e.x, e.y)
  await expect(page.locator('#theia-statusBar')).not.toContainText(label)
  expect(await statusText(page)).not.toContain('(sprite $')
})

test('AC2: hovering empty ground leaves the strip without a sprite tooltip', async ({ page }) => {
  const slot = HIDDEN.slot
  const map = await openMap(page, slot)
  const sprite = map.stack.find(s => s.status === 'drawn' && s.name && map.ownerAt(s.x, s.y))
  const on = ownPixel(map, sprite)
  // On the sprite first, so a missing tooltip is not just "sprites not loaded yet".
  await expect.poll(async () => { await pointAt(page, slot, map, on.x, on.y); return titleOf(page, slot) }, { timeout: 30000 }).toContain('(sprite $') // prettier-ignore
  const empty = findPixel(map, (x, y) => !map.stack.some(s => map.opaque(s, x, y)))
  await pointAt(page, slot, map, empty.x, empty.y)
  await expect.poll(() => titleOf(page, slot)).toBeNull()
})

test('AC4: where two sprites overlap, the tooltip names the one drawn on top (column order, stream index breaking ties)', async ({
  page,
}) => {
  const map = await openMap(page, PAIR.slot)
  const [a, b] = [PAIR.a, PAIR.b].map(k =>
    map.stack.find(s => s.index === k.index && s.id === k.id),
  )
  expect(a && b, 'the pinned pair is on the map').toBeTruthy()
  const both = findPixel({ ...map, mapW: map.mapW, mapH: map.mapH }, (x, y) => map.opaque(a, x, y) && map.opaque(b, x, y)) // prettier-ignore
  expect(both, 'the pair shares an opaque pixel').toBeTruthy()
  const [top, under] = map.ownerAt(both.x, both.y) === a ? [a, b] : [b, a]
  expect(map.stack.indexOf(top)).toBeGreaterThan(map.stack.indexOf(under))
  await expect.poll(async () => { await pointAt(page, PAIR.slot, map, both.x, both.y); return titleOf(page, PAIR.slot) }, { timeout: 30000 }).toContain(hex(top.id)) // prettier-ignore
  expect(await titleOf(page, PAIR.slot)).not.toContain(`(sprite ${hex(under.id)})`)
})

test('AC5: a hidden (screen door) sprite shows its id too', async ({ page }) => {
  const map = await openMap(page, HIDDEN.slot)
  const plant = map.stack.find(s => s.index === HIDDEN.index && s.id === HIDDEN.id)
  expect(plant, 'sprite 11 of map $105 is the Jumping Piranha Plant').toBeTruthy()
  const at = ownPixel(map, plant)
  await expect.poll(async () => { await pointAt(page, HIDDEN.slot, map, at.x, at.y); return titleOf(page, HIDDEN.slot) }, { timeout: 30000 }).toBe(`${HIDDEN.name} (sprite ${hex(HIDDEN.id)})`) // prettier-ignore
})
