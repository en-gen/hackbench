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
/** A slot holding a real map of its own, to show the sentence is not on every row. */
const REAL_SLOT = 0x0dc
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
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  }, manifestPath)
  await page.waitForTimeout(800)
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
  const row = await rowOf(page, PLACEHOLDER_SLOT)
  await expect(row).toHaveClass(/hb-map-row-orphan/)
  const title = await row.getAttribute('title')
  expect(title).toContain('Not reached from the overworld')
  expect(title).toMatch(/uses the shared placeholder room, which \d+ slots share/)

  const real = await rowOf(page, REAL_SLOT)
  expect(await real.getAttribute('title')).not.toContain('placeholder')
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
    return performance.now() - t0
  })
  console.log(`#901 expand time with every slot listed: ${ms.toFixed(0)} ms`)
  expect(ms).toBeLessThan(EXPAND_BUDGET_MS)
  await expect(page.locator('[id="hackbench.map-explorer"] .theia-TreeNode').first()).toBeVisible()
})

test('opening a placeholder row opens the map view for its slot', async ({ page }) => {
  await load(page)
  const row = await rowOf(page, PLACEHOLDER_SLOT)
  await row.dblclick()
  await expect(page.locator(`[id="hackbench.map-view:${PLACEHOLDER_SLOT}"]`)).toBeVisible({
    timeout: 30000,
  })
})
