/**
 * Sprite $9C (the flying platform) draws the Hammer Bro it carries (#841).
 *
 * Map $006 (vanilla ROM): $9C at 1168,272 and its $9B at the same spot (list entries 10 and 11). The game's
 * platform code scans slots 0-9 for a $9B and draws it 16 px above itself (SMWDisX bank_02.asm:12118-12148,
 * HammerBroGfx 12044-12091: tiles at dy -24 to -8 from the bro, so rows y-24..y-17 are bro-only; the
 * platform's wings reach only y-10). The Mesen capture layers_v5/006 has 8 OAM entries for this sprite, the
 * bro's four at dy -16 and -24 (one machine). Checked from the node reply (mapSprites):
 * - the $9C bitmap reaches 24 px above its anchor and has opaque pixels in the bro-only rows;
 * - the $9B the platform picks up stays in the list, flagged `drawnBy` the platform, with the bro tiles as its area;
 *   asserted on the DTO (status drawn, `drawnBy`, no `reason`), not on canvas pixels (owner T16, 2026-10-17);
 * - the same for the $9C at 2176,272;
 * - on the canvas, maps $006 and $126: the pointer on an opaque bro pixel opens Theia's hover with the $9B's own
 *   name. On $126 the $9B (28) sorts under its $9C (29), so only the hit-precedence rule makes the hover name it.
 * Plant for the verifier: in `runOnce` (SpriteRunner.ts) return `a` before the neighbor run; the first
 * assertion goes red (box top at y-10, no bro rows).
 * NOT covered here: the exact tiles (the unit tests and spriteGrade.captures.test.ts grade them).
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
test.skip(!fs.existsSync(ROM), `vanilla ROM not present at ${ROM}`)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`
/** Generous bound on the bro area's width: two tiles each side of the anchor, far below a map screen. */
const BRO_MAX_WIDTH = 32
const rootOf = slot => `[id="hackbench.map-view:${slot}"]`
const stripOf = slot => `${rootOf(slot)} .hb-map-view-strip`
const opened = []
let tmp
let manifestPath

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hammer-bro-platform-'))
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

/** Opaque pixels of `s` in the rows y0 <= y < y1 (map pixels). */
function opaqueRows(s, y0, y1) {
  const rgba = Buffer.from(s.rgba, 'base64')
  const w = s.box.x1 - s.box.x0
  let n = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const y = s.box.y0 + Math.floor(i / 4 / w)
    if (rgba[i + 3] !== 0 && y >= y0 && y < y1) n++
  }
  return n
}

test('each $9C on map $006 draws the Hammer Bro above its platform, and its $9B is listed without a marker', async ({
  page,
}) => {
  const reply = await page.evaluate(
    ({ mp }) => getSvc('Symbol(ProjectService)').mapSprites(mp, 0x6),
    { mp: manifestPath },
  )
  expect(reply.status).toBe('ok')
  for (const [platformIndex, broIndex, x] of [
    [10, 11, 1168],
    [21, 22, 2176],
  ]) {
    const platform = reply.sprites.find(s => s.index === platformIndex)
    expect(platform.id).toBe(0x9c)
    expect(platform.status).toBe('drawn')
    expect([platform.x, platform.y]).toEqual([x, 272])
    // The bro's top tiles sit at dy -24; the platform's own parts reach no higher than dy -10.
    expect(platform.box.y0).toBe(272 - 24)
    expect(opaqueRows(platform, 272 - 24, 272 - 16)).toBeGreaterThan(0)
    // The $9B stays in the list (D52: a placed sprite can be selected and dragged) but has no marker: it is
    // flagged as drawn by the platform, its area is the bro tiles the platform drew (above the platform's own
    // wings), and its hover name is plain words. The view does not paint it a second time.
    const bro = reply.sprites.find(s => s.index === broIndex)
    expect(bro.id).toBe(0x9b)
    expect(bro.status).toBe('drawn')
    expect(bro.reason).toBeUndefined()
    expect(bro.drawnBy).toBe(platformIndex)
    expect(bro.parts.length).toBeGreaterThan(0)
    expect(bro.box.y0).toBe(272 - 24)
    expect(bro.box.y1).toBeLessThanOrEqual(272)
    expect(bro.box.x1 - bro.box.x0).toBeLessThan(BRO_MAX_WIDTH + 1)
    expect(opaqueRows(bro, 272 - 24, 272 - 16)).toBeGreaterThan(0)
    expect(bro.name).toMatch(/^[A-Za-z ]+$/)
    // No other sprite's box lies over the bro-only rows: nothing else is hit or painted there.
    const over = reply.sprites.filter(
      s => ![platformIndex, broIndex].includes(s.index) && s.box.x0 < x + 16 && s.box.x1 > x && s.box.y0 < 272 - 16 && s.box.y1 > 272 - 24, // prettier-ignore
    )
    expect(over.map(s => [s.index, s.id])).toEqual([])
    expect(platform.name).toMatch(/^[A-Za-z ]+$/)
  }
})

for (const { slot, broIndex, platformIndex } of [
  // $006: the $9B (11) sorts above its $9C (10). $126: it sorts below (28 under 29), the case the hit rule exists for.
  { slot: 0x6, broIndex: 11, platformIndex: 10 },
  { slot: 0x126, broIndex: 28, platformIndex: 29 },
]) {
  test(`the pointer on the Hammer Bro opens the hover of the $9B, not the platform (map $${slot.toString(16)}, T16, D52)`, async ({
    page,
  }) => {
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
      { mp: manifestPath, slot },
    )
    opened.push(`hackbench.map-view:${slot}`)
    await page.locator(stripOf(slot)).waitFor({ timeout: 30000 })
    const reply = await page.evaluate(
      ({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot),
      { mp: manifestPath, slot },
    )
    const bro = reply.sprites.find(s => s.index === broIndex)
    const platform = reply.sprites.find(s => s.index === platformIndex)
    // A bro pixel in the bro-only rows, with its 2 px neighborhood opaque in the bro bitmap too.
    const rgba = Buffer.from(bro.rgba, 'base64')
    const w = bro.box.x1 - bro.box.x0
    const solid = (x, y) => rgba[((y - bro.box.y0) * w + (x - bro.box.x0)) * 4 + 3] !== 0
    let at
    for (let y = bro.box.y0 + 2; y < platform.y - 16 && !at; y++)
      for (let x = bro.box.x0 + 2; x < bro.box.x1 - 2 && !at; x++)
        if ([-2, 0, 2].every(d => [-2, 0, 2].every(e => solid(x + d, y + e)))) at = { x, y }
    expect(at, 'an opaque bro pixel above the platform wings').toBeTruthy()
    const mapW = reply.width * reply.screenCount
    const mapH = reply.height
    const hover = async () => {
      const p = await page.evaluate(
        ({ strip, mapW, mapH, x, y }) => {
          const el = document.querySelector(strip)
          const sc = el.closest('[data-control="map-scroller"]')
          const pos = () => {
            const r = el.getBoundingClientRect()
            return {
              x: r.left + ((x + 0.5) * r.width) / mapW,
              y: r.top + ((y + 0.5) * r.height) / mapH,
            }
          }
          const [first, view] = [pos(), sc.getBoundingClientRect()]
          sc.scrollBy(
            first.x - (view.left + view.width / 2),
            first.y - (view.top + view.height / 2),
          )
          return pos()
        },
        { strip: stripOf(slot), mapW, mapH, x: at.x, y: at.y },
      )
      await page.mouse.move(p.x + 1, p.y)
      await page.mouse.move(p.x, p.y)
      return page.evaluate(() => {
        const h = document.querySelector('.theia-hover')
        return h && h.isConnected && h.matches(':popover-open') ? h.textContent : null
      })
    }
    // Behavior: the text the user reads is the $9B's name, and it differs from the platform's (else this proves nothing).
    expect(bro.name).not.toBe(platform.name)
    await expect.poll(hover, { timeout: 15000 }).toBe(bro.name)
  })
}
