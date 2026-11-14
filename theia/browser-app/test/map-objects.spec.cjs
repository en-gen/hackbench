/**
 * #1237: the map view finds saved Objects and lets the user select them and their edge segments, read-only.
 *
 * Definitions are written to the test project's meta/objects/ in the saved format (#1236), derived at runtime
 * from the vanilla map's own stored pieces (test/suite/support/objectsFixture.ts, bundled here with esbuild):
 * no literal tile tables (D127). Acceptance 6 and 7 are asserted from the overlay DOM, never a screenshot: one
 * `object-outline` and zero per-tile boxes for a selected Object; a segment responds only on a selected one,
 * outside its edge line and not inside it, on a straight side and on a slope; Ctrl+click adds a second.
 * Pointer positions come from the reply's own DTO (`mapObjects`), the data the overlay draws from.
 * Vanilla ROM; skipped without it.
 */
const { test, expect } = require('@playwright/test')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const REPO = path.join(__dirname, '..', '..', '..')
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const TILE = 16
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`
const stripOf = slot => `${rootOf(slot)} [data-control="map-edge"]`
const overlay = slot => `${rootOf(slot)} [data-control="object-overlay"]`

/** The fixture module, bundled from TypeScript: the specs cannot import the core directly. */
function loadFixture() {
  const esbuild = require('esbuild')
  const out = esbuild.buildSync({
    entryPoints: [path.join(REPO, 'test', 'suite', 'support', 'objectsFixture.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  const m = { exports: {} }
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require)
  return m.exports
}

/** A hash of every file under the project folder: a write anywhere changes it. */
function treeHash(dir) {
  const h = createHash('sha256')
  const walk = d => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(p).update(fs.readFileSync(p))
    }
  }
  walk(dir)
  return h.digest('hex')
}

let tmp
let manifestPath
let projectDir
let fixture

test.beforeAll(() => {
  fixture = loadFixture()
})

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForFunction(
    () => {
      try {
        const d = window.theia.container._bindingDictionary
        return [...d._map.keys()].some(k => String(k) === 'Symbol(ProjectService)')
      } catch {
        return false
      }
    },
    null,
    { timeout: 90000 },
  )
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

/** Writes definitions into the project's meta/objects/ as #1236 saves them. */
function saveDefinitions(...defs) {
  const dir = path.join(projectDir, 'meta', 'objects')
  fs.mkdirSync(dir, { recursive: true })
  for (const d of defs)
    fs.writeFileSync(path.join(dir, `${d.id}.json`), JSON.stringify(d, null, 2) + '\n')
}

const rpc = (page, name, ...args) =>
  page.evaluate(({ name, args }) => getSvc('Symbol(ProjectService)')[name](...args), { name, args })

/** Opens the map and waits for the Objects read; returns the map's pixel size and its Objects. */
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
  await page.locator(stripOf(slot)).waitFor({ timeout: 30000 })
  await page.locator(`${rootOf(slot)} [data-objects="ok"]`).waitFor({ timeout: 30000 })
  const sprites = await rpc(page, 'mapSprites', manifestPath, slot)
  expect(sprites.status).toBe('ok')
  const vertical = sprites.orientation === 'vertical'
  const size = {
    w: vertical ? sprites.width : sprites.width * sprites.screenCount,
    h: vertical ? sprites.height * sprites.screenCount : sprites.height,
  }
  const reply = await rpc(page, 'mapObjects', manifestPath, slot)
  expect(reply.status).toBe('ok')
  return { size, objects: reply.objects, sprites: sprites.sprites }
}

/** Moves the real pointer to a map pixel (scrolling it into view first); returns where, in client pixels. */
/**
 * Waits until the map's layout has stopped moving: the map's box, the scroller's offsets and the rendered zoom
 * are the same on 5 animation frames in a row. The view keeps laying itself out after the Objects reply (the
 * sprites reply can change the pad, which refits the zoom and restores the scroll two frames later), so a point
 * worked out before that settles can be somewhere else by the time the click arrives.
 */
async function settle(page, slot) {
  // Theia's loading splash (.theia-preload) keeps its pointer events while it fades out, so it would take the click.
  await page.waitForFunction(() => !document.querySelector('.theia-preload'), null, {
    timeout: 15000,
  })
  await page.evaluate(() => {
    window.__hbSettle = undefined
  })
  await page.waitForFunction(
    strip => {
      const el = document.querySelector(strip)
      if (!el) return false
      const sc = el.closest('[data-control="map-scroller"]')
      const r = el.getBoundingClientRect()
      const sig = [
        r.left,
        r.top,
        r.width,
        r.height,
        sc.scrollLeft,
        sc.scrollTop,
        sc.dataset.renderedZoom,
      ].join()
      const seen = window.__hbSettle
      if (!seen || seen.sig !== sig) {
        window.__hbSettle = { sig, n: 1 }
        return false
      }
      return ++seen.n >= 5
    },
    stripOf(slot),
    { polling: 'raf', timeout: 15000 },
  )
}

/**
 * Moves the real pointer to a map pixel (scrolling it into view first), after the layout has settled; returns
 * where, in client pixels. The point is worked out again after the scroll has landed and just before the pointer
 * goes there, from the live DOM, so a click cannot land on a stale place.
 */
async function pointAt(page, slot, size, x, y, action = 'move', modifiers = []) {
  await settle(page, slot)
  const p = await page.evaluate(
    async ({ strip, size, x, y }) => {
      const el = document.querySelector(strip)
      const sc = el.closest('[data-control="map-scroller"]')
      const at = () => {
        const r = el.getBoundingClientRect()
        return { x: r.left + (x * r.width) / size.w, y: r.top + (y * r.height) / size.h }
      }
      const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
      const [first, view] = [at(), sc.getBoundingClientRect()]
      sc.scrollBy({
        left: first.x - (view.left + view.width / 2),
        top: first.y - (view.top + view.height / 2),
        behavior: 'instant',
      })
      await frame()
      return at()
    },
    { strip: stripOf(slot), size, x, y },
  )
  // Whatever is on top at that point must be the map: an overlay in the way shows up here, named, not as a miss.
  const top = await page.evaluate(
    ({ strip, x, y }) => {
      const hit = document.elementFromPoint(x, y)
      const inside =
        !!hit && !!hit.closest('[data-control="map-scroller"]') && !!document.querySelector(strip)
      return inside
        ? null
        : hit
          ? `${hit.tagName}.${String(hit.className)}`
          : 'nothing (the point is off screen)'
    },
    { strip: stripOf(slot), x: p.x, y: p.y },
  )
  if (top)
    throw new Error(
      `the point (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) is covered by ${top}, not the map`,
    )
  for (const m of modifiers) await page.keyboard.down(m)
  if (action === 'click') await page.mouse.click(p.x, p.y)
  else await page.mouse.move(p.x, p.y)
  for (const m of modifiers) await page.keyboard.up(m)
  return p
}

const cellSet = o =>
  new Set(o.runs.flatMap(r => Array.from({ length: r.len }, (_, i) => `${r.row},${r.col + i}`)))
const inCells = (o, x, y) => cellSet(o).has(`${Math.floor(y / TILE)},${Math.floor(x / TILE)}`)
const onSprite = (sprites, x, y) =>
  sprites.some(s => x >= s.box.x0 - 2 && x < s.box.x1 + 2 && y >= s.box.y0 - 2 && y < s.box.y1 + 2)

/** Distance from a point to a polyline given as x0,y0,x1,y1,... */
function distToPolyline(points, [x, y]) {
  let best = Infinity
  for (let i = 0; i + 3 < points.length; i += 2) {
    const [ax, ay, bx, by] = points.slice(i, i + 4)
    const [dx, dy] = [bx - ax, by - ay]
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
  }
  return best
}

/**
 * Points around one segment of the Object, clear of sprites and other Objects: `out` 4 px outside the
 * outline and `edge` 4 px inside it (the outer half of the edge tile) both grab the segment; `deep` 12 px
 * inside (inside the edge line, half a tile in) is the Object and no segment is within reach of it.
 * `which` skips earlier candidates.
 */
function probe(map, object, kind, which = 0) {
  const found = []
  for (const seg of object.segments.filter(s => s.kind === kind)) {
    for (let i = 0; i + 3 < seg.points.length; i += 2) {
      const [ax, ay, bx, by] = seg.points.slice(i, i + 4)
      const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
      const [nx, ny] = ax === bx ? [1, 0] : [0, 1]
      for (const s of [1, -1]) {
        const out = [mx + s * nx * 4, my + s * ny * 4]
        const edge = [mx - s * nx * 4, my - s * ny * 4]
        const deep = [mx - s * nx * 12, my - s * ny * 12]
        const free = p => !map.objects.some(o => inCells(o, ...p)) && !onSprite(map.sprites, ...p)
        const mine = p =>
          inCells(object, ...p) &&
          !onSprite(map.sprites, ...p) &&
          !map.objects.some(o => o !== object && inCells(o, ...p))
        const nearest = p =>
          object.segments.every(
            o => o === seg || distToPolyline(o.points, p) > distToPolyline(seg.points, p),
          )
        if (
          free(out) &&
          mine(edge) &&
          mine(deep) &&
          nearest(edge) &&
          object.segments.every(o => distToPolyline(o.points, deep) > 9)
        )
          found.push({ seg, out, edge, deep, inn: deep })
      }
    }
  }
  return found[which]
}

/** All segments of an Object, nearest-distance helper. */
const distToObjectOutline = (object, p) =>
  Math.min(...object.segments.map(sg => distToPolyline(sg.points, p)))

/**
 * A point on the Object body at least 1.5 tiles from its whole outline, clear of sprites and other Objects, so a
 * click there cannot land in an edge band whatever the zoom rounding does. Cell centres are tried first.
 */
function farPoint(map, object) {
  for (const run of object.runs)
    for (let i = 0; i < run.len; i++) {
      const p = [(run.col + i + 0.5) * TILE, (run.row + 0.5) * TILE]
      if (
        distToObjectOutline(object, p) >= 1.5 * TILE &&
        !onSprite(map.sprites, ...p) &&
        !map.objects.some(o => o !== object && inCells(o, ...p))
      )
        return p
    }
  return undefined
}

/**
 * Points in the INSIDE half of the edge band of straight segments, 4 px inside the outline at a segment's
 * middle, clear of corners (the segment is at least 2 tiles long) and of other segments (every other segment is
 * at least 9 px away). No air outside is needed. One entry per segment.
 */
function innerProbes(map, object) {
  const out = []
  for (const seg of object.segments.filter(s => s.kind === 'straight')) {
    const [ax, ay, bx, by] = seg.points.slice(0, 4)
    if (Math.hypot(bx - ax, by - ay) < 2 * TILE || seg.points.length !== 4) continue
    const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
    const [nx, ny] = ax === bx ? [1, 0] : [0, 1]
    for (const s of [1, -1]) {
      const edge = [mx + s * nx * 4, my + s * ny * 4]
      const others = object.segments.filter(o => o !== seg)
      if (
        inCells(object, ...edge) &&
        !onSprite(map.sprites, ...edge) &&
        !map.objects.some(o => o !== object && inCells(o, ...edge)) &&
        others.every(o => distToPolyline(o.points, edge) >= 9)
      ) {
        out.push({ seg, edge })
        break
      }
    }
  }
  return out
}

/**
 * Three points around one run of a slope segment, whatever is beside it: `edge` 4 px inside the Object (in the
 * band), `deep` 12 px inside (the Object body, beyond the band), `far` 12 px outside (not the Object, no other
 * Object, beyond the band). `deep` and `far` keep 9 px from every segment of the Object.
 */
function slopeProbe(map) {
  for (const object of map.objects)
    for (const seg of object.segments.filter(s => s.kind === 'slope'))
      for (let i = 0; i + 3 < seg.points.length; i += 2) {
        const [ax, ay, bx, by] = seg.points.slice(i, i + 4)
        const [mx, my] = [(ax + bx) / 2, (ay + by) / 2]
        const [nx, ny] = ax === bx ? [1, 0] : [0, 1]
        for (const s of [1, -1]) {
          const edge = [mx - s * nx * 4, my - s * ny * 4]
          const far = [mx + s * nx * 12, my + s * ny * 12]
          // `deep` is the point inside the Object, along the inward normal, farthest from every segment (never
          // within the band of another step of the staircase).
          let deep
          for (let d = 12; d <= 64; d += 4) {
            const p = [mx - s * nx * d, my - s * ny * d]
            if (!inCells(object, ...p) || onSprite(map.sprites, ...p)) break
            if (!deep || distToObjectOutline(object, p) > distToObjectOutline(object, deep))
              deep = p
          }
          if (
            deep &&
            inCells(object, ...edge) &&
            !map.objects.some(o => inCells(o, ...far)) &&
            !onSprite(map.sprites, ...edge) &&
            !onSprite(map.sprites, ...far) &&
            distToObjectOutline(object, deep) > 9 &&
            distToObjectOutline(object, far) > 9 &&
            distToPolyline(seg.points, edge) <
              distToObjectOutline({ segments: object.segments.filter(o => o !== seg) }, edge)
          )
            return { object, seg, edge, deep, far }
        }
      }
  return undefined
}

const selectedObjects = (page, slot) =>
  page.locator(`${overlay(slot)} [data-control="object"][data-state="selected"]`)
const segments = (page, slot, state) =>
  page.locator(
    `${overlay(slot)} [data-control="object-segment"]${state ? `[data-state="${state}"]` : ''}`,
  )

test.describe('platforms on $103 (straight sides)', () => {
  const SLOT = 0x103
  let map
  let target

  test.beforeEach(async ({ page }) => {
    saveDefinitions(fixture.platformDefinition(ROM))
    map = await openMap(page, SLOT)
    // A front-most platform on screen 0 with a straight side that has clear air outside it.
    target = map.objects
      .filter(o => o.runs.every(r => (r.col + r.len) * TILE <= 256))
      .find(o => probe(map, o, 'straight') && farPoint(map, o) && innerProbes(map, o).length >= 2)
    expect(
      target,
      'a platform on screen 0 with a straight side clear of sprites, a point 1.5 tiles from its outline and two long straight sides',
    ).toBeTruthy()
  })

  test('one click selects the whole Object: one outline, one tint, no per-tile boxes; clicking outside clears it', async ({
    page,
  }) => {
    expect(map.objects.filter(o => o.runs.every(r => (r.col + r.len) * TILE <= 256))).toHaveLength(
      4,
    )
    const before = treeHash(projectDir)
    // At least 1.5 tiles from every outline segment: the click cannot land in an edge band.
    const inside = farPoint(map, target)
    // Hover first: a faint dashed outline, still not a selection.
    await pointAt(page, SLOT, map.size, ...inside)
    const hover = page.locator(`${overlay(SLOT)} [data-control="object"][data-state="hover"]`)
    await expect(hover).toHaveCount(1)
    await expect(selectedObjects(page, SLOT)).toHaveCount(0)
    const dash = await hover
      .locator('[data-control="object-outline"]')
      .evaluate(e => getComputedStyle(e).strokeDasharray)
    expect(dash).not.toBe('none')

    await pointAt(page, SLOT, map.size, ...inside, 'click')
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)
    const sel = selectedObjects(page, SLOT)
    await expect(sel).toHaveAttribute('data-object', target.key)
    await expect(sel.locator('[data-control="object-outline"]')).toHaveCount(1)
    await expect(sel.locator('[data-control="object-tint"]')).toHaveCount(1)
    // The outline is the Object's own boundary, one path; nothing is a box per tile.
    await expect(sel.locator('[data-control="object-outline"]')).toHaveAttribute(
      'd',
      target.visiblePath,
    )
    // The selected Object is exactly its tint, its outline and (when covered) its dashed outline: a tint path
    // per tile, or a box per tile, would add children.
    await expect(sel.locator('> *')).toHaveCount(2 + (target.coveredPath ? 1 : 0))
    await expect(page.locator(`${overlay(SLOT)} rect`)).toHaveCount(0)
    // The grid did not light up: nothing else in the overlay.
    await expect(page.locator(`${overlay(SLOT)} [data-control="object"]`)).toHaveCount(1)

    // Clicking where nothing is clears it.
    const empty = [4, 4]
    expect(map.objects.some(o => inCells(o, ...empty))).toBe(false)
    await pointAt(page, SLOT, map.size, ...empty, 'click')
    await expect(selectedObjects(page, SLOT)).toHaveCount(0)
    // Selecting changed nothing in the project.
    expect(treeHash(projectDir)).toBe(before)
  })

  test('on an unselected Object no segment responds; on a selected one only near the outline', async ({
    page,
  }) => {
    const before = treeHash(projectDir)
    const p = probe(map, target, 'straight')
    // Unselected: in the outer half of its edge tile the pointer has the Object (hover) and no segment answers.
    await pointAt(page, SLOT, map.size, ...p.edge)
    await expect(
      page.locator(`${overlay(SLOT)} [data-control="object"][data-state="hover"]`),
    ).toHaveCount(1)
    await expect(segments(page, SLOT)).toHaveCount(0)
    // Just outside the outline, clear of every Object: nothing is drawn at all.
    await pointAt(page, SLOT, map.size, ...p.out)
    await expect(segments(page, SLOT)).toHaveCount(0)
    await expect(page.locator(`${overlay(SLOT)} [data-control="object"]`)).toHaveCount(0)
    await pointAt(page, SLOT, map.size, ...farPoint(map, target), 'click')
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)

    // Selected: outside the line highlights that segment; inside it does not.
    await pointAt(page, SLOT, map.size, ...p.out)
    await expect(segments(page, SLOT, 'hover')).toHaveCount(1)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-segment', p.seg.id)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-kind', 'straight')
    // The outer half of the edge tile, just inside the outline, grabs it too.
    await pointAt(page, SLOT, map.size, ...p.edge)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-segment', p.seg.id)
    // Inside the edge line the pointer has the Object, not a segment.
    await pointAt(page, SLOT, map.size, ...p.deep)
    await expect(segments(page, SLOT)).toHaveCount(0)
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)
    expect(treeHash(projectDir)).toBe(before)
  })

  // Plant: pass `ctrl = false` to `selectAt` in `MapViewWidget.onStripClick` (Ctrl+click ignored): this goes red at
  // the second `toHaveCount(2)`.
  test('Ctrl+click selects two segments, from the inside half of the edge band', async ({
    page,
  }) => {
    const [first, second] = innerProbes(map, target)
    expect(first && second, 'two long straight sides with room inside them').toBeTruthy()
    await pointAt(page, SLOT, map.size, ...farPoint(map, target), 'click')
    // The inside half of the band hits the segment (a plain click selects just it).
    await pointAt(page, SLOT, map.size, ...first.edge)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-segment', first.seg.id)
    await pointAt(page, SLOT, map.size, ...first.edge, 'click')
    await expect(segments(page, SLOT, 'selected')).toHaveCount(1)
    await pointAt(page, SLOT, map.size, ...second.edge, 'click', ['Control'])
    await expect(segments(page, SLOT, 'selected')).toHaveCount(2)
    await expect(
      page.locator(
        `${overlay(SLOT)} [data-control="object-segment"][data-segment="${first.seg.id}"][data-state="selected"]`,
      ),
    ).toHaveCount(1)
    await expect(
      page.locator(
        `${overlay(SLOT)} [data-control="object-segment"][data-segment="${second.seg.id}"][data-state="selected"]`,
      ),
    ).toHaveCount(1)
    // A plain click on the second alone replaces the pair.
    await pointAt(page, SLOT, map.size, ...second.edge, 'click')
    await expect(segments(page, SLOT, 'selected')).toHaveCount(1)
  })
})

test.describe('a sloped ground Object', () => {
  // Plant: have the overlay write a fixed `data-kind="straight"` (object-overlay.tsx: `data-kind={s.kind}` becomes
  // `data-kind="straight"`): this goes red at the `data-kind` assertion. (Making Outline.ts emit only 'straight'
  // fails earlier, in the fixture, which finds the slope map from the same outline.)
  test('a slope segment answers inside the band and not deeper in or outside it', async ({
    page,
  }) => {
    const found = fixture.slopeCase(ROM)
    expect(found, 'a vanilla map with a sloped ground Object').toBeTruthy()
    saveDefinitions(found.definition)
    const SLOT = found.slot
    const map = await openMap(page, SLOT)
    const probeAt = slopeProbe(map)
    expect(probeAt, 'a slope segment with room inside and outside its outline').toBeTruthy()
    // Select the Object by a click where no segment reaches.
    await pointAt(page, SLOT, map.size, ...probeAt.deep, 'click')
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)
    // Inside the band: that segment, and it is a slope.
    await pointAt(page, SLOT, map.size, ...probeAt.edge)
    await expect(segments(page, SLOT, 'hover')).toHaveCount(1)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-segment', probeAt.seg.id)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-kind', 'slope')
    // Deeper inside the Object than the band: the Object body, no segment.
    await pointAt(page, SLOT, map.size, ...probeAt.deep)
    await expect(segments(page, SLOT)).toHaveCount(0)
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)
    // Outside the band and outside the Object: nothing answers.
    await pointAt(page, SLOT, map.size, ...probeAt.far)
    await expect(segments(page, SLOT)).toHaveCount(0)
    await expect(
      page.locator(`${overlay(SLOT)} [data-control="object"][data-state="hover"]`),
    ).toHaveCount(0)
  })
})

test('a map whose tiles are per level says Objects cannot be found there, in plain words', async ({
  page,
}) => {
  // The reply is replaced on the widget's own `projects` (a wrapper on the RPC proxy is never reached,
  // docs/testing.md "Playwright and RPC"); the server's own refusal is proven in MapObjects.test.ts.
  const WHY = "Objects can't be found on this map: it uses custom per-map tiles."
  await page.evaluate(
    async ({ mp, index, why }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      const real = w.projects
      w.projects = new Proxy(real, {
        get: (t, k) =>
          k === 'mapObjects'
            ? async () => ({ status: 'unavailable', reason: why })
            : typeof t[k] === 'function'
              ? t[k].bind(t)
              : t[k],
      })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index: 0x103, why: WHY },
  )
  await page.locator(`${rootOf(0x103)} [data-objects="unavailable"]`).waitFor({ timeout: 30000 })
  await expect(page.locator(`${rootOf(0x103)} [data-note="objects"]`)).toHaveText(WHY)
  // Nothing was found and nothing is drawn: the strip reports no Objects, and no overlay exists.
  await expect(page.locator(`${rootOf(0x103)} [data-objects="unavailable"]`)).toHaveAttribute(
    'data-object-count',
    '0',
  )
  await expect(page.locator(overlay(0x103))).toHaveCount(0)
})
