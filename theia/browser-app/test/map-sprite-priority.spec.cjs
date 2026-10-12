/**
 * A sprite drawn at OAM priority 1 goes behind layer 1's low tiles (#795), and what a tile covers is
 * not hidden: the sprite pixel draws through the tile in the hidden-tile screen door (D52, parts 1 to 3).
 * Before #795 every sprite pixel sat at one slot, over l1Low, so a Jumping Piranha Plant drew over the
 * pipe it rises from.
 *
 * Case (vanilla ROM, one machine, 2026-10-10): map $105, screen 7. 236 opaque sprite pixels there meet
 * an opaque l1Low pixel (with no l1High pixel); they are sprite index 11 (id $4F), which the
 * interpreter's OAM gives priority 1. Found by sweeping all 512 vanilla maps with the node-side
 * `mapSprites` and `mapScreen`. The same probe measured 376 sprite pixels over no layer 1 on that
 * screen, all priority 2 pixels of OTHER sprites; they are the control that the composite draws
 * sprites at all.
 *
 * The check: at the overlap pixels the composite with sprites shown is NOT the one with them hidden
 * (the plant shows through the pipe), each pixel blends the sprite colour into the pipe at one of two
 * strengths (full, or HIDDEN_TILE_DIM_ALPHA = 0.25), and horizontal neighbours alternate between the
 * two (the checkerboard on the sprite's own grid; its phase is not asserted here, the unit tests pin
 * it). Strengths are read back from the pixels with a tolerance, because the map's colour math may
 * move a channel. At the control pixels hiding the sprites changes every pixel. Plants for the
 * verifier: in theia/extension/src/node/map-sprites.ts `blit`, `prio[at1] = 2` instead of the part's
 * priority puts the plant over the pipe, so every pixel is at full strength (the "both squares of the
 * door are used" assertion goes red; the overlap count is not what fails); in
 * src/rom/model/ColorMath.ts `coveredSprite`, `return null` leaves the plant hidden (the "differs from
 * the hidden composite" assertion goes red).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { PAGE_COMPOSE } = require('./pixel-canvas.cjs')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
// Named skip when the ROM is absent (docs/testing.md).
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const SLOT = 0x105
const SCREEN = 7
const MIN_BEHIND = 200 // measured 236; a floor, so a placement tweak does not turn this red
const MIN_SHOWN = 300 // measured 376

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-sprite-priority-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.addScriptTag({ content: PAGE_COMPOSE })
})

test.afterEach(async ({ page }) => {
  await page.evaluate(async ids => {
    const shell = getSvc('ApplicationShell')
    for (const id of ids) {
      try {
        await shell.closeWidget(id)
      } catch {
        /* already closed */
      }
    }
  }, opened.splice(0))
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

const root = `[id="hackbench.map-view:${SLOT}"]`
const plane = p => `${root} canvas[data-screen="${SCREEN}"][data-plane="${p}"]`

/** The composite's RGBA at `pixels` (flat indices), and, with none given, which pixels to watch. */
function probe(page, pixels) {
  return page.evaluate(
    ({ rootSel, sel, screen, pixels }) => {
      const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      const comp = px(planesOf(rootSel, screen)[0])
      const read = ps => ps.map(p => [0, 1, 2, 3].map(k => comp[p * 4 + k]).join(','))
      const width = planesOf(rootSel, screen)[0].width
      if (pixels) return { width, behind: read(pixels.behind), shown: read(pixels.shown) }
      const [sprites, low, high] = [sel.sprites, sel.low, sel.high].map(s => px(document.querySelector(s))) // prettier-ignore
      const all = [...Array(sprites.length / 4).keys()].filter(p => sprites[p * 4 + 3] === 255 && high[p * 4 + 3] === 0) // prettier-ignore
      const at = { behind: all.filter(p => low[p * 4 + 3] === 255), shown: all.filter(p => low[p * 4 + 3] === 0) } // prettier-ignore
      const spriteRgb = at.behind.map(p => [0, 1, 2].map(k => sprites[p * 4 + k]))
      return { width, at, spriteRgb, behind: read(at.behind), shown: read(at.shown) }
    },
    {
      rootSel: root,
      sel: { sprites: plane('sprites'), low: plane('l1Low'), high: plane('l1High') },
      screen: SCREEN,
      pixels,
    },
  )
}

/** Opens map $105 with the sprites drawn on screen 7. */
async function openMap(page) {
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: path.join(tmp, 'MyHack') },
  )
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: project.manifestPath, index: SLOT },
  )
  opened.push(`hackbench.map-view:${SLOT}`)
  await page.locator(plane('l1Low')).evaluate(el => el.scrollIntoView({ inline: 'start', block: 'nearest' })) // prettier-ignore
  await expect(page.locator(plane('l1Low'))).toHaveAttribute('data-drawn', /^\d+:0000:000:7$/, { timeout: 30000 }) // prettier-ignore
  await expect(page.locator(plane('sprites'))).toHaveAttribute('data-drawn', /^\d+:\d+$/, { timeout: 30000 }) // prettier-ignore
}

test('a priority 1 sprite draws behind layer 1 low tiles: the pipe covers the piranha plant', async ({
  page,
}) => {
  await openMap(page)

  const on = await probe(page)
  expect(on.at.behind.length, 'the plant overlaps the pipe here').toBeGreaterThanOrEqual(MIN_BEHIND) // prettier-ignore
  expect(
    on.at.shown.length,
    'other sprites on the screen draw over no layer 1 (the control)',
  ).toBeGreaterThanOrEqual(MIN_SHOWN)

  // Hide the sprites: the composite is redrawn without them.
  const toggle = page.locator(`${root} [data-control="layer-sprites"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(async () => (await probe(page, on.at)).shown.filter((c, i) => c !== on.shown[i]).length, {
      timeout: 15000,
    }) // prettier-ignore
    .toBe(on.at.shown.length)
  const off = await probe(page, on.at)

  const same = (a, b) => a.filter((c, i) => c === b[i]).length
  const rgb = c => c.split(',').slice(0, 3).map(Number)
  // Each pixel: the share of the sprite colour in it, from the channel where sprite and pipe differ most.
  const strength = on.at.behind.map((p, i) => {
    const [got, hid, spr] = [rgb(on.behind[i]), rgb(off.behind[i]), on.spriteRgb[i]]
    const k = [0, 1, 2].reduce(
      (m, c) => (Math.abs(spr[c] - hid[c]) > Math.abs(spr[m] - hid[m]) ? c : m),
      0,
    )
    return spr[k] === hid[k] ? null : (got[k] - hid[k]) / (spr[k] - hid[k])
  })
  const known = strength.filter(v => v !== null)
  expect(known.length, 'the sprite colour differs from the pipe at most overlap pixels').toBeGreaterThan(on.at.behind.length / 2) // prettier-ignore
  expect(
    on.at.behind.length - same(on.behind, off.behind),
    'the plant shows through the pipe: the composite differs from the sprites-hidden one',
  ).toBeGreaterThan(on.at.behind.length / 2)
  const TOL = 0.2
  const full = v => Math.abs(v - 1) < TOL
  const dim = v => Math.abs(v - 0.25) < TOL
  expect(
    known.every(v => full(v) || dim(v)),
    'every pixel is at full strength or the 25% dim',
  ).toBe(true)
  const [nFull, nDim] = [known.filter(full).length, known.filter(dim).length]
  expect(Math.min(nFull, nDim) / known.length, 'both squares of the door are used, about half each').toBeGreaterThan(0.3) // prettier-ignore
  let pairs = 0
  let alternating = 0
  on.at.behind.forEach((p, i) => {
    const j = on.at.behind.indexOf(p + 1)
    if (j < 0 || p % on.width === on.width - 1 || strength[i] === null || strength[j] === null)
      return
    pairs++
    if (full(strength[i]) !== full(strength[j])) alternating++
  })
  expect(pairs, 'horizontal neighbours inside the plant to compare').toBeGreaterThan(50)
  expect(alternating / pairs, 'neighbours alternate between the two strengths: a checkerboard').toBeGreaterThan(0.95) // prettier-ignore
  expect(
    same(on.shown, off.shown),
    'the control: every other-sprite pixel over no layer 1 shows',
  ).toBe(0)
})

/** The composite's native pixel `p` in client coordinates, scrolled into view. */
async function clientOf(page, p) {
  return page.evaluate(
    ({ rootSel, screen, p }) => {
      const c = planesOf(rootSel, screen)[0]
      c.scrollIntoView({ inline: 'center', block: 'center' })
      const r = c.getBoundingClientRect()
      return { x: r.left + (((p % c.width) + 0.5) * r.width) / c.width, y: r.top + ((Math.floor(p / c.width) + 0.5) * r.height) / c.height } // prettier-ignore
    },
    { rootSel: root, screen: SCREEN, p },
  )
}

test('hovering a hidden sprite draws it opaque, leaving restores the door exactly, an uncovered sprite is unchanged (#879)', async ({
  page,
}) => {
  await openMap(page)
  const on = await probe(page)
  const behind = on.at.behind
  const [plantPixel, otherPixel] = [behind[behind.length >> 1], on.at.shown[on.at.shown.length >> 1]] // prettier-ignore
  const read = () => probe(page, on.at)
  const rgb = c => c.split(',').slice(0, 3).map(Number)
  const same = (a, b) => a.filter((c, i) => c === b[i]).length
  const before = await read()
  // The composites' cache keys: a hover that lifts nothing must not repaint any screen (S1/S3). The plant's
  // covered pixels all sit on SCREEN here, so a second-screen lift is not asserted (nothing to invent).
  const drawn = () => page.locator(`${root} .hb-map-view-composite`).evaluateAll(cs => cs.map(c => c.dataset.drawn)) // prettier-ignore
  // Scroll to the sprite first: scrollIntoView paints screens that were unpainted, which is not a hover paint.
  const other = await clientOf(page, otherPixel)
  let last = ''
  await expect.poll(async () => { const now = JSON.stringify(await drawn()); const settled = now === last; last = now; return settled }, { timeout: 15000 }).toBe(true) // prettier-ignore
  const drawnBefore = await drawn()
  expect(drawnBefore.length, 'composites to compare').toBeGreaterThan(0)
  // Hover an uncovered sprite: nothing the plant or the other sprites show changes.
  await page.mouse.move(other.x, other.y)
  await page.waitForTimeout(500)
  const hoverOther = await read()
  expect(await drawn(), 'an uncovered hover repaints no screen').toEqual(drawnBefore)
  expect(same(hoverOther.behind, before.behind), 'the covered plant is untouched').toBe(behind.length) // prettier-ignore
  expect(same(hoverOther.shown, before.shown), 'the uncovered sprite is untouched').toBe(on.at.shown.length) // prettier-ignore

  // Hover the plant: its covered pixels turn to the sprite colour, both squares of the door.
  const plant = await clientOf(page, plantPixel)
  await page.mouse.move(plant.x, plant.y)
  // A lift changes only the dim squares of the door (full ones are already at the sprite colour), so about half
  // the pixels change, not all; the rest of the check is the sprite colour everywhere below.
  await expect.poll(async () => behind.length - same((await read()).behind, before.behind), { timeout: 15000 }).toBeGreaterThanOrEqual(behind.length * 0.3) // prettier-ignore
  const lifted = await read()
  const sameAsSprite = behind.filter((_, i) => rgb(lifted.behind[i]).every((v, k) => Math.abs(v - on.spriteRgb[i][k]) <= 8)).length // prettier-ignore
  expect(sameAsSprite / behind.length, 'the plant draws at the sprite colour over the pipe').toBe(1) // prettier-ignore
  expect(same(lifted.shown, before.shown), 'the uncovered sprite still unchanged').toBe(on.at.shown.length) // prettier-ignore

  // Leave: the door pixels come back byte for byte.
  await page.mouse.move(2, 2)
  await expect.poll(async () => same((await read()).behind, before.behind), { timeout: 15000 }).toBe(behind.length) // prettier-ignore
  expect((await read()).shown).toEqual(before.shown)
})
