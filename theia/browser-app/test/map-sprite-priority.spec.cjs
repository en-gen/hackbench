/**
 * A sprite drawn at OAM priority 1 goes behind layer 1's low tiles (#795). Before #795 every sprite
 * pixel sat at one slot, over l1Low, so a Jumping Piranha Plant drew over the pipe it rises from.
 *
 * Case (vanilla ROM, one machine, 2026-10-10): map $105, screen 7. All 236 opaque sprite pixels
 * there that meet an opaque l1Low pixel (with no l1High pixel) are sprite index 11 (id $4F), which
 * the interpreter's OAM gives priority 1. Found by sweeping all 512 vanilla maps with the
 * node-side `mapSprites` and `mapScreen`: 50 maps change their composite, $105 is the one the
 * other map-view specs already open. The same probe measured 376 sprite pixels over no layer 1
 * on that screen, all of which the sprite changes.
 *
 * The check: at every such overlap pixel the composite with sprites shown equals the composite
 * with them hidden (the pipe covers the plant), while at the sprite-only pixels it does not (the
 * sprite is drawn). Plant for the verifier: in theia/extension/src/node/map-sprites.ts `blit`,
 * `prio[at1] = 2` instead of the part's priority should turn the first assertion red (0 of 236).
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
      if (pixels) return { behind: read(pixels.behind), shown: read(pixels.shown) }
      const [sprites, low, high] = [sel.sprites, sel.low, sel.high].map(s => px(document.querySelector(s))) // prettier-ignore
      const all = [...Array(sprites.length / 4).keys()].filter(p => sprites[p * 4 + 3] === 255 && high[p * 4 + 3] === 0) // prettier-ignore
      const at = { behind: all.filter(p => low[p * 4 + 3] === 255), shown: all.filter(p => low[p * 4 + 3] === 0) } // prettier-ignore
      return { at, behind: read(at.behind), shown: read(at.shown) }
    },
    {
      rootSel: root,
      sel: { sprites: plane('sprites'), low: plane('l1Low'), high: plane('l1High') },
      screen: SCREEN,
      pixels,
    },
  )
}

test('a priority 1 sprite draws behind layer 1 low tiles: the pipe covers the piranha plant', async ({
  page,
}) => {
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

  const on = await probe(page)
  expect(on.at.behind.length, 'the plant overlaps the pipe here').toBeGreaterThanOrEqual(MIN_BEHIND) // prettier-ignore
  expect(on.at.shown.length, 'and shows above it').toBeGreaterThanOrEqual(MIN_SHOWN)

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
  expect(same(on.behind, off.behind), 'behind the pipe the sprite changes no pixel').toBe(on.at.behind.length) // prettier-ignore
  expect(same(on.shown, off.shown), 'above the pipe every sprite pixel shows').toBe(0)
})
