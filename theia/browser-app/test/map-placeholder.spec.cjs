/**
 * Placeholder slots in the map tree (#901): every slot is listed, the ones that
 * only hold the shared placeholder room show as dimmed orphans, and the tooltip
 * says so. Counts are read from the ROM's own pointer table by the tree, never
 * fixed here; this spec asserts behaviour on rows a user can see and click.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
/** A slot whose Layer 1 pointer is vanilla's shared placeholder room. */
const PLACEHOLDER_SLOT = 0x025
/** Generous: the point is "responsive with 512 rows", not a tuned budget. */
const EXPAND_BUDGET_MS = 5000

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
}`

let tmp
test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-placeholder-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Creates a project on vanilla with no seeded groups and loads the Maps tree. */
async function load(page) {
  const dir = path.join(tmp, 'MyHack')
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: ROM, directory: dir },
  )
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta', 'groups.json'), '[]\n')
  // Opening the project wires listenForMapOpens, as File > Open does; load() alone does not.
  await page.evaluate(mp => getSvc('HackBenchContribution').openPath(mp), manifestPath)
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  }, manifestPath)
  await page.waitForTimeout(800)
}

/**
 * A real orphan (a map nothing reaches, not a placeholder) and an entry map, both read from
 * the model so no ROM-specific slot is hardcoded: on vanilla $0DC is a sub area, not an orphan.
 */
async function pickRows(page) {
  return page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const kids = w.model.root.children.find(r => r.id === 'group:unassigned').children
    return {
      orphan: kids.find(n => n.category === 'orphan' && n.sharedCount === undefined)?.index,
      entry: kids.find(n => n.category === 'entry')?.index,
    }
  })
}

/** Scrolls a row into view by focusing it (the tree virtualises), returns its locator. */
async function rowOf(page, index) {
  const id = await page.evaluate(async slot => {
    const w = await getWidget('hackbench.map-explorer')
    const group = w.model.root.children.find(r => r.id === 'group:unassigned')
    const node = group.children.find(n => n.index === slot)
    w.focusService.setFocus(undefined)
    w.focusService.setFocus(node)
    w.updateScrollToRow()
    return node.id
  }, index)
  await page.waitForTimeout(400)
  return page.locator(`[id="hackbench.map-explorer"] .theia-TreeNode[data-node-id="${id}"]`)
}

test('the orphan group lists every slot, and the placeholders are counted apart', async ({
  page,
}) => {
  await load(page)
  const tree = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const group = w.model.root.children.find(r => r.id === 'group:unassigned')
    const shared = group.children.filter(n => n.sharedCount !== undefined)
    return {
      label: group.name,
      placeholders: shared.length,
      counts: [...new Set(shared.map(n => n.sharedCount))],
      mapCount: w.mapCount,
      slots: new Set(
        w.model.root.children
          .flatMap(function walk(n) {
            return [n, ...(n.children || []).flatMap(walk)]
          })
          .map(n => n.index)
          .filter(i => i >= 0),
      ).size,
    }
  })

  // Every row carries the figure the ROM reports, and the label shows it apart from the maps.
  expect(tree.placeholders).toBeGreaterThan(0)
  expect(tree.counts).toEqual([tree.placeholders])
  expect(tree.label).toContain(`${tree.placeholders} placeholder`)
  expect(tree.mapCount + tree.placeholders).toBe(tree.slots)
  expect(tree.slots).toBe(512)
})

test('a placeholder row is dimmed with the shared-room tooltip; a real orphan is not given it', async ({
  page,
}) => {
  await load(page)
  const { orphan, entry } = await pickRows(page)
  expect(orphan).toBeDefined()
  expect(entry).toBeDefined()

  const row = await rowOf(page, PLACEHOLDER_SLOT)
  const title = await row.getAttribute('title')
  expect(title).toContain('Not reached from the overworld')
  expect(title).toMatch(/uses the shared placeholder room, which \d+ slots share/)

  // Dimming asserted by what the user sees: computed opacity, against a row that is reached.
  const opacityOf = loc => loc.evaluate(el => parseFloat(getComputedStyle(el).opacity))
  const placeholderOpacity = await opacityOf(row)
  const entryOpacity = await opacityOf(await rowOf(page, entry))
  expect(entryOpacity).toBe(1)
  expect(placeholderOpacity).toBeLessThan(entryOpacity)

  const real = await rowOf(page, orphan)
  expect(await real.getAttribute('title')).not.toContain('placeholder')
})

test('a placeholder row cannot be added to a group; a real orphan can', async ({ page }) => {
  await load(page)
  const { orphan } = await pickRows(page)
  const can = await page.evaluate(
    async ({ slot, real }) => {
      const w = await getWidget('hackbench.map-explorer')
      const kids = w.model.root.children.find(r => r.id === 'group:unassigned').children
      const pick = i => {
        w.model.selectNode(kids.find(n => n.index === i))
        return w.canAddToGroup()
      }
      return { placeholder: pick(slot), real: pick(real) }
    },
    { slot: PLACEHOLDER_SLOT, real: orphan },
  )
  expect(can).toEqual({ placeholder: false, real: true })
})

test('expanding the orphan group with every slot in it stays responsive', async ({ page }) => {
  await load(page)
  const ms = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const group = w.model.root.children.find(r => r.id === 'group:unassigned')
    await w.model.collapseNode(group)
    const t0 = performance.now()
    await w.model.expandNode(group)
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const elapsed = performance.now() - t0
    // Slots listed elsewhere: other folders' rows and the sub areas nested under an entry map here.
    const all = n => [n, ...(n.children || []).flatMap(all)]
    // De-duplicated: a sub area can sit under two roots but is one slot.
    const placed = new Set(
      [
        ...w.model.root.children.filter(r => r.id !== 'group:unassigned').flatMap(all),
        ...group.children.flatMap(c => (c.children || []).flatMap(all)),
      ]
        .filter(n => n.index >= 0)
        .map(n => n.index),
    ).size
    return { elapsed, expanded: group.expanded, children: group.children.length, placed }
  })
  console.log(`#901 expand time with every slot listed: ${ms.elapsed.toFixed(0)} ms`)
  // Guards against the budget passing because the group was left unexpanded: it is expanded,
  // and its top-level rows number at least the slots not listed elsewhere.
  expect(ms.expanded).toBe(true)
  expect(ms.children).toBeGreaterThanOrEqual(512 - ms.placed)
  expect(ms.elapsed).toBeLessThan(EXPAND_BUDGET_MS)
  await expect(page.locator('[id="hackbench.map-explorer"] .theia-TreeNode').first()).toBeVisible()
})

test('opening a placeholder row opens the map view for its slot', async ({ page }) => {
  await load(page)
  const row = await rowOf(page, PLACEHOLDER_SLOT)
  await row.dblclick()
  const view = page.locator(`[id="hackbench.map-view:${PLACEHOLDER_SLOT}"]`)
  await expect(view).toBeVisible({ timeout: 30000 })
  // Loaded for $025, not just a blank panel: the strip is drawn and the tab names the slot.
  await expect(view.locator('.hb-map-view-strip')).toBeVisible({ timeout: 30000 })
  // The strip can paint before the load settles: wait for the loaded state (`details`, set when
  // the header read returns; $025 has no block indicators) before asserting no error.
  const viewId = `hackbench.map-view:${PLACEHOLDER_SLOT}`
  await page.waitForFunction(
    id => getSvc('ApplicationShell').getWidgetById(id)?.details !== undefined,
    viewId,
    { timeout: 60000 },
  )
  await expect(view.locator('[data-control="map-error"]')).toHaveCount(0)
  const caption = await page.evaluate(
    id => getSvc('ApplicationShell').getWidgetById(id).title.caption,
    viewId,
  )
  expect(caption).toContain('$025')
})
