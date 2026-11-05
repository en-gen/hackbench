/* global unassigned */
/**
 * Slots in the Maps tree (#949, D155, D156). Every slot is listed. A slot that shares the ROM's most
 * common pointer is an ordinary Unassigned map: no mark, no special tooltip, counted as a map, it opens
 * as a map and a group can take it. A slot with no usable pointer is "New": labelled, ungroupable, and it
 * opens an empty view with a note. A slot whose pointer is fine but whose data cannot be read stays a
 * map and warns.
 *
 * Vanilla and the corpus have no unpointed slot, so those tests run on a copy of vanilla patched at run
 * time in a temp dir (three pointer-table entries changed). That goes through the real server
 * (buildMapTree classifies the slots), unlike an RPC intercept, which would only exercise the widget.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
/** A slot whose Layer 1 pointer is vanilla's most common one, shared with 276 others. */
const SHARED_SLOT = 0x025
/** Slots patched in the copy: a zero pointer, one outside the ROM file, one too near the end to hold a header. */
const NEW_ZERO = 0x1f0
const NEW_OUTSIDE = 0x1f1
const UNREADABLE = 0x1f2
/** The Layer 1 pointer table in the file (SNES $05E000, LoROM, no copier header). */
const L1_TABLE = 0x2e000
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
}
async function unassigned() {
  const w = await getWidget('hackbench.map-explorer')
  return { w, group: w.model.root.children.find(r => r.id === 'group:unassigned') }
}`

let tmp
test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-slots-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Vanilla with three pointer-table entries rewritten, written to the temp dir. */
function patchedRom() {
  const bytes = fs.readFileSync(ROM)
  const header = bytes.length % 1024 === 512 ? 512 : 0
  const size = bytes.length - header
  const set = (slot, ptr) => {
    const at = header + L1_TABLE + slot * 3
    bytes[at] = ptr & 0xff
    bytes[at + 1] = (ptr >> 8) & 0xff
    bytes[at + 2] = ptr >> 16
  }
  expect(bytes[header + L1_TABLE + 0x105 * 3 + 2], 'fixture: the table is where it is said to be').not.toBe(0) // prettier-ignore
  // The last four bytes of the ROM as a LoROM address: valid, but one short of a level header.
  const tail = size - 4
  set(NEW_ZERO, 0)
  set(NEW_OUTSIDE, 0x7e8000)
  set(UNREADABLE, ((tail >> 15) << 16) | 0x8000 | (tail & 0x7fff))
  const out = path.join(tmp, 'patched.sfc')
  fs.writeFileSync(out, bytes)
  return out
}

/** Creates a project on `rom` with no seeded groups and loads the Maps tree. */
async function load(page, rom = ROM) {
  const dir = path.join(tmp, 'MyHack')
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: rom, directory: dir },
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

/** Scrolls a row into view by focusing it (the tree virtualises), returns its locator. */
async function rowOf(page, index) {
  const id = await page.evaluate(async slot => {
    const { w, group } = await unassigned()
    const node = group.children.find(n => n.index === slot)
    w.focusService.setFocus(undefined)
    w.focusService.setFocus(node)
    w.updateScrollToRow()
    return node.id
  }, index)
  await page.waitForTimeout(400)
  return page.locator(`[id="hackbench.map-explorer"] .theia-TreeNode[data-node-id="${id}"]`)
}

test('slots sharing the most common pointer are ordinary maps, counted as maps', async ({
  page,
}) => {
  await load(page)
  const tree = await page.evaluate(async () => {
    const { w, group } = await unassigned()
    return {
      label: group.name,
      rows: group.children.length,
      marked: group.children.filter(n => n.noPointer || n.unreadable).length,
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

  // Acceptance 4: on vanilla every slot is a map, and the label carries just the row count.
  expect(tree.label).toBe(`Unassigned (${tree.rows})`)
  expect(tree.label).not.toMatch(/placeholder|New/)
  expect(tree.marked).toBe(0)
  expect(tree.mapCount).toBe(512)
  expect(tree.slots).toBe(512)
})

test('a shared-pointer row has the plain orphan tooltip and dimming, nothing about a placeholder', async ({
  page,
}) => {
  await load(page)
  const row = await rowOf(page, SHARED_SLOT)
  expect(await row.getAttribute('title')).toBe('Not reached from the overworld')
  expect(await row.innerText()).not.toMatch(/placeholder|New/i)

  // Dimming asserted by what the user sees: computed opacity, against a row that is reached.
  const entry = await page.evaluate(async () => {
    const { group } = await unassigned()
    return group.children.find(n => n.category === 'entry')?.index
  })
  expect(entry).toBeDefined()
  const opacityOf = loc => loc.evaluate(el => parseFloat(getComputedStyle(el).opacity))
  expect(await opacityOf(await rowOf(page, entry))).toBe(1)
  expect(await opacityOf(row)).toBeLessThan(1)
})

test('a shared-pointer row can be added to a group, and then sits in the group (D156)', async ({
  page,
}) => {
  await load(page)
  const result = await page.evaluate(async slot => {
    const { w, group } = await unassigned()
    w.model.selectNode(group.children.find(n => n.index === slot))
    const can = w.canAddToGroup()
    await w.addSelectionToGroup('Shared')
    await new Promise(r => setTimeout(r, 800))
    const roots = w.model.root.children
    const grouped = roots.find(r => r.id === 'group:user:Shared')
    const left = roots.find(r => r.id === 'group:unassigned')
    return {
      can,
      inGroup: (grouped?.children || []).map(n => n.index),
      stillUnassigned: left.children.some(n => n.index === slot),
    }
  }, SHARED_SLOT)
  expect(result).toEqual({ can: true, inGroup: [SHARED_SLOT], stillUnassigned: false })
})

test('expanding the orphan group with every slot in it stays responsive', async ({ page }) => {
  await load(page)
  const ms = await page.evaluate(async () => {
    const { w, group } = await unassigned()
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

test('opening a shared-pointer row opens an ordinary map, not the New view', async ({ page }) => {
  await load(page)
  const row = await rowOf(page, SHARED_SLOT)
  await row.dblclick()
  const view = page.locator(`[id="hackbench.map-view:${SHARED_SLOT}"]`)
  await expect(view).toBeVisible({ timeout: 30000 })
  // Loaded for $025, not just a blank panel: the strip is drawn and the tab names the slot.
  await expect(view.locator('.hb-map-view-strip')).toBeVisible({ timeout: 30000 })
  // The strip can paint before the load settles: wait for the loaded state (`details`, set when
  // the header read returns; $025 has no block indicators) before asserting no error.
  const viewId = `hackbench.map-view:${SHARED_SLOT}`
  await page.waitForFunction(
    id => getSvc('ApplicationShell').getWidgetById(id)?.details !== undefined,
    viewId,
    { timeout: 60000 },
  )
  await expect(view.locator('[data-control="map-error"]')).toHaveCount(0)
  await expect(view.locator('[data-control="map-new-note"]')).toHaveCount(0)
  const caption = await page.evaluate(
    id => getSvc('ApplicationShell').getWidgetById(id).title.caption,
    viewId,
  )
  expect(caption).toContain('$025')
})

test('New slots: the folder counts them apart, the row says New in plain words', async ({
  page,
}) => {
  await load(page, patchedRom())
  const info = await page.evaluate(async () => {
    const { w, group } = await unassigned()
    const rows = group.children
    return {
      label: group.name,
      fresh: rows.filter(n => n.noPointer).map(n => n.index),
      unreadable: rows.filter(n => n.unreadable).map(n => n.index),
      maps: rows.filter(n => !n.noPointer).length,
      mapCount: w.mapCount,
    }
  })
  // Both the zero pointer and the one outside the file are New; the near-the-end one is still a map.
  expect(info.fresh).toEqual([NEW_ZERO, NEW_OUTSIDE])
  expect(info.unreadable).toEqual([UNREADABLE])
  expect(info.label).toBe(`Unassigned (${info.maps}, 2 New)`)
  // The map count includes the slot that only fails to read, and not the two New ones.
  expect(info.mapCount).toBe(510)

  for (const slot of [NEW_ZERO, NEW_OUTSIDE]) {
    const row = await rowOf(page, slot)
    await expect(row.locator('[data-control="map-new"]')).toHaveText('New')
    const title = await row.getAttribute('title')
    expect(title).toBe('New: nothing has been added to this slot yet')
    expect(title).not.toMatch(/\$|0x|pointer/i)
  }
})

test('opening a New slot shows an empty view with one plain note and no error', async ({
  page,
}) => {
  await load(page, patchedRom())
  const row = await rowOf(page, NEW_ZERO)
  await row.dblclick()
  const view = page.locator(`[id="hackbench.map-view:${NEW_ZERO}"]`)
  await expect(view).toBeVisible({ timeout: 30000 })
  await expect(view.locator('[data-control="map-new-note"]')).toHaveText(
    'This slot is new. It has no map yet.',
  )
  await expect(view.locator('[data-control="map-error"]')).toHaveCount(0)
  await expect(view.locator('.hb-map-view-strip')).toHaveCount(0)
})

test('a New slot cannot be added to a group; the near-the-end map can', async ({ page }) => {
  await load(page, patchedRom())
  const can = await page.evaluate(
    async slots => {
      const { w, group } = await unassigned()
      const pick = index => {
        const node = group.children.find(n => n.index === index)
        w.model.selectNode(node)
        return { add: w.canAddToGroup(), groupable: w.groupable(node) }
      }
      return Object.fromEntries(Object.entries(slots).map(([k, i]) => [k, pick(i)]))
    },
    { zero: NEW_ZERO, outside: NEW_OUTSIDE, unreadable: UNREADABLE },
  )
  expect(can).toEqual({
    zero: { add: false, groupable: false },
    outside: { add: false, groupable: false },
    unreadable: { add: true, groupable: true },
  })
})

test('a map whose data cannot be read stays a map: the row warns, opening it says so', async ({
  page,
}) => {
  await load(page, patchedRom())
  const row = await rowOf(page, UNREADABLE)
  expect(await row.getAttribute('title')).toBe("This map's data could not be read")
  await expect(row.locator('.codicon-warning')).toHaveCount(1)
  await expect(row.locator('[data-control="map-new"]')).toHaveCount(0)

  await row.dblclick()
  const view = page.locator(`[id="hackbench.map-view:${UNREADABLE}"]`)
  await expect(view).toBeVisible({ timeout: 30000 })
  // The existing reply, not a blank and not the New view.
  await expect(view.locator('[data-control="map-error"]')).toContainText('could not be read', {
    timeout: 30000,
  })
  await expect(view.locator('[data-control="map-new-note"]')).toHaveCount(0)
})
