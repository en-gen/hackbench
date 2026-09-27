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
const HACK_ROM = process.env.HB_ROM_INVICTUS || romPath(INVICTUS)
const MAGIC_ROM = process.env.HB_ROM_MAGIC || romPath(MAGIC)

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
 * `groupsJson` writes that exact text instead.
 */
async function openProject(page, dir, { rom = ROM, seedEmpty = true, groupsJson } = {}) {
  const manifestPath = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return project.manifestPath
    },
    { romPath: rom, directory: dir },
  )
  if (seedEmpty || groupsJson !== undefined) {
    fs.mkdirSync(path.join(dir, 'meta'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta', 'groups.json'), groupsJson ?? '[]\n')
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
 * Starts a REAL pointer drag on a row: the mouse goes down on it and moves a
 * few pixels, past Chromium's drag threshold, so the browser itself fires
 * dragstart. Playwright routes the drag through Chromium's own pipeline
 * (CDP drag interception), so every later dragenter/dragover/drop is the
 * browser's, with its real DataTransfer and its real dropEffect.
 *
 * Synthetic DragEvents dispatched on the rows used to stand in for this, and
 * passed while the real drag did nothing (#625): a constructed DataTransfer
 * ignores writes to dropEffect, so it cannot see a dropEffect that some
 * other listener resets before the browser decides whether to drop.
 */
async function startDrag(page, sourceId) {
  const s = await (await rowFor(page, sourceId)).boundingBox()
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 6, { steps: 3 })
}

/**
 * Carries the drag started by `startDrag` onto a row. The target is revealed
 * mid-drag, as a user would scroll to it: the tree virtualises, so source and
 * target need not both be on screen at once.
 */
async function hoverDragOver(page, targetId) {
  const t = await (await rowFor(page, targetId)).boundingBox()
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 8 })
  await page.mouse.move(t.x + t.width / 2 + 4, t.y + t.height / 2, { steps: 2 })
}

/** A real pointer drag from one row (by node id) onto another, dropped there. */
async function dragRow(page, sourceId, targetId) {
  await startDrag(page, sourceId)
  await hoverDragOver(page, targetId)
  await page.mouse.up()
}

/**
 * The same real drag as `dragRow`, returning whether the widget would accept
 * the drop while hovering the target. Callers also assert the tree is
 * unchanged afterwards, which is the behaviour that matters.
 */
async function dragRowCheckingAccepted(page, sourceId, targetId) {
  await startDrag(page, sourceId)
  await hoverDragOver(page, targetId)
  const accepted = await page.evaluate(async id => {
    const w = await getWidget('hackbench.map-explorer')
    return w.canDrop(w.model.getNode(id))
  }, targetId)
  await page.mouse.up()
  return accepted
}

/** meta/groups.json as written to disk, read back from the manifest's project directory. */
function groupsOnDisk(manifestPath) {
  return JSON.parse(
    fs.readFileSync(path.join(path.dirname(manifestPath), 'meta', 'groups.json'), 'utf8'),
  )
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
  // Title Screen and New Game lead, and are the only special rows (#624).
  expect(tree.rootIds.filter(id => id.startsWith('special:'))).toEqual([
    'special:title-screen:199',
    'special:new-game:197',
  ])
  expect(tree.rootIds.slice(0, 2)).toEqual(['special:title-screen:199', 'special:new-game:197'])
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

  // The maps entered after a level are two groups after the nine areas, drawn
  // as bonus rows: their role's icon and tooltip, never dimmed.
  expect(tree.userGroups.map(g => g.name).slice(-3)).toEqual([
    '9. Special Zone',
    'Bonus Games',
    'Yoshi Heaven',
  ])
  expect(tree.userGroups.find(g => g.name === 'Bonus Games').slots).toEqual([0x000, 0x100])
  expect(tree.userGroups.find(g => g.name === 'Yoshi Heaven').slots).toEqual([0x0c8, 0x1c8])
  for (const [folder, slots] of [
    ['Bonus Games', ['$000', '$100']],
    ['Yoshi Heaven', ['$0C8', '$1C8']],
  ]) {
    await ensureExpanded(page, folder)
    for (const slot of slots) await expectBonusRow(page, folder, slot)
  }
})

/**
 * The four maps DATA_05DBA9 names on vanilla (src/rom/BonusEntrances.ts), and
 * how a bonus row must look: its role's icon and tooltip, never dimmed.
 */
const BONUS_GAME = { icon: 'codicon-star-empty', title: 'Entered after a level' }
const YOSHI_HEAVEN = { icon: 'codicon-arrow-up', title: 'Entered by flying up on Yoshi wings' }
const BONUS_LOOK = { $000: BONUS_GAME, $100: BONUS_GAME, $0C8: YOSHI_HEAVEN, $1C8: YOSHI_HEAVEN }
const BONUS_SLOTS = [0x000, 0x100, 0x0c8, 0x1c8]

/** Asserts a bonus row's model category and its rendered icon, tooltip and (lack of) dimming. */
async function expectBonusRow(page, folder, slot) {
  const id = `${folderId(folder)}/${slot}`
  const look = await (
    await rowFor(page, id)
  ).evaluate(el => {
    const cs = getComputedStyle(el)
    const icon = [...(el.querySelector('.hb-map-icon')?.classList ?? [])]
    return {
      icon: icon.find(c => c.startsWith('codicon-')),
      title: el.getAttribute('title'),
      fontStyle: cs.fontStyle,
      opacity: cs.opacity,
    }
  })
  const node = (await snapshot(page)).allNodes.find(n => n.id === id)
  expect({ category: node?.category, ...look }).toEqual({
    category: 'bonus',
    ...BONUS_LOOK[slot],
    fontStyle: 'normal',
    opacity: '1',
  })
}

test('Bonus Games and Yoshi Heaven are ordinary groups: drag out, rename, delete', async ({
  page,
}) => {
  await openProject(page, path.join(tmp, 'BonusOrdinary'), { seedEmpty: false })
  const group = async name => (await snapshot(page)).userGroups.find(g => g.name === name)
  const names = async () => (await snapshot(page)).userGroups.map(g => g.name)

  await ensureExpanded(page, 'Bonus Games')
  await dragRow(page, 'group:user:Bonus Games/$000', 'group:unassigned')
  await expect.poll(async () => (await group('Bonus Games'))?.slots).toEqual([0x100])
  await ensureExpanded(page, 'Unassigned')
  await expectBonusRow(page, 'Unassigned', '$000')

  await (await rowFor(page, 'group:user:Bonus Games')).click({ button: 'right' })
  await rightClickMenuItem(page, 'Rename Group...')
  await page.waitForSelector('.dialogBlock', { timeout: 5000 })
  await typeInDialog(page, 'Bonus Rooms')
  await acceptDialog(page)
  await expect.poll(names).toContain('Bonus Rooms')
  expect(await names()).not.toContain('Bonus Games')
  expect((await group('Bonus Rooms')).slots).toEqual([0x100])

  await (await rowFor(page, 'group:user:Yoshi Heaven')).click({ button: 'right' })
  await rightClickMenuItem(page, 'Delete Group')
  await expect.poll(names).not.toContain('Yoshi Heaven')
  await expectBonusRow(page, 'Unassigned', '$0C8')
  await expectBonusRow(page, 'Unassigned', '$1C8')
})

test('a groups.json written before the Bonus Games seed is left byte-identical', async ({
  page,
}) => {
  const dir = path.join(tmp, 'OldSeed')
  // One line, no trailing newline: a format writeGroups never produces, so any
  // rewrite shows in the bytes.
  const old = JSON.stringify([
    { name: '8. Star World', slots: [0x134, 0x130, 0x132, 0x135, 0x136] },
  ])
  await openProject(page, dir, { groupsJson: old })

  const tree = await snapshot(page)
  expect(fs.readFileSync(path.join(dir, 'meta', 'groups.json'), 'utf8')).toBe(old)
  expect(tree.userGroups.map(g => g.name)).toEqual(['8. Star World'])
  // Not seeded into a group, the four maps sit in Unassigned, still bonus rows.
  const bonus = tree.allNodes.filter(
    n => n.id.startsWith('group:unassigned/') && BONUS_SLOTS.includes(n.index),
  )
  expect(bonus.map(n => n.category)).toEqual(['bonus', 'bonus', 'bonus', 'bonus'])
})

test('a non-vanilla corpus ROM gets no groups at load, and its refused bonus maps stay orphans', async ({
  page,
}) => {
  test.skip(!fs.existsSync(HACK_ROM), 'no non-vanilla corpus ROM on this machine')
  await openProject(page, path.join(tmp, 'Hack'), { rom: HACK_ROM, seedEmpty: false })
  const tree = await snapshot(page)
  expect(tree.userGroups).toEqual([])

  // Measured on Invictus: the bonus read is refused and all four are real
  // maps, so they are orphans in Unassigned, and the refusal is a toast.
  expect(tree.orphans.filter(n => BONUS_SLOTS.includes(n.index)).map(n => n.index)).toEqual([
    0x000, 0x0c8, 0x100, 0x1c8,
  ])
  // The toast list and the (hidden) notification center both hold the text.
  const toast = page
    .locator('.theia-notification-message')
    .filter({ hasText: 'Bonus Games and Yoshi Heaven:', visible: true })
  await expect(toast.first()).toBeVisible()
})

test('the vanilla ROM and its Lunar Magic resave (a copier-headered copy) seed identically', async ({
  page,
}) => {
  test.skip(!fs.existsSync(MAGIC_ROM), 'no magic.sfc corpus ROM on this machine')
  await openProject(page, path.join(tmp, 'Magic'), { rom: MAGIC_ROM, seedEmpty: false })
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

/** Node ids of the rows currently drawn with the drop highlight. */
async function highlightedIds(page) {
  return page
    .locator(`${EXPLORER} .theia-TreeNode.hb-map-drop-target`)
    .evaluateAll(els => els.map(e => e.getAttribute('data-node-id')))
}

/** The theme's list.dropBackground, resolved to the rgb() a computed style reports. */
async function themeDropColor(page) {
  return page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--theia-list-dropBackground)'
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).backgroundColor
    probe.remove()
    return color
  })
}

async function rowBackground(page, id) {
  return rowById(page, id).evaluate(el => getComputedStyle(el).backgroundColor)
}

/** Rewrites meta/groups.json and reloads the explorer, so a test starts from known groups without the menus. */
async function reloadWithGroups(page, manifestPath, groups) {
  fs.writeFileSync(
    path.join(path.dirname(manifestPath), 'meta', 'groups.json'),
    JSON.stringify(groups),
  )
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    await w.collapseAll()
  }, manifestPath)
}

/** The slots of user group `name` in the tree, or undefined when there is no such group. */
async function groupSlots(page, name) {
  return (await snapshot(page)).userGroups.find(g => g.name === name)?.slots
}

test('a real pointer drag moves an orphan into a group and back to Unassigned, on disk too', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'RealDrag'))
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [] }])
  const [orphan] = (await snapshot(page)).orphans
  expect(orphan).toBeDefined()
  await ensureExpanded(page, 'Unassigned')

  await dragRow(page, orphan.id, 'group:user:Target')

  await expect.poll(() => groupSlots(page, 'Target')).toEqual([orphan.index])
  expect((await snapshot(page)).unassignedSlots).not.toContain(orphan.index)
  expect(groupsOnDisk(manifestPath)).toEqual([{ name: 'Target', slots: [orphan.index] }])

  await ensureExpanded(page, 'Target')
  const grouped = (await snapshot(page)).allNodes.find(
    n => n.index === orphan.index && n.id.startsWith('group:user:Target/'),
  )
  await dragRow(page, grouped.id, 'group:unassigned')

  await expect
    .poll(async () => (await snapshot(page)).unassignedSlots)
    .toEqual(expect.arrayContaining([orphan.index]))
  expect(await groupSlots(page, 'Target')).toEqual([])
  expect(groupsOnDisk(manifestPath)).toEqual([{ name: 'Target', slots: [] }])
})

test('a real drag that reaches the group in one move and releases at once still drops', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'OneStep'))
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [] }])
  const [orphan] = (await snapshot(page)).orphans
  await ensureExpanded(page, 'Unassigned')

  await startDrag(page, orphan.id)
  const t = await (await rowFor(page, 'group:user:Target')).boundingBox()
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
  await page.mouse.up()

  await expect.poll(() => groupSlots(page, 'Target')).toEqual([orphan.index])
  expect(groupsOnDisk(manifestPath)).toEqual([{ name: 'Target', slots: [orphan.index] }])
})

test('a real drag onto a map row inside a group drops into that group', async ({ page }) => {
  const manifestPath = await openProject(page, path.join(tmp, 'OntoChild'))
  const [a, b] = (await snapshot(page)).orphans
  expect(b).toBeDefined()
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [b.index] }])
  await ensureExpanded(page, 'Unassigned')
  await ensureExpanded(page, 'Target')
  const child = (await snapshot(page)).allNodes.find(
    n => n.index === b.index && n.id.startsWith('group:user:Target/'),
  )

  await dragRow(page, a.id, child.id)

  await expect
    .poll(async () => [...((await groupSlots(page, 'Target')) ?? [])].sort((x, y) => x - y))
    .toEqual([a.index, b.index].sort((x, y) => x - y))
  expect(new Set(groupsOnDisk(manifestPath)[0].slots)).toEqual(new Set([a.index, b.index]))
})

test('a live real drag of an ungrouped map onto Unassigned is refused', async ({ page }) => {
  const manifestPath = await openProject(page, path.join(tmp, 'LiveRefusal'))
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [] }])
  const before = await snapshot(page)
  await ensureExpanded(page, 'Unassigned')

  const accepted = await dragRowCheckingAccepted(page, before.orphans[0].id, 'group:unassigned')
  expect(accepted).toBe(false)

  // Settle first: an accepted drop writes asynchronously, so an immediate
  // snapshot would pass even if the drop had been taken.
  await page.waitForTimeout(1500)
  const after = await snapshot(page)
  expect(after.unassignedSlots).toEqual(before.unassignedSlots)
  expect(after.userGroups).toEqual(before.userGroups)
  expect(groupsOnDisk(manifestPath)).toEqual([{ name: 'Target', slots: [] }])
})

test('a drop this explorer did not start is refused, even with a stale drag still recorded', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'ForeignDrop'))
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [] }])
  const [orphan] = (await snapshot(page)).orphans
  await ensureExpanded(page, 'Unassigned')

  // A drag that never got its dragend (its source row unmounted mid-drag)
  // leaves its maps recorded. Synthetic, as a real drag always ends.
  const stale = await page.evaluateHandle(() => new DataTransfer())
  await (await rowFor(page, orphan.id)).dispatchEvent('dragstart', { dataTransfer: stale })
  const recorded = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    return w.dragNodes?.length ?? 0
  })
  expect(recorded).toBe(1)

  // Then text from elsewhere is dropped on the group: no map-row type.
  const foreign = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'not a map')
    return dt
  })
  const target = await rowFor(page, 'group:user:Target')
  for (const type of ['dragenter', 'dragover', 'drop']) {
    await target.dispatchEvent(type, { dataTransfer: foreign })
  }

  await page.waitForTimeout(1500)
  expect(await groupSlots(page, 'Target')).toEqual([])
  expect(groupsOnDisk(manifestPath)).toEqual([{ name: 'Target', slots: [] }])
})

test('an accepted real drag highlights the whole target folder in the theme drop color', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'Highlight'))
  const [a, b] = (await snapshot(page)).orphans
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [b.index] }])
  await ensureExpanded(page, 'Unassigned')
  await ensureExpanded(page, 'Target')
  const child = (await snapshot(page)).allNodes.find(
    n => n.index === b.index && n.id.startsWith('group:user:Target/'),
  )
  const dropColor = await themeDropColor(page)
  expect(dropColor).not.toMatch(/^(|transparent|rgba\(0, 0, 0, 0\))$/)

  await startDrag(page, a.id)
  await hoverDragOver(page, 'group:user:Target')
  // Header and its visible member, and nothing outside the folder.
  await expect.poll(() => highlightedIds(page)).toEqual(['group:user:Target', child.id])
  expect(await rowBackground(page, 'group:user:Target')).toBe(dropColor)
  expect(await rowBackground(page, child.id)).toBe(dropColor)
  expect(await rowBackground(page, 'group:unassigned')).not.toBe(dropColor)

  // Hovering a row inside the folder highlights that folder, not the row alone.
  await hoverDragOver(page, child.id)
  await expect.poll(() => highlightedIds(page)).toEqual(['group:user:Target', child.id])

  await page.mouse.up()
  await expect.poll(() => groupSlots(page, 'Target')).toEqual([b.index, a.index])
  await expect.poll(() => highlightedIds(page)).toEqual([])
})

test('a refused target shows no highlight, and Esc leaves none behind', async ({ page }) => {
  const manifestPath = await openProject(page, path.join(tmp, 'NoHighlight'))
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [] }])
  const [orphan] = (await snapshot(page)).orphans
  await ensureExpanded(page, 'Unassigned')

  await startDrag(page, orphan.id)
  // An ungrouped map onto Unassigned: refused, so nothing lights up.
  await hoverDragOver(page, 'group:unassigned')
  await page.waitForTimeout(300)
  expect(await highlightedIds(page)).toEqual([])

  // The same live drag over a group that accepts it does light up...
  await hoverDragOver(page, 'group:user:Target')
  await expect.poll(() => highlightedIds(page)).toEqual(['group:user:Target'])
  // ...and Esc cancels the drag and clears it.
  await page.keyboard.press('Escape')
  await expect.poll(() => highlightedIds(page)).toEqual([])
  await page.mouse.up()
  await page.waitForTimeout(1000)
  expect(await groupSlots(page, 'Target')).toEqual([])
})

test('dropping maps on the group they are already in is refused and rewrites nothing', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'OwnGroup'))
  const [a, b] = (await snapshot(page)).orphans
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [a.index, b.index] }])
  const file = path.join(path.dirname(manifestPath), 'meta', 'groups.json')
  const bytes = fs.readFileSync(file)
  await ensureExpanded(page, 'Target')
  const member = (await snapshot(page)).allNodes.find(
    n => n.index === a.index && n.id.startsWith('group:user:Target/'),
  )

  await startDrag(page, member.id)
  await hoverDragOver(page, 'group:user:Target')
  const accepted = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    return w.canDrop(w.model.getNode('group:user:Target'))
  })
  expect(accepted).toBe(false)
  expect(await highlightedIds(page)).toEqual([])
  await page.mouse.up()

  await page.waitForTimeout(1500)
  expect(fs.readFileSync(file).equals(bytes)).toBe(true)
  expect(await groupSlots(page, 'Target')).toEqual([a.index, b.index])
})

test('a mixed selection dropped on a group adds only the maps outside it, in place', async ({
  page,
}) => {
  const manifestPath = await openProject(page, path.join(tmp, 'Mixed'))
  const [a, b, c] = (await snapshot(page)).orphans
  expect(c).toBeDefined()
  await reloadWithGroups(page, manifestPath, [{ name: 'Target', slots: [b.index, c.index] }])
  await ensureExpanded(page, 'Unassigned')
  await ensureExpanded(page, 'Target')
  const member = (await snapshot(page)).allNodes.find(
    n => n.index === b.index && n.id.startsWith('group:user:Target/'),
  )

  // a first, then b (already a member): a merge that re-added b would move it
  // behind c, whichever order the selection is read in.
  await (await rowFor(page, a.id)).click()
  await (await rowFor(page, member.id)).click({ modifiers: ['Control'] })
  await dragRow(page, a.id, 'group:user:Target')

  await expect.poll(() => groupSlots(page, 'Target')).toEqual([b.index, c.index, a.index])
  expect(groupsOnDisk(manifestPath)).toEqual([
    { name: 'Target', slots: [b.index, c.index, a.index] },
  ])
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
