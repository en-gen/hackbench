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
async function pointAt(page, slot, size, x, y, action = 'move', modifiers = []) {
  const p = await page.evaluate(
    ({ strip, size, x, y }) => {
      const el = document.querySelector(strip)
      const sc = el.closest('[data-control="map-scroller"]')
      const at = () => {
        const r = el.getBoundingClientRect()
        return { x: r.left + (x * r.width) / size.w, y: r.top + (y * r.height) / size.h }
      }
      const [first, view] = [at(), sc.getBoundingClientRect()]
      sc.scrollBy(first.x - (view.left + view.width / 2), first.y - (view.top + view.height / 2))
      return at()
    },
    { strip: stripOf(slot), size, x, y },
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
      .find(o => probe(map, o, 'straight'))
    expect(
      target,
      'a platform on screen 0 with a straight side clear of sprites and other Objects',
    ).toBeTruthy()
  })

  test('one click selects the whole Object: one outline, one tint, no per-tile boxes; clicking outside clears it', async ({
    page,
  }) => {
    expect(map.objects.filter(o => o.runs.every(r => (r.col + r.len) * TILE <= 256))).toHaveLength(
      4,
    )
    const before = treeHash(projectDir)
    const run = target.runs[0]
    const inside = [(run.col + 0.5) * TILE, (run.row + 0.5) * TILE]
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
    const run = target.runs[0]
    await pointAt(page, SLOT, map.size, (run.col + 0.5) * TILE, (run.row + 0.5) * TILE, 'click')
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

  test('Ctrl+click selects two segments', async ({ page }) => {
    const first = probe(map, target, 'straight', 0)
    const next = [1, 2, 3, 4, 5, 6, 7, 8]
      .map(i => probe(map, target, 'straight', i))
      .find(c => c && c.seg.id !== first.seg.id)
    expect(next, 'a second straight segment with clear air outside').toBeTruthy()
    const run = target.runs[0]
    await pointAt(page, SLOT, map.size, (run.col + 0.5) * TILE, (run.row + 0.5) * TILE, 'click')
    await pointAt(page, SLOT, map.size, ...first.out, 'click')
    await expect(segments(page, SLOT, 'selected')).toHaveCount(1)
    await pointAt(page, SLOT, map.size, ...next.out, 'click', ['Control'])
    await expect(segments(page, SLOT, 'selected')).toHaveCount(2)
    // A plain click on the second alone replaces the pair.
    await pointAt(page, SLOT, map.size, ...next.out, 'click')
    await expect(segments(page, SLOT, 'selected')).toHaveCount(1)
  })
})

test.describe('a sloped ground Object', () => {
  test('a segment is found outside a slope run and not inside it', async ({ page }) => {
    const found = fixture.slopeCase(ROM)
    expect(found, 'a vanilla map with a sloped ground Object').toBeTruthy()
    saveDefinitions(found.definition)
    const SLOT = found.slot
    const map = await openMap(page, SLOT)
    const target = map.objects.find(
      o => o.segments.some(s => s.kind === 'slope') && probe(map, o, 'slope'),
    )
    expect(target, 'an Object with a slope segment that has clear air outside').toBeTruthy()
    const p = probe(map, target, 'slope')
    const inside = target.runs[0]
    await pointAt(
      page,
      SLOT,
      map.size,
      (inside.col + 0.5) * TILE,
      (inside.row + 0.5) * TILE,
      'click',
    )
    await expect(selectedObjects(page, SLOT)).toHaveCount(1)
    await pointAt(page, SLOT, map.size, ...p.out)
    await expect(segments(page, SLOT, 'hover')).toHaveCount(1)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-kind', 'slope')
    await pointAt(page, SLOT, map.size, ...p.edge)
    await expect(segments(page, SLOT, 'hover')).toHaveAttribute('data-kind', 'slope')
    await pointAt(page, SLOT, map.size, ...p.deep)
    await expect(segments(page, SLOT)).toHaveCount(0)
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
  // Nothing responds: a click where an Object would be selects nothing.
  await page.locator(stripOf(0x103)).click({ position: { x: 100, y: 200 } })
  await expect(page.locator(overlay(0x103))).toHaveCount(0)
})
