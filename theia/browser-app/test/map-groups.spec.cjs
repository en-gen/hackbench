/**
 * Map groups: named virtual folders over the map explorer, driven through the
 * real UI: real clicks (with modifiers), a real right-click context menu, a
 * real QuickPick and dialog, and a real HTML5 drag. Tree CONTENTS are still
 * read back through the widget's model (the tree virtualises, so only
 * visible rows exist in the DOM; the model is the source of truth the rows
 * are drawn from), matching load-maps.spec.cjs's own house style.
 *
 * There is no separate Overworld folder: every top-level map not in a user
 * group, entry map or orphan alike, is Unassigned, sorted by slot.
 *
 * Rows are found by `data-node-id` (map-explorer-widget.tsx puts the tree
 * node's own id on every row), never by slot text: the SAME slot can appear
 * twice in the tree, once as a sub area under its entry map and once as a
 * top-level row of its own (an entry map that is independently flagged as
 * its own overworld level, per src/rom/MapTree.ts), and text search finds
 * whichever copy happens to be rendered first. Node ids are unique per tree
 * POSITION, so they do not have this problem.
 *
 * The tree starts from a known SMALL state for every test but the seeding
 * one: meta/groups.json is written as `[]` before the load, and the widget's
 * own collapseAll() folds every top-level folder down to its header row, so
 * the rows a test needs are near the top rather than scrolled hundreds of
 * rows deep. Fixture nodes (which orphan, which entry map, which of ITS sub
 * areas is not also a top-level row elsewhere) are read from the loaded
 * model at runtime, never hardcoded, since they are ROM-derived.
 *
 * Bringing a specific row into view uses the tree's OWN reveal mechanism
 * (TreeFocusService + TreeWidget.updateScrollToRow, see tree-widget.tsx:
 * a focus change schedules a scroll-to-row, and Virtuoso's scrollToRow prop
 * change scrolls it into view), not manual wheel scrolling: a virtualised
 * list only renders rows Virtuoso has decided to mount, and hunting for one
 * by scrolling blind is what produced earlier timeouts.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, MAGIC, INVICTUS } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
/**
 * A real hack, so its header-stripped hash is provably NOT the vanilla one.
 * `Super Mario World (USA).magic.sfc` (a Lunar Magic RESAVE of the stock
 * cart) would look right at a glance but is stock SMW with a copier header:
 * its header-stripped sha256 IS the vanilla hash, so it correctly seeds.
 */
const HACK_ROM = romPath(INVICTUS)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  const wm = getSvc('WidgetManager')
  return wm.getOrCreateWidget(id)
}`

const EXPLORER = '#hackbench\\.map-explorer'

let tmp

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-groups-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function revealMaps(page) {
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  })
  await page.waitForTimeout(800)
}

/**
 * Create a project, reveal the explorer, and load it. `seedEmpty` writes
 * meta/groups.json = [] first, so a vanilla ROM does not seed: every test
 * but the seeding one wants a small, predictable, ROM-derived tree instead.
 */
async function openProject(page, dir, { rom = ROM, seedEmpty = true } = {}) {
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: rom, directory: dir },
  )
  if (seedEmpty) {
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta', 'groups.json'), '[]\n')
  }
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    // Folds every top-level folder to its header row, so the rows a test
    // needs next are near the top instead of hundreds of rows deep.
    await w.collapseAll()
  }, manifestPath)
  await revealMaps(page)
  return manifestPath
}

/** The one structural folder keeps a fixed id; any other name is a user group. */
function folderId(name) {
  if (name === 'Unassigned') return 'group:unassigned'
  return `group:user:${name}`
}

/** A snapshot of the tree's model, keyed the way the tests need it. */
async function snapshot(page) {
  return page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const walk = n => [n, ...(n.children || []).flatMap(walk)]
    const roots = w.model.root.children || []
    const byId = id => roots.find(r => r.id === id)
    // The model's own `name` carries a trailing count ("8. Star World (5)"),
    // added for the row label; the bare group name is everything before it.
    const bareName = n => (n.name || '').replace(/ \(\d+\)$/, '')
    const unassignedChildren = byId('group:unassigned')?.children || []
    return {
      rootIds: roots.map(r => r.id),
      userGroups: roots
        .filter(r => r.category === 'user-group')
        .map(r => ({ name: bareName(r), slots: (r.children || []).map(c => c.index) })),
      // Every top-level map not in a user group: entry maps and orphans mixed,
      // sorted by slot, there being no separate Overworld folder any more.
      unassignedSlots: unassignedChildren.map(n => n.index),
      orphans: unassignedChildren
        .filter(n => n.category === 'orphan')
        .map(n => ({ id: n.id, index: n.index })),
      entriesWithChildren: unassignedChildren
        .filter(n => n.children.length > 0)
        .map(n => ({
          id: n.id,
          index: n.index,
          subAreas: n.children.map(c => ({ id: c.id, index: c.index })),
        })),
      // Any node in the tree, for locating a row by slot regardless of parent.
      allNodes: roots.flatMap(walk).map(n => ({ id: n.id, index: n.index, category: n.category })),
    }
  })
}

/**
 * The row for an exact tree node id. Node ids are unique per tree POSITION
 * (unlike a slot number, which can legitimately appear twice), and every row
 * carries its own id as `data-node-id` (map-explorer-widget.tsx).
 */
function rowById(page, id) {
  return page.locator(`${EXPLORER} .theia-TreeNode[data-node-id="${id}"]`)
}

function folderRow(page, name) {
  return rowById(page, folderId(name))
}

/**
 * Brings a node into view using the tree's OWN mechanism: a focus change
 * schedules `updateScrollToRow`, which Virtuoso answers by scrolling that
 * row into the viewport (align: 'center'). Forced synchronously (rather than
 * waiting on the debounced listener) so the DOM settles before the caller
 * looks for it. Deliberately does not touch SELECTION, so it never disturbs
 * a Ctrl/Shift-click sequence the caller is about to perform for real.
 */
async function reveal(page, id) {
  await page.evaluate(async nodeId => {
    const w = await getWidget('hackbench.map-explorer')
    const walk = n => [n, ...(n.children || []).flatMap(walk)]
    const node = (w.model.root.children || []).flatMap(walk).find(n => n.id === nodeId)
    if (!node) return
    w.focusService.setFocus(undefined)
    w.focusService.setFocus(node)
    w.updateScrollToRow()
  }, id)
  await page.waitForTimeout(250)
}

/** Reveals a node by id and returns its row, throwing a clear error if it never renders. */
async function rowFor(page, id) {
  await reveal(page, id)
  const loc = rowById(page, id)
  if ((await loc.count()) === 0) {
    throw new Error(`Row for node "${id}" is not rendered after reveal`)
  }
  return loc
}

/** Expands a map row (by node id) through the real model API, to reveal its sub areas. */
async function expandNode(page, id) {
  await page.evaluate(async nodeId => {
    const w = await getWidget('hackbench.map-explorer')
    const walk = n => [n, ...(n.children || []).flatMap(walk)]
    const node = (w.model.root.children || []).flatMap(walk).find(n => n.id === nodeId)
    if (node) await w.model.expandNode(node)
  }, id)
  await page.waitForTimeout(150)
}

/**
 * Expands a folder for real (a single click, only if it is not already
 * expanded, since collapseAll left every folder collapsed and a second click
 * would toggle it shut again). Needed before a child row can be revealed:
 * TreeWidget's own row list only includes rows whose ancestors are expanded,
 * so a collapsed folder's children are not merely off-screen, they are not
 * in that list at all.
 */
async function ensureExpanded(page, name) {
  const id = folderId(name)
  const expanded = await page.evaluate(async fid => {
    const w = await getWidget('hackbench.map-explorer')
    const node = w.model.root.children.find(r => r.id === fid)
    return !!(node && node.expanded)
  }, id)
  if (!expanded) {
    await (await rowFor(page, id)).click()
    await page.waitForTimeout(150)
  }
}

/**
 * A real HTML5 drag as a sequence of DragEvents sharing one DataTransfer,
 * dispatched directly rather than through Playwright's mouse-driven `dragTo`.
 * `dragTo` moves a real pointer and hit-tests along the way, which does not
 * hold up against this virtualised tree (rows mount and unmount under it);
 * dispatching the events the browser itself would fire does not depend on
 * anything staying in place between steps.
 *
 * `sourceId`/`targetId` are node ids, not locators: each one is revealed and
 * re-resolved right before ITS dispatch, source as well as target, because
 * the tree can scroll (or rebuild) between dragstart and the later steps.
 */
async function dragRow(page, sourceId, targetId) {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  // dragend goes to the element the drag started on, as a browser sends it:
  // after a successful drop that row has moved and its id no longer resolves.
  const source = await (await rowFor(page, sourceId)).elementHandle()
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await (await rowFor(page, targetId)).dispatchEvent('dragenter', { dataTransfer: dt })
  await (await rowFor(page, targetId)).dispatchEvent('dragover', { dataTransfer: dt })
  await (await rowFor(page, targetId)).dispatchEvent('drop', { dataTransfer: dt })
  await source.dispatchEvent('dragend', { dataTransfer: dt })
}

/**
 * The same sequence as `dragRow`, returning whether the widget would accept
 * the drop at dragover time. Theia's shell cancels every dragover on the page
 * (for file drops), so `defaultPrevented` cannot tell, and a constructed
 * DataTransfer ignores writes to `dropEffect`; the widget's own verdict is
 * read instead. Callers also assert the tree is unchanged afterwards.
 */
async function dragRowCheckingAccepted(page, sourceId, targetId) {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  // dragend goes to the element the drag started on, as a browser sends it:
  // after a successful drop that row has moved and its id no longer resolves.
  const source = await (await rowFor(page, sourceId)).elementHandle()
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await (await rowFor(page, targetId)).dispatchEvent('dragenter', { dataTransfer: dt })

  await (await rowFor(page, targetId)).dispatchEvent('dragover', { dataTransfer: dt })
  const accepted = await page.evaluate(async id => {
    const w = await getWidget('hackbench.map-explorer')
    return w.canDrop(w.model.getNode(id))
  }, targetId)

  await (await rowFor(page, targetId)).dispatchEvent('drop', { dataTransfer: dt })
  await source.dispatchEvent('dragend', { dataTransfer: dt })
  return accepted
}

async function rightClickMenuItem(page, label) {
  const item = page.locator('.lm-Menu-itemLabel', { hasText: label })
  await item.first().click()
}

async function typeInDialog(page, text) {
  const input = page.locator('.dialogBlock .theia-input')
  await input.fill(text)
}

function dialogError(page) {
  return page.locator('.dialogBlock .error')
}

async function acceptDialog(page) {
  await page.locator('.dialogBlock').getByRole('button', { name: 'OK' }).click()
}

async function cancelDialog(page) {
  await page.keyboard.press('Escape')
}

/** Adds the current selection to a brand new group named `name`, through the real menu, QuickPick and dialog. */
async function addToNewGroup(page, name) {
  await rightClickMenuItem(page, 'Add to Group...')
  await page.waitForSelector('.quick-input-widget', { timeout: 5000 })
  await page.getByText('New Group...', { exact: true }).click()
  await page.waitForSelector('.dialogBlock', { timeout: 5000 })
  await typeInDialog(page, name)
  await acceptDialog(page)
  await expect.poll(async () => (await snapshot(page)).userGroups.map(g => g.name)).toContain(name)
}

test('a vanilla project seeds its groups, numbered in world order, and "8. Star World" expands to its 5 maps', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'Vanilla'), { seedEmpty: false })
  const tree = await snapshot(page)

  expect(tree.userGroups.map(g => g.name)).toContain('8. Star World')
  expect(tree.rootIds[0]).toBe('special:title-screen')
  expect(tree.rootIds).toContain('group:user:8. Star World')
  // No separate Overworld folder: Unassigned is the last row.
  expect(tree.rootIds[tree.rootIds.length - 1]).toBe('group:unassigned')

  const starWorld = tree.userGroups.find(g => g.name === '8. Star World')
  expect(new Set(starWorld.slots)).toEqual(new Set([0x134, 0x130, 0x132, 0x135, 0x136]))

  // Expand it for real (collapseAll folded it to its header row) and read
  // the rows back.
  await (await rowFor(page, 'group:user:8. Star World')).click()
  for (const slot of starWorld.slots) {
    const id = `group:user:8. Star World/$${slot.toString(16).toUpperCase().padStart(3, '0')}`
    await expect(await rowFor(page, id)).toBeVisible()
  }
})

test('a non-vanilla corpus ROM gets no groups at load', async ({ page }) => {
  test.skip(!fs.existsSync(HACK_ROM), 'no non-vanilla corpus ROM on this machine')
  await openProject(page, path.join(tmp, 'Hack'), { rom: HACK_ROM, seedEmpty: false })
  const tree = await snapshot(page)
  expect(tree.userGroups).toEqual([])
})

test('the vanilla ROM and its Lunar Magic resave (a copier-headered copy) seed identically', async ({
  page,
}) => {
  const magic = romPath(MAGIC)
  test.skip(!fs.existsSync(magic), 'no magic.sfc corpus ROM on this machine')
  await openProject(page, path.join(tmp, 'Magic'), { rom: magic, seedEmpty: false })
  const tree = await snapshot(page)
  expect(tree.userGroups.map(g => g.name)).toContain('8. Star World')
  expect(new Set(tree.userGroups.find(g => g.name === '8. Star World').slots)).toEqual(
    new Set([0x134, 0x130, 0x132, 0x135, 0x136]),
  )
})

test('Ctrl+click and Shift+click select multiple rows and open no preview', async ({ page }) => {
  await openProject(page, path.join(tmp, 'MultiSelect'))
  const tree = await snapshot(page)
  const [a, b, c] = tree.orphans
  expect(c).toBeDefined()

  await ensureExpanded(page, 'Unassigned')

  const rowA = await rowFor(page, a.id)
  await rowA.click()
  const rowB = await rowFor(page, b.id)
  await rowB.click({ modifiers: ['Control'] })

  const afterCtrl = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    return w.model.selectedNodes.length
  })
  expect(afterCtrl).toBe(2)
  // A multi-row selection opens no editor tab.
  expect(await page.locator('.hb-map-view-body').count()).toBe(0)

  const rowC = await rowFor(page, c.id)
  await rowC.click({ modifiers: ['Shift'] })
  const afterShift = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    return w.model.selectedNodes.length
  })
  expect(afterShift).toBeGreaterThanOrEqual(2)
  expect(await page.locator('.hb-map-view-body').count()).toBe(0)
})

test('dragging one row of a multi-selection moves the whole selection into a group', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'MultiDrag'))
  const [a, b, c] = (await snapshot(page)).orphans
  expect(c).toBeDefined()
  await ensureExpanded(page, 'Unassigned')

  await (await rowFor(page, c.id)).click()
  await (await rowFor(page, c.id)).click({ button: 'right' })
  await addToNewGroup(page, 'Target')

  await (await rowFor(page, a.id)).click()
  await (await rowFor(page, b.id)).click({ modifiers: ['Control'] })
  await dragRow(page, b.id, 'group:user:Target')

  await expect
    .poll(async () => {
      const target = (await snapshot(page)).userGroups.find(g => g.name === 'Target')
      return [...(target?.slots ?? [])].sort((x, y) => x - y)
    })
    .toEqual([a.index, b.index, c.index].sort((x, y) => x - y))
})

/**
 * Picks an entry map (from Unassigned) that has at least one sub area which
 * is NOT also a top-level row elsewhere in the tree: some slots are flagged
 * in the ROM as their own overworld level while also being reachable as a
 * sub area of another root (src/rom/MapTree.ts), so they render twice, and a
 * "sub area" fixture chosen without this check can resolve to the OTHER,
 * perfectly groupable copy.
 */
function pickEntryWithUnambiguousSubArea(tree) {
  const topLevel = new Set(tree.unassignedSlots)
  for (const entry of tree.entriesWithChildren) {
    const subArea = entry.subAreas.find(s => !topLevel.has(s.index))
    if (subArea) return { entry, subArea }
  }
  return undefined
}

test('Add to Group is unavailable when the selection contains a sub area', async ({ page }) => {
  await openProject(page, path.join(tmp, 'SubareaGuard'))
  const tree = await snapshot(page)
  const picked = pickEntryWithUnambiguousSubArea(tree)
  expect(picked).toBeDefined()

  await ensureExpanded(page, 'Unassigned')
  await (await rowFor(page, picked.entry.id)).click()
  await expandNode(page, picked.entry.id)

  await (await rowFor(page, picked.subArea.id)).click({ button: 'right' })

  await expect(page.locator('.lm-Menu-itemLabel', { hasText: 'Add to Group...' })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('a group is built through the real UI, dragged into, persisted, and deleted', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'MyHack'))
  const before = await snapshot(page)
  const [a, b] = before.orphans
  const picked = pickEntryWithUnambiguousSubArea(before)
  expect(b).toBeDefined()
  expect(picked).toBeDefined()
  const { entry, subArea } = picked

  await ensureExpanded(page, 'Unassigned')

  // 1. Ctrl+click two Unassigned maps (both orphans, for the dimming check
  //    below), right-click, Add to Group... > New Group..., type "Test".
  const rowA = await rowFor(page, a.id)
  await rowA.click()
  const rowB = await rowFor(page, b.id)
  await rowB.click({ modifiers: ['Control'] })
  await rowB.click({ button: 'right', modifiers: ['Control'] })
  await addToNewGroup(page, 'Test')

  let tree = await snapshot(page)
  let testGroup = tree.userGroups.find(g => g.name === 'Test')
  expect(new Set(testGroup.slots)).toEqual(new Set([a.index, b.index]))
  expect(tree.unassignedSlots).not.toContain(a.index)
  expect(tree.unassignedSlots).not.toContain(b.index)

  // Orphan rows stay dimmed and italic, with the reachability tooltip, once
  // inside a group. The node's id has changed (it now hangs under "Test"),
  // so it is found fresh from the model rather than reusing `a.id`.
  const movedA = tree.allNodes.find(n => n.index === a.index && n.id.includes('Test'))
  const orphanRowHandle = await (await rowFor(page, movedA.id)).elementHandle()
  const style = await page.evaluate(el => {
    const cs = getComputedStyle(el)
    return { fontStyle: cs.fontStyle, opacity: cs.opacity, title: el.getAttribute('title') }
  }, orphanRowHandle)
  expect(style.fontStyle).toBe('italic')
  expect(Number(style.opacity)).toBeLessThan(1)
  expect(style.title).toMatch(/not reached from the overworld/i)

  // 2. Drag an Unassigned entry map with sub areas onto "Test".
  await dragRow(page, entry.id, 'group:user:Test')

  await expect
    .poll(async () => {
      const t = await snapshot(page)
      return t.userGroups.find(g => g.name === 'Test')?.slots ?? []
    })
    .toEqual(expect.arrayContaining([entry.index]))

  const afterDrag = (await snapshot(page)).allNodes
  for (const s of entry.subAreas) {
    expect(afterDrag.some(n => n.index === s.index && n.id.includes('Test'))).toBe(true)
  }

  // 3. A sub-area drag is refused outright: the chosen sub area (guaranteed
  //    to be ungroupable, see pickEntryWithUnambiguousSubArea) now lives
  //    under "Test" too; find it there and try dragging it onto Unassigned.
  const movedEntry = (await snapshot(page)).allNodes.find(
    n => n.index === entry.index && n.id.includes('Test'),
  )
  const movedSubAreaId = `${movedEntry.id}/$${subArea.index.toString(16).toUpperCase().padStart(3, '0')}`
  await expandNode(page, movedEntry.id)
  const subDragAccepted = await dragRowCheckingAccepted(page, movedSubAreaId, 'group:unassigned')
  expect(subDragAccepted).toBe(false)
  const afterSubDrag = await snapshot(page)
  expect(afterSubDrag.allNodes.some(n => n.index === subArea.index && n.id.includes('Test'))).toBe(
    true,
  )

  // 4. Reload: proves the write is real, not an in-memory-only change.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await w.collapseAll()
  }, manifestPath)
  await revealMaps(page)

  const persisted = await snapshot(page)
  const persistedTest = persisted.userGroups.find(g => g.name === 'Test')
  expect(persistedTest).toBeDefined()
  expect(new Set(persistedTest.slots)).toEqual(new Set([a.index, b.index, entry.index]))

  // 5. Dropping a grouped map onto Unassigned removes it from the group:
  //    Unassigned is every grouped map's structural parent, entry map or
  //    orphan alike.
  await ensureExpanded(page, 'Test')
  const entryInTest = persisted.allNodes.find(n => n.index === entry.index && n.id.includes('Test'))
  await dragRow(page, entryInTest.id, 'group:unassigned')
  await expect
    .poll(async () => (await snapshot(page)).unassignedSlots)
    .toEqual(expect.arrayContaining([entry.index]))

  // 6. Remove the remaining orphan members: the group survives empty, as a folder.
  const stillInTest = (await snapshot(page)).allNodes.filter(
    n => n.id.includes('group:user:Test') && (n.index === a.index || n.index === b.index),
  )
  expect(stillInTest).toHaveLength(2)
  const remainingA = await rowFor(page, stillInTest[0].id)
  await remainingA.click()
  const remainingB = await rowFor(page, stillInTest[1].id)
  await remainingB.click({ modifiers: ['Control'] })
  await remainingB.click({ button: 'right', modifiers: ['Control'] })
  await rightClickMenuItem(page, 'Remove from Group')

  await expect
    .poll(async () => {
      const t = await snapshot(page)
      return t.userGroups.find(g => g.name === 'Test')?.slots.length
    })
    .toBe(0)
  await expect(await folderRow(page, 'Test')).toBeVisible()

  // 7. Delete: every map returns to Unassigned. (Nothing was left in "Test"
  //    by step 6, so this also proves an empty group deletes cleanly.)
  await (await rowFor(page, 'group:user:Test')).click({ button: 'right' })
  await rightClickMenuItem(page, 'Delete Group')

  await expect
    .poll(async () => (await snapshot(page)).userGroups.map(g => g.name))
    .not.toContain('Test')
  const final = await snapshot(page)
  expect(final.unassignedSlots).toEqual(expect.arrayContaining([a.index, b.index, entry.index]))
})

test('renaming a group to a name that clashes only in case is refused, with a message', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'RenameClash'))
  const tree = await snapshot(page)
  const [a, b] = tree.orphans
  expect(b).toBeDefined()

  // Build two groups locally, so the clash does not depend on any seeded name.
  await ensureExpanded(page, 'Unassigned')
  const rowA = await rowFor(page, a.id)
  await rowA.click()
  await rowA.click({ button: 'right' })
  await addToNewGroup(page, 'Alpha')

  const rowB = await rowFor(page, b.id)
  await rowB.click()
  await rowB.click({ button: 'right' })
  await addToNewGroup(page, 'Beta')

  // Rename "Beta" to a case-only clash with "Alpha": refused, with a message.
  await (await rowFor(page, 'group:user:Beta')).click({ button: 'right' })
  await rightClickMenuItem(page, 'Rename Group...')
  await page.waitForSelector('.dialogBlock', { timeout: 5000 })
  await typeInDialog(page, 'alpha')
  await expect(dialogError(page)).toContainText(/already exists/i)
  await cancelDialog(page)

  const afterCancel = await snapshot(page)
  expect(afterCancel.userGroups.map(g => g.name)).toEqual(expect.arrayContaining(['Alpha', 'Beta']))
})
