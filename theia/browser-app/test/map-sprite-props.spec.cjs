/**
 * #984: clicking a placed sprite on the map view shows it in the Properties side panel (read only).
 *
 * The expected values come from the node reply's own DTO (`mapSprites`), the data the map view draws from, so
 * a part count or palette row the panel gets wrong cannot agree with the map by construction. Sprites are
 * picked by sweeping that reply, not hardcoded. Animation (acceptance 2): `mapSpriteFrames` (an on-demand
 * RPC, see docs/architecture/theia-shell.md, Properties view) says which sprites have 2 or more distinct
 * poses; the panel must loop those (canvas pixels change) and say "not animated" for the rest.
 * Vanilla ROM; skipped without it.
 */
const { test, expect } = require('@playwright/test')
const { createHash } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x105
// Maps swept when SLOT has no animated sprite to click: the RPC picks, never an id.
const SWEEP = [SLOT, 0x0c7, 0x0c8, 0x0c9, 0x0ca, 0x0cb, 0x101, 0x102, 0x103, 0x104]
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
const stripOf = slot => `${rootOf(slot)} .hb-map-view-strip`
const panel = page => page.locator('[id="hackbench.properties"]')
const hex = id => '$' + id.toString(16).toUpperCase().padStart(2, '0')

/** A hash of every file under the project folder: the working copy lives there, so a write anywhere changes it. */
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
  return { reply, stack, own, click, emptyPixel }
}

test('clicking a sprite opens the Properties panel with its id, name, position, parts and palette rows; another click updates it; empty ground clears it', async ({
  page,
}) => {
  const map = await openMap(page)
  const drawn = map.stack.filter(s => s.status === 'drawn' && s.parts && s.name && map.own(s))
  // Two sprites with different ids, so "updates" cannot pass on a stale panel.
  const a = drawn[0]
  const b = drawn.find(s => s.id !== a.id)
  expect(a && b, 'two distinct named, drawn sprites on the map').toBeTruthy()
  const before = await fetchSprites(page)
  const hashBefore = treeHash(projectDir)

  // The frames RPC runs the interpreter on demand: it must not write either, whether the panel or a test asks.
  for (const s of [a, b]) await framesOf(page, s)

  for (const s of [a, b]) {
    const at = map.own(s)
    await map.click(at.x, at.y)
    const p = panel(page)
    await expect(p).toBeVisible()
    await expect(p.locator('[data-field="label"]')).toHaveText(`${s.name} (sprite ${hex(s.id)})`)
    await expect(p.locator('[data-field="id"]')).toHaveText(hex(s.id))
    await expect(p.locator('[data-field="name"]')).toHaveText(s.name)
    await expect(p.locator('[data-field="position"]')).toHaveText(
      `Column ${Math.floor(s.x / 16)}, row ${Math.floor(s.y / 16)}`,
    )
    // The map view's own list: same part count, same palette rows.
    await expect(p.locator('[data-field="parts"] li')).toHaveCount(s.parts.length)
    const rows = [...new Set(s.parts.map(x => x.palette))].sort((m, n) => m - n).join(', ')
    await expect(p.locator('[data-field="palette-rows"]')).toHaveText(rows)
    expect(await p.locator('[data-control="sprite-composite"]').count()).toBe(1)
    // The click's own frames request has finished before the hash is taken.
    await expect(p.locator('[data-field="animation"]')).not.toContainText('Checking')
  }

  const e = map.emptyPixel()
  expect(e, 'a clear pixel on the map').toBeTruthy()
  await map.click(e.x, e.y)
  await expect(panel(page).locator('[data-subject="none"]')).toHaveText('No sprite selected')

  // Read only: nothing was written, and the map's sprites are the same afterwards.
  expect(treeHash(projectDir)).toBe(hashBefore)
  expect(await fetchSprites(page)).toEqual(before)
})

const framesOf = (page, s, slot = SLOT) =>
  page.evaluate(
    ({ mp, slot, i }) => getSvc('Symbol(ProjectService)').mapSpriteFrames(mp, slot, i),
    { mp: manifestPath, slot, i: s.index },
  )

/** The first map in SWEEP with both an animated and a one-pose sprite, found by the frames RPC alone. */
async function mapWithAnimation(page) {
  for (const slot of SWEEP) {
    const r = await fetchSprites(page, slot)
    if (r.status !== 'ok') continue
    let [animated, still] = [false, false]
    for (const s of r.sprites.filter(x => x.status === 'drawn' && x.parts && !x.fixedTo)) {
      const f = await framesOf(page, s, slot)
      if (f.status !== 'ok') continue
      if (f.frames.length >= 2) animated = true
      else if (!f.reason) still = true // a reason says "Animation not shown", not "Not animated"
      if (animated && still) return slot
    }
  }
  return undefined
}

test('an animated sprite loops on the panel canvas; a one-pose sprite says it is not animated', async ({
  page,
}) => {
  const slot = await mapWithAnimation(page)
  expect(slot, 'a vanilla map with an animated and a one-pose sprite').toBeDefined()
  const map = await openMap(page, slot)
  const hashBefore = treeHash(projectDir)
  const clickable = map.stack.filter(s => s.status === 'drawn' && s.parts && map.own(s))
  // Found by asking the RPC for every clickable sprite, never by id: the map decides which have frames.
  let animated
  let still
  for (const s of clickable) {
    const r = await framesOf(page, s, slot)
    if (r.status !== 'ok') continue
    if (r.frames.length >= 2) animated ??= s
    else if (!r.reason) still ??= s
    if (animated && still) break
  }
  expect(animated && still, 'one animated and one single-pose sprite on the map').toBeTruthy()

  const at = map.own(animated)
  await map.click(at.x, at.y)
  const canvas = panel(page).locator('[data-control="sprite-composite"]')
  await expect(panel(page).locator('[data-field="animation"]')).toContainText('Animated')
  // The loop steps every ~133 ms; sample over 2 s, since two samples a few hundred ms apart can land on one pose.
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    seen.add(await canvas.evaluate(c => c.toDataURL()))
    await page.waitForTimeout(170)
  }
  expect(seen.size, 'the canvas shows at least two different poses').toBeGreaterThanOrEqual(2)

  const at2 = map.own(still)
  await map.click(at2.x, at2.y)
  await expect(panel(page).locator('[data-field="animation"]')).toContainText('Not animated')
  const a = await canvas.evaluate(c => c.toDataURL())
  await page.waitForTimeout(400)
  expect(await canvas.evaluate(c => c.toDataURL())).toBe(a)
  // Looping ran the frames RPC for every click above: still read only.
  expect(treeHash(projectDir)).toBe(hashBefore)
})

test('closing the map clears the panel; the toggle command reopens a closed panel', async ({
  page,
}) => {
  const map = await openMap(page)
  const s = map.stack.find(x => x.status === 'drawn' && x.parts && map.own(x))
  const at = map.own(s)
  await map.click(at.x, at.y)
  await expect(panel(page).locator('[data-subject="sprite"]')).toBeVisible()
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').closeWidget(id)
  }, `hackbench.map-view:${SLOT}`)
  await expect(panel(page).locator('[data-subject="none"]')).toHaveText('No sprite selected')

  await page.evaluate(async id => {
    await getSvc('ApplicationShell').closeWidget(id)
  }, 'hackbench.properties')
  await expect(panel(page)).toHaveCount(0)
  await page.evaluate(async () => {
    await getSvc('CommandRegistry').executeCommand('hackbench.properties.toggle')
  })
  await expect(panel(page)).toBeVisible()
})

/** Clicks the first named, drawn sprite the map owns; returns it. */
async function selectOne(page, map) {
  const s = map.stack.find(x => x.status === 'drawn' && x.parts && map.own(x))
  expect(s, 'a drawn sprite to click').toBeTruthy()
  const at = map.own(s)
  await map.click(at.x, at.y)
  await expect(panel(page).locator('[data-subject="sprite"]')).toBeVisible()
  return s
}
// Plant: delete `this.selectSprite(undefined)` from toggleSprites and the panel keeps the hidden sprite.
test('hiding the sprites with the S toggle clears the panel', async ({ page }) => {
  const map = await openMap(page)
  await selectOne(page, map)
  await page.locator(`${rootOf(SLOT)} [data-control="layer-sprites"]`).click()
  await expect(panel(page).locator('[data-subject="none"]')).toHaveText('No sprite selected')
})

// Opening a second MAP would run that map's onActivateRequest, which publishes "none" on its own and hides the
// first map's onAfterHide sync from this test. So the tab goes to a plain non-map widget in the same area:
// only the first map's hide and show hooks can change the panel.
// Plants (each must turn this test red): delete `this.syncSelection()` from onAfterHide (the sprite stays on
// the panel while the map is hidden); delete it from onAfterShow (the sprite is not restored on return). Both
// plants proved red, the unplanted run green, 2026-10-17, one machine.
test('hiding the map tab (to a non-map widget) clears the panel; showing it again restores the sprite', async ({
  page,
}) => {
  const first = await openMap(page)
  const s = await selectOne(page, first)
  const label = `${s.name} (sprite ${hex(s.id)})`
  await page.evaluate(
    async ({ mapIndex }) => {
      const shell = getSvc('ApplicationShell')
      const map = getSvc('WidgetManager').tryGetWidget('hackbench.map-view', { index: mapIndex })
      let c = map
      while (c && c.constructor.name !== '_Widget' && c.constructor.name !== 'Widget') c = Object.getPrototypeOf(c) // prettier-ignore
      const other = new c.constructor()
      other.id = 'hb-test-plain-widget'
      other.title.label = 'Plain'
      other.title.closable = true
      await shell.addWidget(other, { area: 'main', ref: map, mode: 'tab-after' })
      await shell.activateWidget(other.id)
    },
    { mapIndex: SLOT },
  )
  await expect(page.locator(rootOf(SLOT))).toBeHidden()
  await expect(panel(page).locator('[data-subject="none"]')).toHaveText('No sprite selected')
  // revealWidget shows the tab without activating it, so only onAfterShow (not onActivateRequest) can restore.
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').revealWidget(id)
  }, `hackbench.map-view:${SLOT}`)
  await expect(panel(page).locator('[data-field="label"]')).toHaveText(label)
})

// Plant: delete `this.selectSprite(undefined)` from loadSprites and the old selection survives a reload.
test('a sprite reload (an edit or refresh) clears the panel', async ({ page }) => {
  const map = await openMap(page)
  await selectOne(page, map)
  await page.evaluate(index => {
    // refresh() is what a project edit calls; it is protected in TypeScript only.
    getSvc('WidgetManager').tryGetWidget('hackbench.map-view', { index }).refresh()
  }, SLOT)
  await expect(panel(page).locator('[data-subject="none"]')).toHaveText('No sprite selected')
})
