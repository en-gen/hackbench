/**
 * SPIKE (#946, not for merge): an entry map drawn with its sub areas on one canvas.
 *
 * For each level the sub areas come from the `mapSubAreas` RPC, and the page is
 * checked against the DTO, not against itself: each region's data-offset-x/y equals
 * the DTO's, the alignment axis equals exit minus landing (computed here), the side
 * is on the right side of the entry map, the on-screen box sits at the offset (at the
 * widget's 0.5 scale), and the region's canvas holds drawn pixels.
 *
 * Levels (vanilla ROM): $00B down pipe, $0BE up pipe, $107 door.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const GAP = 32
const SCALE = 0.5

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
let opened = []

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-subareas-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
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

async function createProject(page, dir) {
  return page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'MyHack', directory }),
    { romPath: ROM, directory: dir },
  )
}

/** Opens the map tab, then runs the palette command on it; returns the combined view's root selector. */
async function showWithSubAreas(page, manifestPath, index) {
  await page.evaluate(
    async ({ mp, index }) => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index })
      await w.open({ manifestPath: mp, index, label: index.toString(16), iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
      await getSvc('CommandRegistry').executeCommand('hackbench.mapView.showWithSubAreas')
    },
    { mp: manifestPath, index },
  )
  opened.push(`hackbench.map-view:${index}`, `hackbench.map-subareas:${index}`)
  return `[id="hackbench.map-subareas:${index}"]`
}

const CASES = [
  { slot: 0x0b, name: 'down pipe', kinds: ['below'] },
  { slot: 0xbe, name: 'up pipe', kinds: ['above'] },
  { slot: 0x107, name: 'door', kinds: ['beside'] },
]

for (const c of CASES) {
  test(`$${c.slot.toString(16)} (${c.name}): sub areas sit where the RPC says, aligned, with pixels`, async ({
    page,
  }) => {
    test.setTimeout(180000)
    const project = await createProject(page, tmp)
    const dto = await page.evaluate(
      ({ mp, slot }) => getSvc('Symbol(ProjectService)').mapSubAreas(mp, slot),
      { mp: project.manifestPath, slot: c.slot },
    )
    expect(dto.ok).toBe(true)
    expect(dto.subAreas.length).toBeGreaterThan(0)
    expect(dto.subAreas.map(s => s.kind)).toEqual(expect.arrayContaining(c.kinds))

    const root = await showWithSubAreas(page, project.manifestPath, c.slot)
    const regions = page.locator(`${root} [data-subarea-slot]`)
    await expect(regions).toHaveCount(dto.subAreas.length)
    await expect(page.locator(`${root} [data-entry-slot][data-ready="true"]`)).toHaveCount(1, { timeout: 120000 }) // prettier-ignore
    await expect(page.locator(`${root} [data-subarea-slot][data-ready="true"]`)).toHaveCount(dto.subAreas.length, { timeout: 120000 }) // prettier-ignore
    await expect(page.locator(`${root} [data-notes] li`).first()).toBeVisible()

    const entryBox = await page.locator(`${root} [data-entry-slot]`).boundingBox()
    for (const s of dto.subAreas) {
      const region = page.locator(`${root} [data-subarea-slot="${s.slot}"]`)
      expect(Number(await region.getAttribute('data-offset-x'))).toBe(s.offsetX)
      expect(Number(await region.getAttribute('data-offset-y'))).toBe(s.offsetY)
      expect(await region.getAttribute('data-kind')).toBe(s.kind)

      // Alignment and side, from the DTO's own exit and landing points.
      if (s.kind === 'beside') {
        expect(s.offsetY).toBe(s.exitPx.y - s.landingPx.y)
        expect(s.offsetX).toBeGreaterThanOrEqual(dto.entry.widthPx + GAP)
      } else {
        expect(s.offsetX).toBe(s.exitPx.x - s.landingPx.x)
        if (s.kind === 'below') expect(s.offsetY).toBeGreaterThanOrEqual(dto.entry.heightPx + GAP)
        else expect(s.offsetY).toBeLessThanOrEqual(-(s.heightPx + GAP))
      }

      // The box really is drawn at the offset from the entry map's box.
      const box = await region.boundingBox()
      expect(box.x - entryBox.x).toBeCloseTo(s.offsetX * SCALE, 0)
      expect(box.y - entryBox.y).toBeCloseTo(s.offsetY * SCALE, 0)

      // The canvas holds a picture, not the backdrop.
      const drawn = await region.locator('canvas').evaluate(cv => {
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
        let n = 0
        for (let i = 3; i < d.length; i += 4) if (d[i]) n++
        return { n, total: cv.width * cv.height }
      })
      expect(drawn.n).toBeGreaterThan(drawn.total * 0.01)
      // A faint connector joins the exit and this sub area's landing point.
      await expect(page.locator(`${root} line[data-connector-slot="${s.slot}"]`)).toHaveCount(1)
    }
  })
}
