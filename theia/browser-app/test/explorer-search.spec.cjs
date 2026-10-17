/**
 * Explorer search and filter (#336), driven with real keystrokes on the real
 * tree: type to filter, Ctrl+F, Escape to clear.
 *
 * What is asserted is the set of rows the tree DRAWS (`widget.rows`, which
 * already applies Theia's filter), compared with an expected set computed here
 * from the loaded model: every row that matches, its ancestors, and everything
 * under a matching folder, drawn only where the folders above are open. That
 * catches a stray visible row as well as a missing one, which "the match is on
 * screen" would not. `rowOf` below restates the texts each explorer matches
 * (the raw folder name, never its "(N)" count), so the oracle and the app
 * agree on WHAT is text; it is a mirror and must be kept in step.
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

/**
 * Loads the project into one explorer, brings it to the front and focuses its
 * tree. `viaApp` opens the project the way File > Open does (the Maps explorer
 * is then wired to the map views); otherwise the explorer is loaded directly.
 */
async function openExplorer(page, which, { viaApp = false } = {}) {
  const manifestPath = await page.evaluate(
    async ({ romPath, directory, id, viaApp }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Search',
        directory,
      })
      const w = await getWidget(id)
      if (viaApp) await getSvc('HackBenchContribution').openPath(project.manifestPath)
      else await w.load(project.manifestPath)
      await getSvc('ApplicationShell').activateWidget(id)
      w.node.focus()
      // Every open request the explorer fires, so a test can say what opened.
      window.__opens = []
      for (const ev of ['onMapOpened', 'onFileOpened', 'onMap16Opened', 'onOpen']) {
        if (w[ev]) w[ev](e => window.__opens.push(e))
      }
      return project.manifestPath
    },
    { romPath: ROM, directory: tmp, id: IDS[which], viaApp },
  )
  await page.waitForTimeout(800)
  return manifestPath
}

const opens = page => page.evaluate(() => window.__opens)

// True when drawn; else the diagnostics, so a red poll names its own cause.
async function boxOrDiag(page, which) {
  const s = await state(page, which)
  return s.boxVisible || JSON.stringify(s.diag)
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
    const msg = document.querySelector(`#${CSS.escape(id)} .hb-explorer-no-match`)
    const box = w.node.getBoundingClientRect()
    const r = msg?.getBoundingClientRect()
    // Visible: non-empty, inside the widget's own rect, and what the browser
    // would hit at its centre (not covered by a full-height tree).
    const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    const sb = w.searchBox?.node.getBoundingClientRect()
    // Rendered, not just flagged: a ReactWidget draws only on an update
    // request, so isVisible alone is true for an empty, zero-size node (#336).
    const inner = w.searchBox?.node.querySelector('.theia-search-box')
    const ir = inner?.getBoundingClientRect()
    // And hit-tested at its centre, so a clipped or covered box fails too.
    const ihit = ir && document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2)
    const boxRendered = Boolean(
      inner &&
      w.searchBox.node.querySelector('.theia-search-input') &&
      ir.width > 0 &&
      ir.height > 0 &&
      ihit &&
      w.searchBox.node.contains(ihit),
    )
    const rect = q => q && [q.left, q.top, q.right, q.bottom].map(Math.round)
    return {
      rows: [...w.rows.values()].map(row => row.node.id),
      selected: w.model.selectedNodes.map(n => n.id),
      expanded: expanded.sort(),
      boxVisible: w.searchBox ? w.searchBox.isVisible && boxRendered : false,
      treeFocused: w.node.contains(document.activeElement),
      // Failure diagnostics: what covers the message, and what could eat a key.
      diag: {
        msg: rect(r),
        widget: rect(box),
        searchBox: w.searchBox?.isVisible ? rect(sb) : null,
        // Flagged shown but not drawn (or covered): the #336 T4 failure itself.
        flaggedNotDrawn: Boolean(w.searchBox?.isVisible && !boxRendered),
        boxInner: rect(ir),
        boxHit: ihit ? `${ihit.tagName}.${ihit.className}` : null,
        hit: hit ? `${hit.tagName}.${hit.className}` : null,
        toasts: document.querySelectorAll('.theia-notification-list-item').length,
      },
      empty: msg?.textContent ?? null,
      emptyVisible: Boolean(
        r &&
        r.width > 0 &&
        r.height > 0 &&
        r.top >= box.top &&
        r.bottom <= box.bottom &&
        r.left >= box.left &&
        r.right <= box.right &&
        hit &&
        msg.contains(hit),
      ),
    }
  }, IDS[which])
}

/**
 * The search box's text field: there must be a real <input>, drawn, hit-testable
 * at its centre, and the element that holds keyboard focus (owner T4: buttons
 * showed, no input, focus snapped back to the tree).
 */
async function inputState(page, which) {
  return page.evaluate(async id => {
    const w = await getWidget(id)
    const el = w.searchBox?.node.querySelector('input')
    const r = el?.getBoundingClientRect()
    const hit = r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return {
      exists: Boolean(el),
      drawn: Boolean(r && r.width > 20 && r.height > 8 && hit === el),
      focused: Boolean(el) && document.activeElement === el,
      value: el ? el.value : null,
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
          row: n.row,
          bgmCommand: n.bgmCommand,
          bgmHex: n.bgmHex,
          bank: n.bank,
          alias: n.alias,
          noPointer: n.noPointer,
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

/** The texts and id each explorer matches a node on (mirrors the widgets' searchRow). */
function rowOf(which, n) {
  const name = n.name ?? ''
  if (which === 'maps') {
    if (n.kind === 'message') return null
    if (n.kind === 'group') {
      const raw = n.id === 'group:unassigned' ? 'Unassigned' : n.id.replace(/^group:user:/, '')
      return { folder: true, texts: [raw] }
    }
    // Loop, truncated and no-pointer rows are markers: Enter opens nothing on them.
    const openable = n.kind === 'map' && !n.noPointer
    if (n.category === 'overworld' || n.category === 'overworld-area') {
      return { openable, texts: [name] }
    }
    if (n.category === 'title-screen' || n.category === 'new-game') {
      return { id: n.index, openable, texts: [name] }
    }
    return { id: n.index >= 0 ? n.index : undefined, openable, texts: [n.mapName ?? ''] }
  }
  if (which === 'gfx') {
    if (n.kind === 'file') return { id: n.index, texts: [name] }
    if (n.kind === 'map16') return { texts: [name] }
    return null
  }
  if (which === 'palettes') {
    // A group's CGRAM row is shown in decimal; a variant's id is the number ending its label.
    if (n.kind === 'group') return { decId: n.row, texts: [name] }
    if (n.kind === 'variant') {
      const trailing = /(\d+)$/.exec(name)
      return { id: trailing ? Number(trailing[1]) : undefined, texts: [name] }
    }
    return null
  }
  if (n.kind === 'track') return { id: n.bgmCommand, texts: [n.alias] }
  if (n.kind === 'sfx') return { id: n.bgmCommand, texts: [] }
  if (n.kind === 'message') return null
  return { folder: true, texts: [n.kind === 'sfxport' ? name.replace(/ \(.*\)$/, '') : name] }
}

/** Independent restatement of the query rules, for the oracle. */
function rowMatches(q, row) {
  const text = q.trim()
  const idOnly = /^(\$|0x)/i.test(text)
  const hex = text.replace(/^\$/, '').replace(/^0x/i, '')
  const id = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : null
  if (text === '' || /^(\$|0x)$/i.test(text)) return false
  if (id !== null && row.id === id) return true
  if (row.decId !== undefined && /^\d+$/.test(text) && Number(text) === row.decId) return true
  if (idOnly) return false
  return row.texts.some(t => t.toLowerCase().includes(text.toLowerCase()))
}

/** Matching nodes in tree order, and every id kept: matches, ancestors, a folder match's contents. */
function expectation(all, which, q) {
  const byId = new Map(all.map(n => [n.id, n]))
  const under = (n, ancestorId) => {
    for (let c = n; c; c = c.parent ? byId.get(c.parent) : null) {
      if (c.id === ancestorId) return true
    }
    return false
  }
  const matches = []
  const keep = new Set()
  for (const n of all) {
    const row = rowOf(which, n)
    if (!row || !rowMatches(q, row)) continue
    matches.push({ ...n, folder: Boolean(row.folder), openable: row.openable !== false })
    for (let c = n; c; c = c.parent ? byId.get(c.parent) : null) keep.add(c.id)
    if (row.folder) for (const d of all) if (under(d, n.id)) keep.add(d.id)
  }
  return { matches, keep }
}

/** Of the kept ids, those the tree draws: every ancestor open. */
function drawn(all, keep, expanded) {
  const byId = new Map(all.map(n => [n.id, n]))
  const open = new Set(expanded)
  return [...keep]
    .filter(id => {
      for (let p = byId.get(id)?.parent; p; p = byId.get(p).parent) if (!open.has(p)) return false
      return true
    })
    .sort()
}

async function type(page, which, text) {
  await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
  await page.keyboard.type(text)
}

/** The drawn rows are exactly what the oracle says, and the filter opened every match's ancestors. */
async function expectFiltered(page, which, all, q) {
  const { matches, keep } = expectation(all, which, q)
  expect(matches.length, `fixture: "${q}" must match something`).toBeGreaterThan(0)
  await expect
    .poll(
      async () => {
        const s = await state(page, which)
        return JSON.stringify(s.rows.sort()) === JSON.stringify(drawn(all, keep, s.expanded))
      },
      { timeout: 10000, message: `rows for "${q}"` },
    )
    .toBe(true)
  const s = await state(page, which)
  const byId = new Map(all.map(n => [n.id, n]))
  for (const m of matches) {
    for (let p = m.parent; p; p = byId.get(p).parent) {
      expect(s.expanded, `ancestor ${p} of match ${m.id} open`).toContain(p)
    }
  }
  return { matches, keep, s }
}

async function clear(page, which) {
  // Core binds Escape to "hide notifications" while any is up, at the document,
  // before the tree sees the key. Maps raises an info toast on load, so the
  // first Escape would dismiss that and never reach the search box.
  await page.evaluate(id => {
    getSvc('CommandRegistry').executeCommand('notifications.commands.hide')
    return getWidget(id).then(w => w.node.focus())
  }, IDS[which])
  await page.keyboard.press('Escape')
}

const NO_MATCH = {
  maps: 'No maps match "zzzq".',
  gfx: 'No graphics files match "zzzq".',
  palettes: 'No palettes match "zzzq".',
  music: 'No tracks or sound effects match "zzzq".',
}

for (const which of Object.keys(IDS)) {
  test(`${which}: a query with no matches says so, visibly, in words`, async ({ page }) => {
    await openExplorer(page, which)
    await type(page, which, 'zzzq')
    await expect.poll(async () => (await state(page, which)).empty).toBe(NO_MATCH[which])
    // Inside the widget's own rect and hit by the browser at its centre:
    // textContent alone passes while the message sits below the fold.
    const shown = await state(page, which)
    expect(shown.emptyVisible, JSON.stringify(shown.diag)).toBe(true)
    expect((await state(page, which)).rows).toEqual([])
    await clear(page, which)
    await expect.poll(async () => (await state(page, which)).empty).toBeNull()
    // widget.rows is rebuilt by Theia's debounced updateRows after the render
    // flips back, so the rows return a beat after the empty state goes.
    await expect.poll(async () => (await state(page, which)).rows.length).toBeGreaterThan(0)
  })

  // A guard, not a feature proof: develop has no search, so this also passes
  // there. It only pins that a half-typed id leaves the tree alone.
  test(`${which}: a bare $ or 0x is a half-typed id: nothing filters, no empty state`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    const before = (await state(page, which)).rows.length
    expect(before).toBeGreaterThan(0)
    for (const q of ['$', '0x']) {
      await type(page, which, q)
      await page.waitForTimeout(600)
      const s = await state(page, which)
      expect(s.rows.length, q).toBe(before)
      expect(s.empty, q).toBeNull()
      await clear(page, which)
    }
  })

  // Ctrl+F is taken by core's own Find before any DOM listener on the tree,
  // so this only passes when the explorer registers a handler for that command.
  test(`${which}: Ctrl+F opens the search box on the focused explorer`, async ({ page }) => {
    await openExplorer(page, which)
    await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
    await page.keyboard.press('Control+f')
    await expect.poll(async () => boxOrDiag(page, which)).toBe(true)
    expect((await inputState(page, which)).focused).toBe(true)
    await clear(page, which)
    await expect.poll(async () => (await state(page, which)).boxVisible).toBe(false)
  })
}

// GFX is a flat list: nothing to fold, so a restore assertion there would
// pass on any code. The restore claim is proven on the three trees with folders.
for (const which of ['maps', 'palettes', 'music']) {
  test(`${which}: Escape restores the exact prior expansion, at every depth`, async ({ page }) => {
    await openExplorer(page, which)
    const all = await nodes(page, which)
    // Start with everything folded, then open one folder that sits below a
    // folded one (the case a breadth-first restore that stops at a folded
    // folder gets wrong).
    const nested = all.filter(
      n => n.expandable && n.parent && all.find(p => p.id === n.parent)?.expandable,
    )
    const pick = nested[nested.length - 1] ?? all.filter(n => n.expandable).pop()
    await page.evaluate(
      async ({ id, open }) => {
        const w = await getWidget(id)
        const walk = async n => {
          if ('expanded' in n && n.expanded) await w.model.collapseNode(n)
          for (const c of n.children || []) await walk(c)
        }
        await walk(w.model.root)
        const find = (n, t) =>
          n.id === t ? n : (n.children || []).map(c => find(c, t)).find(Boolean)
        await w.model.expandNode(find(w.model.root, open))
      },
      { id: IDS[which], open: pick.id },
    )
    const before = await state(page, which)
    expect(before.expanded).toEqual([pick.id])

    // A leaf with an id whose chain holds a folded folder, so the filter must open something.
    const byId = new Map(all.map(n => [n.id, n]))
    const deep = all.find(n => {
      const row = rowOf(which, n)
      if (!row || row.folder || row.id === undefined || row.id < 0 || !n.parent) return false
      for (let p = n.parent; p; p = byId.get(p).parent) {
        if (!before.expanded.includes(p)) return true
      }
      return false
    })
    expect(deep, 'fixture: a leaf with an id under a folded folder').toBeTruthy()
    const q = `$${rowOf(which, deep).id.toString(16)}`

    await page.evaluate(id => getWidget(id).then(w => w.node.focus()), IDS[which])
    await page.keyboard.press('Control+f')
    await type(page, which, q)
    await expect.poll(async () => (await state(page, which)).expanded).not.toEqual(before.expanded)

    await clear(page, which)
    await expect.poll(async () => (await state(page, which)).expanded).toEqual(before.expanded)
    expect((await state(page, which)).boxVisible).toBe(false)
  })
}

test('maps: bare 1fc finds slot $1FC and selects it without opening a tab', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  expect(
    all.some(n => n.index === 0x1fc),
    'fixture: vanilla has map $1FC',
  ).toBe(true)
  await type(page, 'maps', '1fc')
  const { matches, s } = await expectFiltered(page, 'maps', all, '1fc')
  expect(matches.some(m => m.index === 0x1fc)).toBe(true)
  // Select-first lands on a map, not on a folder or other incidental match.
  const first = matches.find(m => !m.folder)
  expect(s.selected[0]).toBe(first.id)
  // Typing selects, but must not open a preview tab per keystroke.
  expect(await opens(page)).toEqual([])
})

test('maps: $1fc is id-only, and 105 leaves its slot and anything named 105', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  await type(page, 'maps', '$1fc')
  const r = await expectFiltered(page, 'maps', all, '$1fc')
  expect(r.matches.map(m => m.index)).toEqual([0x1fc])
  await clear(page, 'maps')
  await type(page, 'maps', '105')
  await expectFiltered(page, 'maps', all, '105')
})

/** A word shared by a few named maps, so there is a "next" match; read from the model. */
function sharedWord(all) {
  const words = new Set(
    all.flatMap(n => (n.mapName ?? '').toLowerCase().split(' ')).filter(w => w.length > 3),
  )
  return [...words].find(w => {
    const { matches } = expectation(all, 'maps', w)
    const openable = matches.filter(m => !m.folder && m.openable)
    return matches.length >= 2 && matches.length <= 40 && openable.length >= 1
  })
}

const mapViewIds = page =>
  page.evaluate(() =>
    getSvc('ApplicationShell')
      .widgets.map(w => w.id)
      .filter(id => id.startsWith('hackbench.map-view:')),
  )

test('maps: Down moves through the matches in tree order', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const word = sharedWord(all)
  expect(word, 'fixture: a word shared by 2 to 40 matches').toBeTruthy()
  const { matches } = expectation(all, 'maps', word)
  // Select-first skips folders and marker rows (loop, truncated, no pointer).
  const first = matches.find(m => !m.folder && m.openable)
  await type(page, 'maps', word)
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(first.id)
  expect(await opens(page)).toEqual([])

  // Theia cycles the matches, wrapping at the end.
  const next = matches[(matches.findIndex(m => m.id === first.id) + 1) % matches.length]
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(next.id)
})

// Through the app's own wiring (File > Open), not w.load: Enter must end in a
// pinned map view, which no explorer-level event listener can show.
test('maps: Enter opens the selected match in a map view; typing alone opens none', async ({
  page,
}) => {
  await openExplorer(page, 'maps', { viaApp: true })
  const all = await nodes(page, 'maps')
  const word = sharedWord(all)
  expect(word, 'fixture: a word shared by 2 to 40 matches').toBeTruthy()
  const first = expectation(all, 'maps', word).matches.find(m => !m.folder && m.openable)
  await type(page, 'maps', word)
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(first.id)
  await page.waitForTimeout(600)
  expect(await mapViewIds(page), 'select-first alone opens no map view').toEqual([])

  await page.keyboard.press('Enter')
  await expect.poll(() => mapViewIds(page)).toEqual([`hackbench.map-view:${first.index}`])
})

test('gfx: Enter opens the matched file', async ({ page }) => {
  await openExplorer(page, 'gfx')
  await type(page, 'gfx', '$1c')
  await expect.poll(async () => (await state(page, 'gfx')).selected.length).toBe(1)
  expect(await opens(page)).toEqual([])
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await opens(page)).map(o => o.index)).toEqual([0x1c])
})

test('maps: a multi-word name can be typed, space included, and Space opens nothing', async ({
  page,
}) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const named = all.find(n => n.kind === 'map' && /^\S+ \S+/.test(n.mapName ?? ''))
  expect(named, 'fixture: a map whose name has two words').toBeTruthy()
  const [w1, w2] = named.mapName.toLowerCase().split(' ')
  await type(page, 'maps', w1)
  await expectFiltered(page, 'maps', all, w1)
  const before = await state(page, 'maps')
  // The space is text for the box: it must not act as Space on the tree, which
  // would open the selected map or toggle a folder. A trailing space leaves the
  // filter itself unchanged, so any difference is the key's own doing.
  await page.keyboard.type(' ')
  await page.waitForTimeout(600)
  const afterSpace = await state(page, 'maps')
  expect(afterSpace.expanded).toEqual(before.expanded)
  expect(afterSpace.selected).toEqual(before.selected)
  expect(await opens(page)).toEqual([])

  await page.keyboard.type(w2)
  const q = `${w1} ${w2}`
  const { matches } = await expectFiltered(page, 'maps', all, q)
  expect(matches.map(m => m.id)).toContain(named.id)
  expect(await opens(page)).toEqual([])
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
  await type(page, 'maps', part)
  await expectFiltered(page, 'maps', all, part)
  expect((await state(page, 'maps')).rows).toContain(target.id)
})

test('maps: a folder matches on its name alone, not its count, and shows its contents', async ({
  page,
}) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const folder = all.find(n => n.id === 'group:unassigned')
  expect(folder, 'fixture: the Unassigned folder').toBeTruthy()
  // Shown as "Unassigned (N, ...)": the count is caption, not text.
  expect(folder.name).toMatch(/^Unassigned \(/)
  await page.evaluate(async id => {
    const w = await getWidget(id)
    const f = w.model.root.children.find(c => c.id === 'group:unassigned')
    if (f.expanded) await w.model.collapseNode(f)
  }, IDS.maps)

  await type(page, 'maps', 'unassigned (')
  await expect
    .poll(async () => (await state(page, 'maps')).empty)
    .toBe('No maps match "unassigned (".')
  await clear(page, 'maps')

  await type(page, 'maps', 'unassigned')
  const { keep, matches } = expectation(all, 'maps', 'unassigned')
  expect(matches.map(m => m.id)).toEqual(['group:unassigned'])
  // Its own match does not open it...
  await expect.poll(async () => (await state(page, 'maps')).rows).toEqual(['group:unassigned'])
  expect((await state(page, 'maps')).expanded).not.toContain('group:unassigned')
  // ...it is the one match, so it is selected; and opening it shows all its contents.
  expect((await state(page, 'maps')).selected).toEqual(['group:unassigned'])
  await page.evaluate(async id => {
    const w = await getWidget(id)
    await w.model.expandNode(w.model.root.children.find(c => c.id === 'group:unassigned'))
  }, IDS.maps)
  const kids = all.filter(n => n.parent === 'group:unassigned').map(n => n.id)
  await expect
    .poll(async () => (await state(page, 'maps')).rows.sort())
    .toEqual(['group:unassigned', ...kids].sort())
  expect(kids.every(k => keep.has(k))).toBe(true)
})

test('maps: reloading the project while filtering filters the new rows again', async ({ page }) => {
  const manifest = await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  await type(page, 'maps', '$105')
  await expectFiltered(page, 'maps', all, '$105')
  await page.evaluate(async ({ id, manifest }) => (await getWidget(id)).load(manifest), {
    id: IDS.maps,
    manifest,
  })
  await page.waitForTimeout(800)
  const after = await nodes(page, 'maps')
  await expectFiltered(page, 'maps', after, '$105')
})

test('gfx: a number and a name each leave only matching rows', async ({ page }) => {
  await openExplorer(page, 'gfx')
  const all = await nodes(page, 'gfx')
  await type(page, 'gfx', '$1c')
  await expectFiltered(page, 'gfx', all, '$1c')
  await clear(page, 'gfx')
  await type(page, 'gfx', 'map16')
  await expectFiltered(page, 'gfx', all, 'map16')
  await clear(page, 'gfx')
  // The shown label is text, so the name as printed finds its file.
  await type(page, 'gfx', 'gfx $1c')
  await expectFiltered(page, 'gfx', all, 'gfx $1c')
})

test('palettes: a variant number, a group row number and a name each leave only matching rows', async ({
  page,
}) => {
  await openExplorer(page, 'palettes')
  const all = await nodes(page, 'palettes')
  await type(page, 'palettes', '$3')
  const r = await expectFiltered(page, 'palettes', all, '$3')
  expect(r.matches.some(m => m.kind === 'variant' && m.variant === 3)).toBe(true)
  await clear(page, 'palettes')

  // The view shows a group's CGRAM row in decimal ("CGRAM 14"), so bare digits are decimal.
  const group = all.find(n => n.kind === 'group' && n.row !== undefined && n.row > 9)
  expect(group, 'fixture: a group that targets a CGRAM row above 9').toBeTruthy()
  const q = String(group.row)
  await type(page, 'palettes', q)
  const g = await expectFiltered(page, 'palettes', all, q)
  expect(g.matches.map(m => m.id)).toContain(group.id)
  await clear(page, 'palettes')

  await type(page, 'palettes', 'player')
  await expectFiltered(page, 'palettes', all, 'player')
})

test('music: a number and a name each leave only matching rows', async ({ page }) => {
  await openExplorer(page, 'music')
  const all = await nodes(page, 'music')
  await type(page, 'music', '$05')
  await expectFiltered(page, 'music', all, '$05')
  await clear(page, 'music')
  await type(page, 'music', 'port')
  await expectFiltered(page, 'music', all, 'port')
  await clear(page, 'music')
  // "port 0 ($1DF9)" is a caption: the address in it is not searchable text.
  await type(page, 'music', '1df9')
  await expect
    .poll(async () => (await state(page, 'music')).empty)
    .toBe('No tracks or sound effects match "1df9".')
})

test('palettes: "palette 3" finds the Palette 3 variants; $1 does not find a named one', async ({
  page,
}) => {
  await openExplorer(page, 'palettes')
  const all = await nodes(page, 'palettes')
  await type(page, 'palettes', 'palette 3')
  const r = await expectFiltered(page, 'palettes', all, 'palette 3')
  expect(r.matches.every(m => /palette 3/i.test(m.name))).toBe(true)
  await clear(page, 'palettes')

  // A named variant (Luigi) has no number in its label, so it has no id.
  const luigi = all.find(n => n.kind === 'variant' && n.name === 'Luigi')
  expect(luigi, 'fixture: the Luigi variant').toBeTruthy()
  await type(page, 'palettes', '$1')
  const s1 = await expectFiltered(page, 'palettes', all, '$1')
  expect(s1.matches.map(m => m.id)).not.toContain(luigi.id)
  expect(s1.s.rows).not.toContain(luigi.id)
})

test('music: an alias set the way the app does finds only that track', async ({ page }) => {
  const manifest = await openExplorer(page, 'music')
  const track = (await nodes(page, 'music')).find(n => n.kind === 'track' && n.bank)
  expect(track, 'fixture: a track with a bank').toBeTruthy()
  // renameSelected asks for the name, then does exactly these two calls.
  await page.evaluate(
    async ({ id, manifest, track }) => {
      await getSvc('Symbol(MusicService)').setTrackAlias(
        manifest,
        track.bank,
        track.bgmCommand,
        'Zorp Theme',
      )
      await (await getWidget(id)).load(manifest)
    },
    { id: IDS.music, manifest, track },
  )
  const all = await nodes(page, 'music')
  expect(all.find(n => n.id === track.id).alias).toBe('Zorp Theme')
  await type(page, 'music', 'zorp th')
  const r = await expectFiltered(page, 'music', all, 'zorp th')
  expect(r.matches.map(m => m.id)).toEqual([track.id])
  const trackRows = r.s.rows.filter(id => all.find(n => n.id === id)?.kind === 'track')
  expect(trackRows).toEqual([track.id])
})

test('maps: an alias from meta/aliases.json finds only its map', async ({ page }) => {
  const manifest = await openExplorer(page, 'maps')
  const before = await nodes(page, 'maps')
  const target = before.find(n => n.kind === 'map' && n.index >= 0 && n.category === 'entry')
  expect(target, 'fixture: an entry map with a slot').toBeTruthy()
  // The file the project keeps map names in: namespace 'map', hex slot key.
  const key = target.index.toString(16).toUpperCase().padStart(2, '0')
  const metaDir = path.join(path.dirname(manifest), 'meta')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(
    path.join(metaDir, 'aliases.json'),
    JSON.stringify({ map: { [key]: 'Castle Rush Zq' } }),
  )
  await page.evaluate(async ({ id, manifest }) => (await getWidget(id)).load(manifest), {
    id: IDS.maps,
    manifest,
  })
  await expect
    .poll(
      () => page.evaluate(async id => (await getWidget(id)).mapAliases, IDS.maps).then(a => a[key]),
      { message: 'the reload picked up the alias' },
    )
    .toBe('Castle Rush Zq')
  const all = await nodes(page, 'maps')
  await type(page, 'maps', 'rush zq')
  // The filter runs after Theia's 200 ms debounce, so the unfiltered tree is
  // on screen first: wait for the narrowed result itself, not for "some rows".
  const slotIndexes = async () => {
    const rows = (await state(page, 'maps')).rows
    const slots = rows.map(id => all.find(n => n.id === id)).filter(n => n && n.index >= 0)
    return [...new Set(slots.map(n => n.index))]
  }
  await expect
    .poll(slotIndexes, { timeout: 10000, message: 'filtered to the aliased map' })
    .toEqual([target.index])
  // Search matches what the tree displays: the alias is drawn on that row.
  const shown = await page.evaluate(
    ({ id, nodeId }) =>
      document.querySelector(`#${CSS.escape(id)} [data-node-id="${CSS.escape(nodeId)}"]`)
        ?.textContent ?? null,
    { id: IDS.maps, nodeId: all.find(n => n.index === target.index && n.alias).id },
  )
  expect(shown, 'the aliased row draws its alias').toContain('Castle Rush Zq')
})

test('maps: a bad aliases.json keeps the maps and shows a note saying why', async ({ page }) => {
  const manifest = await openExplorer(page, 'maps')
  const metaDir = path.join(path.dirname(manifest), 'meta')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(path.join(metaDir, 'aliases.json'), '[1, 2]')
  await page.evaluate(async ({ id, manifest }) => (await getWidget(id)).load(manifest), {
    id: IDS.maps,
    manifest,
  })
  await expect
    .poll(async () =>
      (await nodes(page, 'maps')).find(
        n => n.kind === 'message' && /^Map names unavailable.*aliases\.json/.test(n.name ?? ''),
      ),
    )
    .toBeTruthy()
  expect((await nodes(page, 'maps')).some(n => n.kind === 'map' && n.index >= 0)).toBe(true)
})

test('maps: a bad groups.json and a bad aliases.json both show their note', async ({ page }) => {
  const manifest = await openExplorer(page, 'maps')
  const metaDir = path.join(path.dirname(manifest), 'meta')
  fs.mkdirSync(metaDir, { recursive: true })
  fs.writeFileSync(path.join(metaDir, 'groups.json'), '{ not json')
  fs.writeFileSync(path.join(metaDir, 'aliases.json'), '[1, 2]')
  await page.evaluate(async ({ id, manifest }) => (await getWidget(id)).load(manifest), {
    id: IDS.maps,
    manifest,
  })
  // The DRAWN rows (what the tree renders), not just the model: two notes
  // sharing an id would leave one of them out.
  await expect
    .poll(async () => {
      const s = await state(page, 'maps')
      const notes = (await nodes(page, 'maps')).filter(
        n => n.kind === 'message' && s.rows.includes(n.id),
      )
      return notes.map(n => n.name.replace(/:.*$/, '')).sort()
    })
    .toEqual(['Groups unavailable', 'Map names unavailable'])
  const ids = (await state(page, 'maps')).rows.filter(id => id.startsWith('message'))
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids.length).toBe(2)
})

/**
 * The text each explorer DRAWS for one row's id, in the base it is drawn. These
 * guard D79 call 5 and cannot go red on code that already matches the drawn
 * text; they exist so a later change to a row's label or its matcher does.
 */
const DISPLAYED_ID = {
  maps: n => (n.kind === 'map' && n.index >= 0 && n.category === 'entry' ? n.name : null),
  gfx: n => (n.kind === 'file' ? n.name.replace(/^GFX\s+/, '') : null),
  // A group row draws no CGRAM row; a variant draws "Palette 12", so type its number.
  palettes: n => (n.kind === 'variant' ? ((/(\d+)$/.exec(n.name ?? '') ?? [])[1] ?? null) : null),
  music: n => (n.kind === 'track' && n.bgmHex ? n.bgmHex : null),
}

// Bound: every row of a kind would be up to 512 typed queries for maps, so the
// sweep takes at most SWEEP_MAX rows, evenly spaced, always including the first
// and the last. Each sampled row is typed as displayed and without the $.
const SWEEP_MAX = 24
function sweepSample(rows) {
  if (rows.length <= SWEEP_MAX) return rows
  const picked = new Set([0, rows.length - 1])
  for (let i = 0; i < SWEEP_MAX; i++)
    picked.add(Math.round((i * (rows.length - 1)) / (SWEEP_MAX - 1)))
  return [...picked].sort((x, y) => x - y).map(i => rows[i])
}

for (const which of Object.keys(IDS)) {
  test(`${which}: typing a sample of rows' ids exactly as displayed, with and without $, keeps each row`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    const all = await nodes(page, which)
    const candidates = all.filter(n => DISPLAYED_ID[which](n))
    expect(candidates.length, 'fixture: rows with a displayed id').toBeGreaterThan(0)
    for (const target of sweepSample(candidates)) {
      const shown = DISPLAYED_ID[which](target)
      for (const q of new Set([shown, shown.replace(/^\$/, '')])) {
        await type(page, which, q)
        await expect
          .poll(async () => (await state(page, which)).rows, {
            message: `"${q}" keeps ${target.id}`,
          })
          .toContain(target.id)
        await clear(page, which)
      }
    }
  })
}

// A root with only a message (no project yet) has nothing to filter; saying "No
// maps match" would hide why the tree is empty.
for (const which of Object.keys(IDS)) {
  test(`${which}: with no project, typing keeps the explorer's own message`, async ({ page }) => {
    await page.evaluate(
      id =>
        getSvc('ApplicationShell')
          .activateWidget(id)
          .then(() => null),
      IDS[which],
    )
    const rootRows = await page.evaluate(
      id => getWidget(id).then(w => (w.model.root?.children ?? []).length),
      IDS[which],
    )
    if (which !== 'maps') expect(rootRows, 'fixture: a message row').toBeGreaterThan(0)
    await type(page, which, 'zzzq')
    await page.waitForTimeout(800)
    const s = await state(page, which)
    expect(s.empty).toBeNull()
    expect(s.rows.length).toBe(rootRows)
  })
}

test('maps: opening another project closes the search and clears its filter', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  await type(page, 'maps', '$105')
  const { s } = await expectFiltered(page, 'maps', all, '$105')
  expect(s.boxVisible).toBe(true)
  const filtered = s.rows.length
  fs.mkdirSync(path.join(tmp, 'second'))
  await page.evaluate(
    async ({ romPath, directory }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Second',
        directory,
      })
      await (await getWidget('hackbench.map-explorer')).load(project.manifestPath)
    },
    { romPath: ROM, directory: path.join(tmp, 'second') },
  )
  await expect.poll(async () => (await state(page, 'maps')).boxVisible).toBe(false)
  await expect.poll(async () => (await state(page, 'maps')).rows.length).toBeGreaterThan(filtered)
})

// The toolbar button, not Ctrl+F, for every explorer.
const FIND_QUERY = { maps: '$105', gfx: '$1c', palettes: '$3', music: '$05' }
for (const which of Object.keys(IDS)) {
  test(`${which}: the toolbar Find button opens the search box, and typing filters`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    const all = await nodes(page, which)
    expect((await state(page, which)).boxVisible).toBe(false)
    await page.locator('[id="hackbench.explorer.find"]:visible').first().click()
    // Before any key: the box is drawn (boxVisible checks the DOM rect) and
    // its input holds focus. The keys go straight into it: type() would
    // refocus the tree and hide a focus bug.
    await expect.poll(async () => boxOrDiag(page, which)).toBe(true)
    expect((await inputState(page, which)).focused).toBe(true)
    await page.keyboard.type(FIND_QUERY[which])
    await expectFiltered(page, which, all, FIND_QUERY[which])
  })
}

// Owner T4 (#336): Ctrl+F after a real row click showed nothing. The box must
// be drawn on open (boxVisible checks the DOM rect), its input takes focus,
// and typing then filters.
test('maps: after a real row click, Ctrl+F draws the search box before any key, and typing filters', async ({
  page,
}) => {
  await openExplorer(page, 'maps', { viaApp: true })
  const all = await nodes(page, 'maps')
  const drawn = await page.evaluate(
    id =>
      [...document.querySelectorAll(`#${CSS.escape(id)} [data-node-id]`)].map(el =>
        el.getAttribute('data-node-id'),
      ),
    IDS.maps,
  )
  const leaves = all.filter(n => drawn.includes(n.id) && n.kind === 'map' && !n.noPointer)
  const target = leaves.find(n => n.index >= 0)
  const other = leaves.find(n => n.id !== target?.id && n.index !== target?.index && n.index >= 0)
  expect(target && other, 'fixture: two drawn openable map rows').toBeTruthy()
  const q = `$${target.index.toString(16)}`
  expect(rowMatches(q, rowOf('maps', other)), 'fixture: the other row does not match').toBe(false)

  await page.locator(`[id="${IDS.maps}"] [data-node-id="${target.id}"]`).first().click()
  await expect.poll(() => mapViewIds(page)).toEqual(['hackbench.map-view:preview'])
  await page.keyboard.press('Control+f')
  await expect.poll(async () => boxOrDiag(page, 'maps')).toBe(true)
  expect((await inputState(page, 'maps')).focused).toBe(true)
  const before = (await state(page, 'maps')).rows.length
  await page.keyboard.type(q)
  await expectFiltered(page, 'maps', all, q)
  const s = await state(page, 'maps')
  expect(s.rows.length).toBeLessThan(before)
  expect(s.rows).toContain(target.id)
  expect(s.rows).not.toContain(other.id)
})

// Owner T4 (#336), second report: the box showed its buttons but no input, and
// focus went back to the tree. Typing must land IN the input, with no refocus
// of the tree by the test, and the tree must filter from it.
for (const which of Object.keys(IDS)) {
  test(`${which}: Find opens a real input that takes focus, and typing there filters the tree`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    const all = await nodes(page, which)
    await page.locator('[id="hackbench.explorer.find"]:visible').first().click()
    await expect
      .poll(async () => JSON.stringify(await inputState(page, which)), {
        message: 'an input is drawn and focused',
      })
      .toContain('"drawn":true,"focused":true')
    const q = FIND_QUERY[which]
    await page.keyboard.type(q)
    await expect
      .poll(async () => (await inputState(page, which)).value, {
        message: 'the typed text is in the input',
      })
      .toBe(q)
    await expectFiltered(page, which, all, q)
    // Still the input after the filter ran: the tree must not take focus back.
    expect((await inputState(page, which)).focused).toBe(true)
    // Backspace edits the text and Escape closes the box and returns to the tree.
    await page.keyboard.press('Backspace')
    await expect.poll(async () => (await inputState(page, which)).value).toBe(q.slice(0, -1))
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await state(page, which)).boxVisible).toBe(false)
    expect((await state(page, which)).treeFocused).toBe(true)
  })
}

// Search matches what the tree displays (D113): a group's CGRAM row is found
// by its decimal number, so the row must say it. A one-variant group is a
// leaf (no expansion toggle) and a multi-variant group is expandable: both.
test('palettes: every kind of group row draws the CGRAM row number its search matches', async ({
  page,
}) => {
  await openExplorer(page, 'palettes')
  const all = await nodes(page, 'palettes')
  const groups = all.filter(n => n.kind === 'group' && n.row !== undefined)
  const leaf = groups.find(n => !n.expandable)
  const folder = groups.find(n => n.expandable)
  expect(leaf && folder, 'fixture: a one-variant and a multi-variant group').toBeTruthy()
  for (const group of [leaf, folder]) {
    const shown = await page.evaluate(
      ({ id, nodeId }) =>
        document.querySelector(`#${CSS.escape(id)} [data-node-id="${CSS.escape(nodeId)}"]`)
          ?.textContent ?? null,
      { id: IDS.palettes, nodeId: group.id },
    )
    expect(shown, `${group.id} is drawn`).not.toBeNull()
    expect(shown).toContain(`Row ${group.row}`)
  }
})

/** Click Find, wait for the focused input. */
async function openFind(page, which) {
  await page.locator('[id="hackbench.explorer.find"]:visible').first().click()
  await expect
    .poll(async () => JSON.stringify(await inputState(page, which)))
    .toContain('"drawn":true,"focused":true')
}

const inputFocused = async (page, which) => (await inputState(page, which)).focused

// Input path, no tree refocus anywhere (owner T4): Enter, Down and Up act from the input.
test('maps: from the input, Down and Up move the selection and Enter opens the match', async ({
  page,
}) => {
  await openExplorer(page, 'maps', { viaApp: true })
  const all = await nodes(page, 'maps')
  const word = sharedWord(all)
  expect(word, 'fixture: a word shared by 2 to 40 matches').toBeTruthy()
  const { matches } = expectation(all, 'maps', word)
  const first = matches.find(m => !m.folder && m.openable)
  await openFind(page, 'maps')
  await page.keyboard.type(word)
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(first.id)
  await page.waitForTimeout(600)
  expect(await mapViewIds(page), 'typing alone opens no map view').toEqual([])
  const next = matches[(matches.findIndex(m => m.id === first.id) + 1) % matches.length]
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(next.id)
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await state(page, 'maps')).selected[0]).toBe(first.id)
  expect(await inputFocused(page, 'maps'), 'arrows leave focus in the input').toBe(true)
  // Moving the selection previews it, on the tree path too (the Maps explorer
  // opens the preview map view on any one-row selection change): same here.
  await expect.poll(() => mapViewIds(page)).toEqual(['hackbench.map-view:preview'])
  await page.keyboard.press('Enter')
  await expect.poll(() => mapViewIds(page)).toContain(`hackbench.map-view:${first.index}`)
})

// Enter right after the last key, inside the 200 ms debounce: it must act on
// the text just typed, not on the previous query's selection.
test('maps: Enter typed straight after the text opens the NEW match', async ({ page }) => {
  await openExplorer(page, 'maps', { viaApp: true })
  const all = await nodes(page, 'maps')
  const target = all.find(n => n.kind === 'map' && n.category === 'entry' && n.index >= 0)
  const q = `$${target.index.toString(16)}`
  const want = expectation(all, 'maps', q).matches.find(m => !m.folder && m.openable)
  await openFind(page, 'maps')
  await page.keyboard.type(q)
  await page.keyboard.press('Enter')
  await expect.poll(() => mapViewIds(page)).toEqual([`hackbench.map-view:${want.index}`])
})

// A no-match query turns the box red; emptying the text must turn it back.
test('maps: emptying the text after a no-match clears the red state', async ({ page }) => {
  await openExplorer(page, 'maps')
  await openFind(page, 'maps')
  await page.keyboard.type('zzzq')
  const red = () =>
    page.evaluate(
      id =>
        getWidget(id).then(
          w => w.searchBox.node.querySelector('.theia-search-box.no-match') !== null,
        ),
      IDS.maps,
    )
  await expect.poll(red, { message: 'no match turns the box red' }).toBe(true)
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace')
  await expect.poll(async () => (await inputState(page, 'maps')).value).toBe('')
  await expect.poll(red, { message: 'empty text is not red' }).toBe(false)
})

// A real mouse press on a box button must not take focus from the input.
test('maps: pressing the Next button leaves focus in the input', async ({ page }) => {
  await openExplorer(page, 'maps')
  const all = await nodes(page, 'maps')
  const word = sharedWord(all)
  expect(word, 'fixture: a shared word').toBeTruthy()
  await openFind(page, 'maps')
  await page.keyboard.type(word)
  await expectFiltered(page, 'maps', all, word)
  await page.locator('.theia-search-box-widget:visible .codicon-find-next-match').first().click()
  expect(await inputFocused(page, 'maps')).toBe(true)
})

// Core hides notifications on Escape in the capture phase, before the input
// sees it: with a toast showing, the FIRST Escape must still close the box.
for (const which of Object.keys(IDS)) {
  test(`${which}: Escape in the input closes the box on the first press with a toast showing`, async ({
    page,
  }) => {
    await openExplorer(page, which)
    await page.evaluate(() => {
      // Braces: info() resolves only when the toast closes, so returning it hangs.
      getSvc('MessageService').info('A toast that stays up for this test')
    })
    await expect
      .poll(() => page.locator('.theia-notification-list-item').count(), {
        message: 'a notification is visible',
      })
      .toBeGreaterThan(0)
    await openFind(page, which)
    await page.keyboard.type(FIND_QUERY[which])
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await state(page, which)).boxVisible).toBe(false)
    expect((await state(page, which)).treeFocused).toBe(true)
  })
}
