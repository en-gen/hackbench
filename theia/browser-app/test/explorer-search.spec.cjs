/**
 * Explorer search and filter (#336), driven with real keystrokes on the real
 * tree: type to filter, Ctrl+F, Escape to clear.
 *
 * What is asserted is the set of rows the tree DRAWS (`widget.rows`, which
 * already applies Theia's filter), compared with an expected set computed here
 * from the loaded model: every row that matches, plus its ancestors. That
 * catches a stray visible row as well as a missing one, which "the match is on
 * screen" would not.
 *
 * The tree virtualises, so DOM rows are not the source of truth; `rows` is.
 * Fixture nodes (which map has a name, which node is expandable) are read from
 * the model at runtime, never hardcoded, since they are ROM-derived.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) { return getSvc('WidgetManager').getOrCreateWidget(id) }`

const IDS = {
  maps: 'hackbench.map-explorer',
  gfx: 'hackbench.gfx-explorer',
  palettes: 'hackbench.palette-explorer',
  music: 'hackbench.music-explorer',
}

let tmp

test.skip(!fs.existsSync(ROM), 'needs the vanilla corpus ROM')

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-search-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Loads the project into one explorer, brings it to the front and focuses its tree. */
async function openExplorer(page, which) {
  await page.evaluate(
    async ({ romPath, directory, id }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Search',
        directory,
      })
      const w = await getWidget(id)
      await w.load(project.manifestPath)
      await getSvc('ApplicationShell').activateWidget(id)
      w.node.focus()
    },
    { romPath: ROM, directory: tmp, id: IDS[which] },
  )
  await page.waitForTimeout(800)
}

/** The drawn row ids, selection, and expanded ids, read off the widget. */
async function state(page, which) {
  return page.evaluate(async id => {
    const w = await getWidget(id)
    const expanded = []
    const walk = n => {
      if ('expanded' in n && n.expanded) expanded.push(n.id)
      ;(n.children || []).forEach(walk)
    }
    walk(w.model.root)
    return {
      rows: [...w.rows.values()].map(r => r.node.id),
      selected: w.model.selectedNodes.map(n => n.id),
      expanded: expanded.sort(),
      boxVisible: w.searchBox ? w.searchBox.isVisible : false,
      empty:
        document.querySelector(`#${CSS.escape(id)} .hb-explorer-no-match`)?.textContent ?? null,
    }
  }, IDS[which])
}

/** Every model node (serialisable subset) so the test can compute expectations. */
async function nodes(page, which) {
  return page.evaluate(async id => {
    const w = await getWidget(id)
    const out = []
    const walk = (n, parent) => {
      if (n !== w.model.root) {
        out.push({
          id: n.id,
          parent: parent === w.model.root ? null : parent.id,
          kind: n.kind,
          name: n.name,
          index: n.index,
          mapName: n.mapName,
          variant: n.variant,
          bgmCommand: n.bgmCommand,
          alias: n.alias,
          expandable: 'expanded' in n,
          category: n.category,
        })
      }
      ;(n.children || []).forEach(c => walk(c, n))
    }
    walk(w.model.root, null)
    return out
  }, IDS[which])
}

/** Expected drawn rows: the matching nodes plus every ancestor of one. */
function expectedRows(all, isMatch) {
  const byId = new Map(all.map(n => [n.id, n]))
  const keep = new Set()
  for (const n of all) {
    if (!isMatch(n)) continue
    for (let c = n; c; c = c.parent ? byId.get(c.parent) : null) keep.add(c.id)
  }
  return keep
}

async function type(page, which, text) {
  await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
  await page.keyboard.type(text)
}

async function expectRows(page, which, expected) {
  expect(expected.size, 'fixture: the query must match something').toBeGreaterThan(0)
  await expect
    .poll(async () => (await state(page, which)).rows.sort(), { timeout: 10000 })
    .toEqual([...expected].sort())
}

async function clear(page, which) {
  await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
  await page.keyboard.press('Escape')
}

const NO_MATCH = {
  maps: 'No maps match "zzzq".',
  gfx: 'No graphics files match "zzzq".',
  palettes: 'No palettes match "zzzq".',
  music: 'No tracks or sound effects match "zzzq".',
}

for (const which of Object.keys(IDS)) {
  test(`${which}: a query with no matches says so in words`, async ({ page }) => {
    await openExplorer(page, which)
    await type(page, which, 'zzzq')
    await expect.poll(async () => (await state(page, which)).empty).toBe(NO_MATCH[which])
    expect((await state(page, which)).rows).toEqual([])
    await clear(page, which)
    await expect.poll(async () => (await state(page, which)).empty).toBeNull()
    expect((await state(page, which)).rows.length).toBeGreaterThan(0)
  })

  test(`${which}: Ctrl+F opens the box, and Escape restores the exact prior expansion`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    const all = await nodes(page, which)
    // Flip the first three expandable rows so the starting state is not a default.
    await page.evaluate(
      async ({ id, ids }) => {
        const w = await getWidget(id)
        const find = (n, target) =>
          n.id === target ? n : (n.children || []).map(c => find(c, target)).find(Boolean)
        for (const target of ids) {
          const n = find(w.model.root, target)
          if (n.expanded) await w.model.collapseNode(n)
          else await w.model.expandNode(n)
        }
      },
      {
        id: IDS[which],
        ids: all
          .filter(n => n.expandable)
          .slice(0, 3)
          .map(n => n.id),
      },
    )
    const before = await state(page, which)

    await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
    await page.keyboard.press('Control+f')
    await expect.poll(async () => (await state(page, which)).boxVisible).toBe(true)

    const deep = all.find(n => n.index >= 0 || n.variant !== undefined || n.bgmCommand > 0)
    const q =
      which === 'maps' && deep.mapName
        ? deep.mapName
        : `$${(deep.index ?? deep.variant ?? deep.bgmCommand ?? 0).toString(16)}`
    await type(page, which, q)
    await expect.poll(async () => (await state(page, which)).rows.length).toBeGreaterThan(0)

    await clear(page, which)
    await expect.poll(async () => (await state(page, which)).expanded).toEqual(before.expanded)
    expect((await state(page, which)).boxVisible).toBe(false)
  })
}

test('maps: 105 leaves only $105 and its folders; 1fc shows and selects $1FC', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const isSlot = (n, v) => n.kind !== 'group' && n.kind !== 'message' && n.index === v
  const want105 = expectedRows(all, n => isSlot(n, 0x105))
  expect(
    all.some(n => isSlot(n, 0x105)),
    'fixture: vanilla has map $105',
  ).toBe(true)

  await type(page, 'maps', '105')
  await expectRows(page, 'maps', want105)
  await clear(page, 'maps')

  await type(page, 'maps', '$1fc')
  await expectRows(
    page,
    'maps',
    expectedRows(all, n => isSlot(n, 0x1fc)),
  )
  const s = await state(page, 'maps')
  const sel = all.find(n => n.id === s.selected[0])
  expect(sel.index).toBe(0x1fc)
})

test('maps: part of a displayed name finds a map inside a collapsed folder', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const target = all.find(n => n.kind === 'map' && n.parent && n.mapName && n.mapName.length > 4)
  expect(target, 'fixture: a named map inside a folder').toBeTruthy()
  const byId = new Map(all.map(n => [n.id, n]))
  let top = byId.get(target.parent)
  while (top.parent) top = byId.get(top.parent)
  await page.evaluate(
    async ({ id, folder }) => {
      const w = await getWidget(id)
      const f = w.model.root.children.find(c => c.id === folder)
      if (f && f.expanded) await w.model.collapseNode(f)
    },
    { id: IDS.maps, folder: top.id },
  )
  const part = target.mapName.slice(1, 5).toLowerCase()
  const isMatch = n =>
    n.kind !== 'group' && n.kind !== 'message' && (n.mapName || '').toLowerCase().includes(part)
  await type(page, 'maps', part)
  await expectRows(page, 'maps', expectedRows(all, isMatch))
  expect((await state(page, 'maps')).rows).toContain(target.id)
})

test('gfx: a number and a name each leave only matching rows', async ({ page }) => {
  await openExplorer(page, 'gfx')
  const all = await nodes(page, 'gfx')
  await type(page, 'gfx', '$1c')
  await expectRows(
    page,
    'gfx',
    expectedRows(all, n => n.kind === 'file' && n.index === 0x1c),
  )
  await clear(page, 'gfx')
  await type(page, 'gfx', 'map16')
  await expectRows(
    page,
    'gfx',
    expectedRows(all, n => n.kind === 'map16'),
  )
})

test('palettes: a number and a name each leave only matching rows', async ({ page }) => {
  await openExplorer(page, 'palettes')
  const all = await nodes(page, 'palettes')
  await type(page, 'palettes', '$3')
  await expectRows(
    page,
    'palettes',
    expectedRows(all, n => n.kind === 'variant' && n.variant === 3),
  )
  await clear(page, 'palettes')
  await type(page, 'palettes', 'player')
  await expectRows(
    page,
    'palettes',
    expectedRows(all, n => n.kind !== 'note' && n.name.toLowerCase().includes('player')),
  )
})

test('music: a number and a name each leave only matching rows', async ({ page }) => {
  await openExplorer(page, 'music')
  const all = await nodes(page, 'music')
  await type(page, 'music', '$05')
  await expectRows(
    page,
    'music',
    expectedRows(all, n => (n.kind === 'track' || n.kind === 'sfx') && n.bgmCommand === 5),
  )
  await clear(page, 'music')
  await type(page, 'music', 'port')
  await expectRows(
    page,
    'music',
    expectedRows(all, n => n.kind === 'sfxport'),
  )
})
