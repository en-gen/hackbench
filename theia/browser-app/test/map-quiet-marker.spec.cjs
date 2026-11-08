/**
 * The quiet marker (#1011): placed items the game draws nothing for show a thin ring with a clear interior, not the
 * framed id box, and say why in plain words.
 *
 * Two parts. (1) Vanilla ROM, skipped without it: map $126 has sixteen $C9 shooters, all on Map16 tile $141 (the issue says twelve; the map data has sixteen). The node reply
 * marks each quiet with the shooter words; on the canvas the pixels INSIDE the ring equal the same pixels with the
 * sprite layer hidden (an opaque marker turns that red), while the ring pixels differ (a missing marker turns that red).
 * (2) No ROM: there is no route for a synthetic ROM into the project service (it needs a cart file on disk that the
 * level loader can run), so the closest equivalent is a canned `mapSprites` reply, as map-far-end-gutter.spec.cjs does:
 * a quiet scroll command whose bitmap is a ring, a center dot and a clear interior. It checks the VIEW: the hover text,
 * that the clear interior hovers and selects, the sprite canvas pixel by pixel, and the toggle's on/off look. The screen door and the priority are unit tests'. The real marker's own pixels are asserted by
 * test/suite/unit/QuietMarker.test.ts.
 *
 * Planted defects for the verifier (each turns the named case red):
 *   Q1 spriteLayer/opaqueAt in map-view-model.ts: drop the `status === 'quiet'` hit rule: the clear-interior hover and select cases.
 *   Q2 map-sprites.ts `ring()`: fill the interior (return an opaque 16 x 16): the $126 pixel case.
 *   Q3 spriteName: return `s.name` for a quiet sprite: both hover-text cases.
 *   Q5 spriteLayer in map-view-model.ts: skip DTOs with status 'quiet' when painting: the two canvas cases.
 *   Q4 map-sprites.ts `quiet(...)` returns `placeholder(...)`: the $126 DTO case.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
const SCROLL_TEXT = 'Scroll command: changes how the screen scrolls; it has no picture in the game'
const SHOOTER_TEXT = 'Bullet Bill Shooter: fires on a timer; nothing is drawn until it does'
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`

let pageErrors
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', e => pageErrors.push(String(e)))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

/** The page position of the map pixel (x, y), scrolling it to the middle of the view first; zoom is read from the strip. */
const locate = (page, slot, mapW, mapH, x, y) =>
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
    { edge: `${rootOf(slot)} [data-control="map-edge"]`, mapW, mapH, x, y },
  )

/** The text of Theia's open hover, or null when none is showing. */
const hoverText = page =>
  page.evaluate(() => {
    const h = document.querySelector('.theia-hover')
    return h && h.isConnected && h.matches(':popover-open') ? h.textContent : null
  })

/** Hovers the map pixel and returns the hover text. */
async function hoverAt(page, slot, mapW, mapH, x, y) {
  const p = await locate(page, slot, mapW, mapH, x, y)
  await page.mouse.move(p.x + p.z, p.y)
  await page.mouse.move(p.x + p.z / 2, p.y + p.z / 2)
  return p
}

test.describe('vanilla ROM, map $126', () => {
  test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)
  const SLOT = 0x126
  let tmp
  test.beforeEach(async ({ page }) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-quiet-marker-'))
    const project = await page.evaluate(
      ({ romPath, directory }) =>
        getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
      { romPath: ROM, directory: path.join(tmp, 'MyHack') },
    )
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
      { mp: project.manifestPath, slot: SLOT },
    )
    await page.locator(`${rootOf(SLOT)} .hb-map-view-strip`).waitFor({ timeout: 30000 })
    await page.locator(`${rootOf(SLOT)} [data-control="zoom-actual"]`).click()
    test.info().annotations.push({ type: 'mp', description: project.manifestPath })
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

  /** The node service's sprite reply for the map under test. */
  const reply = (page, mp) => page.evaluate(({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot), { mp, slot: SLOT }) // prettier-ignore
  const mpOf = () => test.info().annotations.find(a => a.type === 'mp').description

  test('every $C9 is the quiet marker with the shooter words, not the framed id box', async ({
    page,
  }) => {
    const r = await reply(page, mpOf())
    const c9 = r.sprites.filter(s => s.id === 0xc9)
    expect(c9.length).toBe(16)
    for (const s of c9) expect([s.status, s.kind, s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]).toEqual(['quiet', 'shooter', 16, 16]) // prettier-ignore
    // Acceptance 6: all of them stand on one Map16 tile, so they all show the same tile through the marker.
    const text = await (async () => {
      const s = c9[0]
      await hoverAt(page, SLOT, r.width * r.screenCount, r.height, s.x + 8, s.y + 8)
      await expect.poll(() => hoverText(page), { timeout: 15000 }).toBe(SHOOTER_TEXT)
      return await hoverText(page)
    })()
    expect(text).not.toMatch(/OAM|passes/)
  })

  test('the tile under a $C9 shows through the ring, and the ring itself is drawn', async ({
    page,
  }) => {
    const r = await reply(page, mpOf())
    for (const s of r.sprites.filter(x => x.id === 0xc9)) {
      const [mapW, mapH] = [r.width * r.screenCount, r.height]
      const toggle = page.locator(`${rootOf(SLOT)} [data-control="layer-sprites"]`)
      // One scroll position for both clips: `locate` scrolls the pixel to the middle of the view, so a second call
      // would move the first clip. The offsets inside the box are plain arithmetic on the zoom.
      const origin = await locate(page, SLOT, mapW, mapH, s.x, s.y)
      // The scroll repaints the canvases over a few frames; screenshots taken at once differ even with nothing changed
      // (seen on #42: on/on screenshots differed everywhere). The spec helpers offer no settled signal, so wait a fixed time.
      await page.waitForTimeout(1500)
      await page.mouse.move(0, 0)
      const clipOf = (lx, ly, w, h) => ({
        x: Math.round(origin.x + lx * origin.z),
        y: Math.round(origin.y + ly * origin.z),
        width: Math.round(w * origin.z),
        height: Math.round(h * origin.z),
      })
      // Local pixels x 3..5, y 7..8 are inside the ring (clear); x 1..2, y 7..8 are the ring and its edge.
      const shots = async () => {
        const [inside, ring] = [clipOf(3, 7, 3, 2), clipOf(0, 7, 3, 2)]
        return [await page.screenshot({ clip: inside }), await page.screenshot({ clip: ring })]
      }
      const [insideOn, ringOn] = await shots()
      await toggle.click()
      await page.waitForTimeout(500) // the layer repaint
      const [insideOff, ringOff] = await shots()
      expect(insideOn.equals(insideOff), 'the tile under the clear interior is unchanged').toBe(
        true,
      )
      expect(ringOn.equals(ringOff), 'the ring pixels differ from the bare tile').toBe(false)
      await toggle.click()
    }
  })
})

/**
 * The canned marker's shape on its 16 x 16 bitmap, as the real one is: a ring, a 2 x 2 dot at the center, and a clear
 * interior between them. `ringAlpha(x, y)` is 255 on the ring and the dot and 0 elsewhere; the bitmap and the checks
 * share it, so a change to the shape cannot make one of them stale.
 */
const ringAlpha = (x, y) => {
  const d = Math.hypot(x - 7.5, y - 7.5)
  return (d >= 5.5 && d <= 7.2) || (x >= 7 && x <= 8 && y >= 7 && y <= 8) ? 255 : 0
}

test.describe('no ROM: a canned quiet scroll command', () => {
  const INDEX = 0x7f1
  const [X, Y] = [64, 64]
  test.afterEach(async ({ page }) => {
    await page.evaluate(
      i =>
        getSvc('ApplicationShell')
          .closeWidget('hackbench.map-view:' + i)
          .then(
            () => undefined,
            () => undefined,
          ), // not the widget: page.evaluate must serialize the result
      INDEX,
    )
    expect(pageErrors).toEqual([])
  })

  /** Opens a synthetic map holding one canned quiet scroll command at (X, Y). */
  async function open(page) {
    await page.evaluate(
      async ({ index, x, y, alphaSrc }) => {
        const alpha = new Function(`return (${alphaSrc})`)()
        const box = { x0: x, y0: y, x1: x + 16, y1: y + 16 }
        // A ring with a center dot and a clear interior, as the real marker's: hit-testing by opaque pixel would miss the interior.
        const px = new Uint8Array(16 * 16 * 4)
        for (let yy = 0; yy < 16; yy++)
          for (let xx = 0; xx < 16; xx++) {
            if (alpha(xx, yy)) px.set([235, 235, 235, 255], (yy * 16 + xx) * 4)
          }
        const rgba = btoa(String.fromCharCode(...px))
        const sprites = [{ index: 900, id: 0xe8, x, y, box, rgba, status: 'quiet', kind: 'scroll', reason: 'the loader treats it as a scroll' }] // prettier-ignore
        const canned = {
          mapStart: () => ({ status: 'ok', x: 100, y: 100 }),
          mapScreen: (_m, _i, screen) => ({
            status: 'ok', screen, screenCount: 1, orientation: 'horizontal', width: 256, height: 432,
            planes: { l2Low: null, l1Low: null, l2High: null, l1High: null, l3Low: null, l3High: null },
            layer3: { priority: false, reason: null }, screens: { main: ['l1Low'], sub: [] },
            math: null, layer2Interactive: false, layerNotes: [], backdrop: [0, 0, 0],
          }), // prettier-ignore
          mapSprites: () => ({ status: 'ok', orientation: 'horizontal', screenCount: 1, width: 256, height: 432, sprites }), // prettier-ignore
        }
        const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
        w.projects = new Proxy({}, { get: (_t, k) => async (...a) => canned[k]?.(...a) ?? { status: 'unavailable', reason: 'synthetic map' } }) // prettier-ignore
        await w.open({ manifestPath: 'synthetic.hbproj', index, label: 'synthetic', iconClass: '' })
        const shell = getSvc('ApplicationShell')
        await shell.addWidget(w, { area: 'main' })
        await shell.activateWidget(w.id)
      },
      { index: INDEX, x: X, y: Y, alphaSrc: ringAlpha.toString() },
    )
    await expect.poll(() => page.evaluate(i => getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: i }).then(w => w.spritesVersion > 0 && !!w.sprites), INDEX), { timeout: 30000 }).toBe(true) // prettier-ignore
    await page.locator(`${rootOf(INDEX)} [data-control="zoom-actual"]`).click()
    await page.waitForTimeout(500)
  }

  test('hovering the clear interior says what a scroll command is, in plain words', async ({
    page,
  }) => {
    await open(page)
    // (X+4, Y+7) is clear in the bitmap: a hit-by-opaque-pixel rule would miss it.
    await hoverAt(page, INDEX, 256, 432, X + 4, Y + 7)
    await expect.poll(() => hoverText(page), { timeout: 15000 }).toBe(SCROLL_TEXT)
  })

  test('clicking the clear interior selects the sprite', async ({ page }) => {
    await open(page)
    const p = await locate(page, INDEX, 256, 432, X + 4, Y + 7)
    await page.mouse.click(p.x + p.z / 2, p.y + p.z / 2)
    await expect
      .poll(
        () =>
          page.evaluate(
            i =>
              getSvc('WidgetManager')
                .getOrCreateWidget('hackbench.map-view', { index: i })
                .then(w => w.selectedSprite?.index),
            INDEX,
          ),
        { timeout: 15000 },
      ) // prettier-ignore
      .toBe(900)
  })

  test('the sprite canvas holds the ring, the dot and a clear interior, from the canned reply alone', async ({
    page,
  }) => {
    await open(page)
    // The poll only waits for the first paint (data-drawn is set whenever the canvas has sprites). The check that goes red
    // for a spriteLayer that skips scroll commands is the pixel compare below: the canvas would hold none of the marker.
    await expect.poll(() => page.locator(`${rootOf(INDEX)} canvas[data-plane="sprites"][data-screen="0"][data-drawn]`).count(), { timeout: 15000 }).toBeGreaterThan(0) // prettier-ignore
    const alphas = await page.evaluate(
      ({ root, x, y }) => {
        const c = document.querySelector(
          `${root} canvas[data-plane="sprites"][data-screen="0"][data-drawn]`,
        )
        const d = c.getContext('2d').getImageData(x, y, 16, 16).data
        return Array.from({ length: 256 }, (_, i) => d[i * 4 + 3])
      },
      { root: rootOf(INDEX), x: X, y: Y },
    )
    const want = Array.from({ length: 256 }, (_, i) => ringAlpha(i % 16, Math.floor(i / 16)))
    expect(alphas, 'ring, dot and clear interior, pixel by pixel').toEqual(want)
    expect(want.filter(a => a).length, 'the fixture has a ring and a dot').toBeGreaterThan(20)
    expect(want[4 * 16 + 7], 'a pixel inside the ring is clear').toBe(0)
  })

  test('the sprite layer toggle changes the dot and the ring on screen, not the clear interior (the #1011 look)', async ({
    page,
  }) => {
    await open(page)
    const toggle = page.locator(`${rootOf(INDEX)} [data-control="layer-sprites"]`)
    const origin = await locate(page, INDEX, 256, 432, X, Y)
    await page.waitForTimeout(1500) // the scroll repaints over a few frames
    await page.mouse.move(0, 0)
    const clip = (lx, ly, w, h) => ({
      x: Math.round(origin.x + lx * origin.z),
      y: Math.round(origin.y + ly * origin.z),
      width: Math.round(w * origin.z),
      height: Math.round(h * origin.z),
    })
    const shots = async () => [
      await page.screenshot({ clip: clip(7, 7, 2, 2) }), // the dot
      await page.screenshot({ clip: clip(7, 1, 2, 1) }), // the ring
      await page.screenshot({ clip: clip(3, 7, 2, 1) }), // inside the ring
    ]
    const [dotOn, ringOn, insideOn] = await shots()
    let off = false
    let dotOff, ringOff, insideOff
    try {
      await toggle.click()
      off = true
      await page.waitForTimeout(500) // the layer repaint
      ;[dotOff, ringOff, insideOff] = await shots()
    } finally {
      if (off) await toggle.click() // a failure in the wait or the screenshots must not leave the layer hidden
    }
    expect(dotOn.equals(dotOff), 'the center pixel differs with the layer on').toBe(false)
    expect(ringOn.equals(ringOff), 'the ring differs with the layer on').toBe(false)
    expect(insideOn.equals(insideOff), 'an interior pixel is the bare map either way').toBe(true)
  })
})
