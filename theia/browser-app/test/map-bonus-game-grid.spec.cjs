/**
 * #998, D158 / Decision 124 A: the bonus game sprite ($82) on maps $000 and $100 draws its 3 x 3 grid of
 * blocks at the game's fixed map positions, not at the list entry (column 5, row 7 = map pixel 80,112).
 * The game's own setup code writes the nine blocks (SMWDisX bank_01.asm:12681-12707).
 *
 * Read from the sprite plane canvas the view paints (not only from the RPC reply): the nine block centres
 * are opaque, the list spot is not. Hover names the sprite, a click on a block selects it and the Properties
 * panel shows its list column and row, and the map's sprite note line carries the plain-words note.
 * Not covered: dragging. No sprite drag exists in the map view yet, so the "does not follow a drag" half of
 * the ruling is future behavior (docs/decisions/2026-11-03-bonus-game-grid-fixed-positions.md).
 * Vanilla ROM; skipped, never faked, without it.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
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
/** The list entry, in map pixels, and the blocks' centres: columns 88, 128, 168 and rows 248, 288, 328. */
const LIST_SPOT = { x: 88, y: 120 }
const CENTRES = [248, 288, 328].flatMap(y => [88, 128, 168].map(x => ({ x, y })))
const NOTE = 'The game lays this sprite out itself, at fixed spots of the map; it does not follow where the list places it.' // prettier-ignore

let tmp
let manifestPath
const opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bonus-grid-'))
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
const edgeOf = slot => `${rootOf(slot)} [data-control="map-edge"]`

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
  await page.locator(edgeOf(slot)).waitFor({ timeout: 30000 })
  const reply = await page.evaluate(
    ({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSprites(mp, slot),
    { mp: manifestPath, slot },
  )
  expect(reply.status).toBe('ok')
  return {
    sprite: reply.sprites.find(s => s.id === 0x82),
    mapW: reply.width * reply.screenCount,
    mapH: reply.height,
  }
}

/** Alpha of the sprite plane canvas of screen 0 at map pixel (x, y); -1 when the canvas is not painted. */
const planeAlpha = (page, slot, x, y) =>
  page.evaluate(
    ({ root, x, y }) => {
      const c = document.querySelector(`${root} canvas[data-screen="0"][data-plane="sprites"]`)
      if (!c) return -1
      return c.getContext('2d').getImageData(x, y, 1, 1).data[3]
    },
    { root: rootOf(slot), x, y },
  )

/** Scrolls map pixel (x, y) to the middle of the view and returns its client position. */
const clientOf = (page, slot, map, x, y) =>
  page.evaluate(
    ({ edge, mapW, mapH, x, y }) => {
      const el = document.querySelector(edge)
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
    { edge: edgeOf(slot), mapW: map.mapW, mapH: map.mapH, x, y },
  )

for (const [label, slot] of [
  ['$000', 0x000],
  ['$100', 0x100],
]) {
  test(`map ${label}: the grid stands at the game's block spots and nothing is drawn at the list spot`, async ({
    page,
  }) => {
    const map = await openMap(page, slot)
    expect(map.sprite, 'the $82 sprite is in the reply').toBeTruthy()
    expect(map.sprite.status).toBe('drawn')
    expect([map.sprite.x, map.sprite.y]).toEqual([80, 112])
    for (const c of CENTRES)
      await expect
        .poll(() => planeAlpha(page, slot, c.x, c.y), {
          message: `block centre ${c.x},${c.y}`,
          timeout: 30000,
        })
        .toBe(255)
    expect(await planeAlpha(page, slot, LIST_SPOT.x, LIST_SPOT.y), 'nothing at the list spot').toBe(
      0,
    )
  })

  test(`map ${label}: hover names the sprite, a click selects it with its list column and row, the note line says the game lays it out`, async ({
    page,
  }) => {
    const map = await openMap(page, slot)
    const block = CENTRES[4]
    await expect.poll(() => planeAlpha(page, slot, block.x, block.y), { timeout: 30000 }).toBe(255)
    const p = await clientOf(page, slot, map, block.x, block.y)
    await page.mouse.move(p.x + 1, p.y)
    await page.mouse.move(p.x, p.y)
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (() => {
              const h = document.querySelector('.theia-hover')
              return h && h.isConnected && h.matches(':popover-open') ? h.textContent : null
            })(),
          ),
        { timeout: 30000 },
      )
      .toBe(map.sprite.name)
    await page.mouse.click(p.x, p.y)
    const panel = page.locator('[id="hackbench.properties"]')
    await expect(panel).toBeVisible()
    await expect(panel.locator('[data-field="position"]')).toHaveText('Column 5, row 7')
    await expect(page.locator(`${rootOf(slot)} [data-note="sprites"]`)).toHaveText(NOTE)
  })
}
