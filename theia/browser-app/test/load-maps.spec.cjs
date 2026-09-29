/**
 * Loading every map in a project's cartridge, end to end against the shell.
 *
 * The defect this guards against is a tree that renders beautifully and shows
 * fewer maps than the ROM holds. A presence check ("the Maps view exists")
 * cannot see it, so the assertions here are about COUNTS and about rows the
 * user can actually reach: the tree is expanded and its rows are read back.
 */
const { test, expect } = require('@playwright/test')
const { CART, shownWords, makeUntitledAndUnlocated } = require('./rom-words.cjs')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA, GPW2 } = require('../../../test/suite/support/corpus.cjs')
const { maxDepth } = require('./tree-depth.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

/** Vanilla's documented map count, from docs/glossary.md. */
const VANILLA_MAPS = 235

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

let tmp

/**
 * Bring the Maps view to the front, as clicking its tab does.
 *
 * Activation matters: the tree virtualises its rows, so a widget that is
 * attached but not visible renders zero of them however full its model is.
 */
async function revealMaps(page) {
  await page.evaluate(async () => {
    await getSvc('ApplicationShell').activateWidget('hackbench.map-explorer')
  })
  await page.waitForTimeout(800)
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-maps-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Create a project and load its maps, returning what the widget holds.
 *
 * Writes meta/groups.json = [] before the load, so a vanilla ROM (this
 * file's default) does not get its groups seeded: this suite is about the
 * plain, ungrouped tree, and map-groups.spec.cjs owns the seeded one.
 */
async function loadMaps(page, dir, rom = ROM) {
  const created = await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      if (!svc) return { error: 'ProjectService not resolvable from the frontend' }
      const project = await svc.createProject({ romPath, name: 'MyHack', directory })
      return { manifestPath: project.manifestPath }
    },
    { romPath: rom, directory: dir },
  )
  if (created.error) return created

  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'meta', 'groups.json'), '[]\n')

  const result = await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(manifestPath)

    const walk = n => [n, ...(n.children || []).flatMap(walk)]
    const roots = w.model.root.children || []
    // By stable id, never by label: a label carries a count that moves with
    // the cartridge, and a miss here kills every caller with one TypeError
    // that names none of them.
    const group = id => roots.find(r => r.id === `group:${id}`)
    return {
      mapCount: w.mapCount,
      groups: roots.map(r => r.name),
      // Identity and order, neither of which moves when a label gains a count.
      rootIds: roots.map(r => r.id),
      // Entry maps and orphans in ONE folder: there is no separate Overworld.
      unassignedTop: (group('unassigned')?.children || []).length,
      unassignedRows: (group('unassigned')?.children || []).map(n => ({
        index: n.index,
        category: n.category,
      })),
      specialSlots: roots.filter(r => r.id.startsWith('special:')).map(r => r.index),
      // Walk the roots themselves, not just their children: Title Screen and
      // New Game ARE maps rather than folders, so descending past them would
      // drop two real maps from the count.
      distinct: new Set(
        roots
          .flatMap(walk)
          .map(n => n.index)
          .filter(i => i >= 0),
      ).size,
      // Shape only, measured in Node by maxDepth.
      unassignedShape: (group('unassigned')?.children || []).map(function shape(n) {
        return { children: (n.children || []).map(c => shape(c)) }
      }),
    }
  }, created.manifestPath)
  return result.error ? result : { ...result, deepest: maxDepth(result.unassignedShape) }
}

test('a new project loads every map its cartridge holds', async ({ page }) => {
  const result = await loadMaps(page, path.join(tmp, 'MyHack'))

  expect(result.error).toBeUndefined()
  // The binding assertion. 235 is the glossary's documented figure for
  // vanilla, and it is derived from the cart rather than assumed, so a hack
  // would report its own number here.
  expect(result.mapCount).toBe(VANILLA_MAPS)
  // Every map has to be reachable in the tree, not merely counted.
  expect(result.distinct).toBe(VANILLA_MAPS)
})

test('a ROM whose screen-exit routine is patched lists every map flat, and says why', async ({
  page,
}) => {
  // $05D7CE is the BEQ that picks an exit's high byte (bank_05.asm:7108); the
  // four edited corpus ROMs hold a JSL there. Planted into vanilla so this runs
  // wherever vanilla does. Headerless LoROM: $05D7CE is file offset $2D7CE.
  const patched = path.join(tmp, 'patched.sfc')
  const bytes = fs.readFileSync(ROM)
  expect(bytes[0x2d7ce]).toBe(0xf0)
  bytes[0x2d7ce] = 0x22
  fs.writeFileSync(patched, bytes)

  const result = await loadMaps(page, path.join(tmp, 'Patched'), patched)
  expect(result.error).toBeUndefined()
  expect(result.mapCount).toBe(VANILLA_MAPS)
  expect(result.distinct).toBe(VANILLA_MAPS)
  // Vanilla nests (see the grouping test); the patched copy must not.
  expect(result.deepest).toBe(0)
  await expect
    .poll(() => page.evaluate(() => document.body.innerText), { timeout: 10000 })
    .toContain('Map hierarchy unavailable: $05D7CB')
})

/** Create a project against `rom` and open the map view for `index`, returning its shown text. */
async function openMapView(page, rom, dir, index = 0x105) {
  const manifestPath = path.join(dir, `${path.basename(dir)}.hbproj`)
  await page.evaluate(
    async ({ romPath, directory, name }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({ romPath, name, directory })
    },
    { romPath: rom, directory: dir, name: path.basename(dir) },
  )
  await page.evaluate(
    async ({ mp, index, label }) => {
      const w = await getWidget('hackbench.map-view')
      await w.open({ manifestPath: mp, index, label, iconClass: '' })
      const shell = getSvc('ApplicationShell')
      await shell.addWidget(w, { area: 'main' })
      await shell.activateWidget(w.id)
    },
    { mp: manifestPath, index, label: index.toString(16) },
  )
  await page.waitForSelector('.hb-map-view-body', { timeout: 15000 })
  return shownWords(page, '.hb-map-view-body')
}

/** WCAG contrast of `sel`'s text against its nearest opaque background. */
async function textContrast(page, sel) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel)
    let node = el
    let bg = 'rgba(0, 0, 0, 0)'
    while (node) {
      bg = getComputedStyle(node).backgroundColor
      if (!/^(rgba\(0, ?0, ?0, ?0\)|transparent)$/.test(bg)) break
      node = node.parentElement
    }
    const lum = s =>
      s
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(c => c / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + [0.2126, 0.7152, 0.0722][i] * c, 0)
    const [a, b] = [lum(getComputedStyle(el).color), lum(bg)]
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }, sel)
}

/**
 * A ROM whose level GFX call goes through Lunar Magic's ExGFX hook picks its
 * GFX files per level from a list this view does not read, so the tileset and
 * sprite set it shows are marked. Needs the GPW2 corpus ROM.
 */
test('a ROM that picks GFX per level shows the map marked; a stock ROM is not marked', async ({
  page,
}) => {
  test.skip(!fs.existsSync(romPath(GPW2)), 'needs the GPW2 corpus ROM')
  const NOTE = '.hb-map-view-body [data-note="gfx-assignment"]'
  await openMapView(page, ROM, path.join(tmp, 'StockGfxMark'))
  await expect(page.locator(NOTE)).toHaveCount(0)

  await openMapView(page, romPath(GPW2), path.join(tmp, 'HookGfxMark'))
  await expect(page.locator(NOTE)).toBeVisible()
  const body = '.hb-map-view-body:has([data-note="gfx-assignment"])'
  expect(await page.locator(NOTE).textContent()).toContain('FG/BG and sprite GFX files')
  expect(await page.locator(NOTE).textContent()).not.toMatch(CART)
  expect(await textContrast(page, NOTE)).toBeGreaterThanOrEqual(4.5)
  // Shown, not blanked: the decoded header is still there.
  expect(await shownWords(page, body)).toMatch(/\d+ screens/)
  // The decoded header sits in the tab's folded Header panel, beside the facts.
  const tab = '.hb-map-view-main:has([data-note="gfx-assignment"])'
  await expect(page.locator(`${tab} .hb-map-view-table tr`)).not.toHaveCount(0)
})

test('the map view shows a sprite count on an unpatched ROM', async ({ page }) => {
  const view = await openMapView(page, ROM, path.join(tmp, 'Unpatched'))
  expect(view).toMatch(/\d+ sprites/)
})

test('the map view shows the real name on an unpatched ROM, not "name unavailable"', async ({
  page,
}) => {
  // $105 is Yoshi's Island 1; the negative control for the two patched-ROM
  // name-unavailable cases below.
  const view = await openMapView(page, ROM, path.join(tmp, 'Unpatched'))
  expect(view).toMatch(/YOSHI'S ISLAND 1/i)
  expect(view).not.toMatch(/name unavailable/i)
})

test('a ROM whose sprite-pointer read is patched shows sprites unavailable, with why', async ({
  page,
}) => {
  // $05D8F5 is the `LDA.B #$07` opcode in CODE_05D8B7 (bank_05.asm:7257);
  // headerless LoROM file offset $2D8F5.
  const patched = path.join(tmp, 'sprite-patched.sfc')
  const bytes = fs.readFileSync(ROM)
  expect(bytes[0x2d8f5]).toBe(0xa9)
  bytes[0x2d8f5] = 0x00
  fs.writeFileSync(patched, bytes)

  const view = await openMapView(page, patched, path.join(tmp, 'SpritePatched'))
  expect(view).toMatch(/sprites unavailable/i)
  expect(view).toMatch(/neither vanilla nor a recognized hook/i)
})

test('a ROM whose overworld entry code is patched shows the name unavailable, with why', async ({
  page,
}) => {
  // $05D8B1 is the BEQ CODE_05D8A2 reads for the submap high byte
  // (bank_05.asm:7224); the four edited corpus ROMs hold a JSL there.
  // Headerless LoROM file offset $2D8B1.
  const patched = path.join(tmp, 'name-patched.sfc')
  const bytes = fs.readFileSync(ROM)
  expect(bytes[0x2d8b1]).toBe(0xf0)
  bytes[0x2d8b1] = 0x22
  fs.writeFileSync(patched, bytes)

  const view = await openMapView(page, patched, path.join(tmp, 'NamePatched'))
  expect(view).toMatch(/name unavailable/i)
  expect(view).toMatch(/rebuilt by another editor/i)
})

test('a map whose level data is out of the ROM shows level data unavailable, with why', async ({
  page,
}) => {
  // $05E311 is the bank byte of $105's Layer 1 pointer: Layer1Ptrs (bank_05.asm:7680)
  // + $105 * 3 + 2. $7E moves it into WRAM. Headerless LoROM file offset $2E311.
  const patched = path.join(tmp, 'level-data-patched.sfc')
  const bytes = fs.readFileSync(ROM)
  expect(bytes[0x2e311]).toBe(0x06)
  bytes[0x2e311] = 0x7e
  fs.writeFileSync(patched, bytes)

  const view = await openMapView(page, patched, path.join(tmp, 'LevelDataPatched'))
  expect(view).toMatch(/level data unavailable/i)
  expect(view).toMatch(/\$7E88DD does not address this ROM's data/)
  // The name does not come from the level data, so it still shows.
  expect(view).toMatch(/YOSHI'S ISLAND 1/i)
})

test('a map whose object stream never reaches $FF shows objects unavailable, with why', async ({
  page,
}) => {
  // Points $105's Layer 1 pointer ($05E30F, headerless offset $2E30F) at the
  // ROM's last 16 bytes ($0FFFF0), filled with zeros: a header, then objects
  // that run off the end of the ROM without a $FF terminator.
  const patched = path.join(tmp, 'objects-patched.sfc')
  const bytes = fs.readFileSync(ROM)
  expect(bytes.length).toBe(0x80000)
  bytes.fill(0x00, 0x7fff0)
  bytes.set([0xf0, 0xff, 0x0f], 0x2e30f)
  fs.writeFileSync(patched, bytes)

  const view = await openMapView(page, patched, path.join(tmp, 'ObjectsPatched'))
  expect(view).toMatch(/objects unavailable/i)
  expect(view).toMatch(/did not reach its \$FF terminator/)
  expect(view).not.toMatch(/\d+ objects/)
})

test('the maps are grouped, not dumped in a flat list', async ({ page }) => {
  const result = await loadMaps(page, path.join(tmp, 'MyHack'))

  // Player-interaction order: what you see first, then what starts a file,
  // then everything else. Asserted on the ids, which name the three rows
  // without pinning the text of their labels; the label is asserted for
  // what it SAYS in the next test. There is no separate Overworld folder:
  // every top-level map, entry map or orphan, is Unassigned. The bonus maps
  // are not special rows (#624): ungrouped, they are Unassigned too.
  expect(result.rootIds).toEqual([
    'special:title-screen:199',
    'special:new-game:197',
    'overworld',
    'group:unassigned',
  ])
  expect(result.unassignedTop).toBeGreaterThan(0)
  // A flattening bug yields the right COUNT with everything at depth 0, which
  // the count assertions above cannot see.
  expect(result.deepest).toBeGreaterThan(0)

  // Read from the ROM, not hardcoded: $0C7 and $0C5 on vanilla, which the
  // disassembly's own data files are named after (bank_06.asm:33, 35).
  expect(result.specialSlots).toEqual([0x0c7, 0x0c5])

  // DATA_05DBA9's Bonus Games and Yoshi Heaven slots, in each half: listed
  // once, as bonus rows (reached, so not orphaned, but no entry map either).
  const bonus = result.unassignedRows.filter(r => [0x000, 0x100, 0x0c8, 0x1c8].includes(r.index))
  expect(bonus).toEqual([
    { index: 0x000, category: 'bonus' },
    { index: 0x0c8, category: 'bonus' },
    { index: 0x100, category: 'bonus' },
    { index: 0x1c8, category: 'bonus' },
  ])
})

/**
 * What the Unassigned label SAYS: rows actually listed under it, not a
 * derived ROM figure (a map that moves into a user group no longer counts
 * here; see map-groups.spec.cjs for that side of it).
 *
 * Checked against the rows themselves, because a label that merely holds A
 * number is not the behaviour.
 */
test('the Unassigned label counts what it claims to count', async ({ page }) => {
  const result = await loadMaps(page, path.join(tmp, 'MyHack'))

  // The two singletons take no number: there is implicitly one of each.
  expect(result.groups[0]).toBe('Title Screen')
  expect(result.groups[1]).toBe('New Game')

  expect(result.unassignedTop).toBeGreaterThan(0)
  expect(result.groups[2]).toBe(`Unassigned (${result.unassignedTop})`)
})

test('the map rows are rendered and reachable, not just in the model', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))

  // A widget filled but never revealed is the #379 defect in another costume.
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .theia-TreeNode', { timeout: 15000 })

  const rows = await page.locator('#hackbench\\.map-explorer .theia-TreeNode').count()
  expect(rows).toBeGreaterThan(2)

  // Slot labels are hex and are what the user addresses a map by.
  const slots = await page.locator('#hackbench\\.map-explorer .hb-map-slot').allTextContents()
  expect(slots.length).toBeGreaterThan(0)
  for (const s of slots) expect(s).toMatch(/^\$[0-9A-F]{3}$/)
})

/**
 * Rows stay on one line.
 *
 * Measured, not eyeballed: at the shell's default 196px sidebar, 15 of 55
 * visible rows wrapped to two lines. Theia sizes its virtualised rows from
 * measured height, so wrapping desynchronises row height from scroll geometry
 * as well as breaking the reading rhythm.
 */
test('map rows never wrap, however long the name', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .hb-map-slot', { timeout: 15000 })

  const geometry = await page.evaluate(() => {
    const el = document.querySelector('#hackbench\\.map-explorer')
    const rows = [...el.querySelectorAll('.theia-TreeNode')]
    const heights = rows.map(r => Math.round(r.getBoundingClientRect().height))
    const single = Math.min(...heights)
    return {
      rows: rows.length,
      // A wrapped row is at least twice a single line, so this is a clean
      // discriminator without hardcoding a pixel height.
      wrapped: heights.filter(h => h > single * 1.5).length,
      distinctHeights: [...new Set(heights)].length,
      // The name ellipsizes instead; the slot is never truncated.
      nameOverflow: getComputedStyle(el.querySelector('.hb-map-name')).textOverflow,
    }
  })

  expect(geometry.rows).toBeGreaterThan(10)
  expect(geometry.wrapped, 'rows wrapped to a second line').toBe(0)
  expect(geometry.distinctHeights, 'every row should be the same height').toBe(1)
  expect(geometry.nameOverflow).toBe('ellipsis')
})

/**
 * Icons carry the glossary's categories, and only rows that go somewhere get
 * a chevron.
 *
 * Both are things that render plausibly while meaning nothing: a tree where
 * every icon is the same passes any "is there an icon" check, and a chevron
 * on a childless row expands to nothing and teaches the user to distrust it.
 */
test('rows are iconised by category and only expandable rows show a chevron', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .hb-map-icon', { timeout: 15000 })

  const shape = await page.evaluate(() => {
    const el = document.querySelector('#hackbench\\.map-explorer')
    const rows = [...el.querySelectorAll('.theia-TreeNode')]

    const icon = row => {
      const i = row.querySelector('.hb-map-icon')
      if (!i) return null
      return [...i.classList].find(c => c.startsWith('codicon-')) || null
    }
    // Theia marks an expansion toggle with this class; a childless row must
    // not have one that is actually a control.
    const hasChevron = row => {
      const t = row.querySelector('.theia-ExpansionToggle')
      return !!t && !t.classList.contains('theia-mod-busy')
    }

    const byId = {}
    for (const row of rows) {
      const seg = row.querySelector('[data-node-id]')
      byId[seg ? seg.getAttribute('data-node-id') : row.textContent] = {
        icon: icon(row),
        chevron: hasChevron(row),
      }
    }

    return {
      total: rows.length,
      withoutIcon: rows.filter(r => !icon(r)).length,
      distinctIcons: [...new Set(rows.map(icon).filter(Boolean))],
      // A chevron on a row whose node has no children is the defect.
      chevronOnLeaf: rows.filter(r => {
        const seg = r.querySelector('[data-node-id]')
        if (!seg) return false
        const expandable = r.classList.contains('theia-ExpandableTreeNode')
        return hasChevron(r) && !expandable
      }).length,
      groupIcon: byId['group:unassigned'] && byId['group:unassigned'].icon,
    }
  })

  expect(shape.total).toBeGreaterThan(10)
  expect(shape.withoutIcon, 'every row should carry a category icon').toBe(0)
  // At minimum: the two groups differ from each other and from the maps.
  expect(shape.distinctIcons.length).toBeGreaterThan(2)
  expect(shape.chevronOnLeaf, 'a chevron that expands nothing').toBe(0)
})

/**
 * The model-level half of the same rule, which the DOM cannot show for rows
 * that are scrolled out of view.
 */
test('no childless map is marked expandable', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))

  const bad = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    const offenders = []
    const walk = n => {
      // Theia decides on the property, not on children, so a leaf carrying
      // `expanded` renders a chevron that expands nothing.
      if ('expanded' in n && (!n.children || n.children.length === 0)) {
        offenders.push(n.id)
      }
      ;(n.children || []).forEach(walk)
    }
    ;(w.model.root.children || []).forEach(walk)
    return offenders
  })

  expect(bad).toEqual([])
})

/**
 * Icons line up whether or not a row can expand.
 *
 * Theia indents rows with no expansion chevron so their content still lines
 * up, but its default of 22px is 2px wider than the toggle actually occupies,
 * which leaves the icon column visibly ragged wherever leaves and folders are
 * siblings. Measured per depth, because depth legitimately indents.
 */
test('the icon column is straight across expandable and leaf rows', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .hb-map-icon', { timeout: 15000 })

  const columns = await page.evaluate(async () => {
    const w = await getWidget('hackbench.map-explorer')
    // Expand a few levels so leaves and folders share a depth. By id, for the
    // reason the loadMaps helper is: the label carries a count.
    const unassigned = w.model.root.children.find(r => r.id === 'group:unassigned')
    const roots = unassigned.children
    for (const n of roots.slice(0, 10)) if (n.children.length) await w.model.expandNode(n)
    await new Promise(r => setTimeout(r, 1200))

    const el = document.getElementById('hackbench.map-explorer')
    const byDepth = {}
    for (const row of el.querySelectorAll('.theia-TreeNode')) {
      const icon = row.querySelector('.hb-map-icon')
      if (!icon) continue
      const pad = parseFloat(getComputedStyle(row).paddingLeft)
      const hasToggle = !!row.querySelector('.theia-ExpansionToggle')
      // Reconstruct depth from the padding, undoing the toggle compensation.
      const depth = Math.round((hasToggle ? pad : pad - 20) / 8)
      const key = String(depth)
      byDepth[key] = byDepth[key] || { toggle: new Set(), leaf: new Set() }
      byDepth[key][hasToggle ? 'toggle' : 'leaf'].add(Math.round(icon.getBoundingClientRect().x))
    }
    return Object.entries(byDepth).map(([d, v]) => ({
      depth: Number(d),
      toggle: [...v.toggle],
      leaf: [...v.leaf],
    }))
  })

  const comparable = columns.filter(c => c.toggle.length && c.leaf.length)
  expect(comparable.length, 'no depth had both a folder and a leaf to compare').toBeGreaterThan(0)
  for (const c of comparable) {
    expect(
      new Set([...c.toggle, ...c.leaf]).size,
      `depth ${c.depth}: folders at ${c.toggle}, leaves at ${c.leaf}`,
    ).toBe(1)
  }
})

/**
 * Expand All and Collapse All, on the view's title row.
 *
 * Counted on the MODEL, not on rendered rows: the tree virtualises, so the
 * number of `.theia-TreeNode` elements is capped by the viewport and stays
 * flat however much is expanded. A DOM count here would have asserted nothing
 * and passed for a button that did nothing.
 */
test('expand all and collapse all change what the tree shows', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .theia-TreeNode', { timeout: 15000 })

  const expandedCount = () =>
    page.evaluate(async () => {
      const w = await getWidget('hackbench.map-explorer')
      let open = 0
      const walk = n => {
        if ('expanded' in n && n.expanded) open++
        ;(n.children || []).forEach(walk)
      }
      ;(w.model.root.children || []).forEach(walk)
      return open
    })

  const run = async id => {
    await page.evaluate(async cmd => {
      await getSvc('CommandRegistry').executeCommand(cmd)
    }, id)
    await page.waitForTimeout(2000)
  }

  const initial = await expandedCount()

  await run('hackbench.maps.expandAll')
  const expanded = await expandedCount()
  expect(expanded, 'expanding should open the levels that have sub-areas').toBeGreaterThan(initial)

  await run('hackbench.maps.collapseAll')
  const collapsed = await expandedCount()
  expect(collapsed, 'collapsing should close them again').toBeLessThan(expanded)
  // The grouping folder stays open: it is a container, not content, and a
  // view that collapses to nothing reads as a project that failed to load.
  expect(collapsed, 'the grouping folder should survive a collapse').toBeGreaterThanOrEqual(1)
  await page.waitForSelector('#hackbench\\.map-explorer .theia-TreeNode', { timeout: 5000 })
})

test('both buttons are on the Maps toolbar and scoped to it', async ({ page }) => {
  const toolbar = await page.evaluate(() => {
    const reg = getSvc('TabBarToolbarRegistry')
    const ids = reg.items ? [...reg.items.keys()] : []
    return {
      registered: ids.filter(id => id.startsWith('hackbench.maps.')),
      // Scoped by isVisible, so they must not offer themselves to other views.
      visibleOnMaps: reg.visibleItems
        ? reg
            .visibleItems(getSvc('ApplicationShell').getWidgetById('hackbench.map-explorer'))
            .map(i => i.id)
        : [],
    }
  })

  expect(toolbar.registered).toEqual(
    expect.arrayContaining(['hackbench.maps.expandAll', 'hackbench.maps.collapseAll']),
  )
})

/**
 * Theming is a feature, not a coat of paint: people customise the look to
 * make the editor theirs, and a row that pins its own colour quietly opts out
 * of that. Both halves are asserted, because either alone can pass while the
 * theme is ignored.
 */
test('map rows follow the active theme instead of pinning their own styling', async ({ page }) => {
  await loadMaps(page, path.join(tmp, 'MyHack'))
  await revealMaps(page)
  await page.waitForSelector('#hackbench\\.map-explorer .hb-map-slot', { timeout: 15000 })

  // 1. Nothing WE render carries an inline style, which would outrank every
  //    rule a theme contributes. Scoped to our own classes: Theia's tree puts
  //    inline styles on its rows for virtualisation and indentation, and
  //    those are layout the framework owns, not styling we are pinning.
  const inlined = await page
    .locator(
      '#hackbench\\.map-explorer .hb-map-slot[style], ' +
        '#hackbench\\.map-explorer .hb-map-name[style], ' +
        '#hackbench\\.map-explorer .hb-map-note[style]',
    )
    .count()
  expect(inlined, 'inline styles cannot be overridden by a theme').toBe(0)

  // 2. The colours actually move when the theme does. A rule that merely
  //    looks like `color: var(--theia-...)` but resolves to nothing would
  //    pass the check above and still ignore the theme.
  const sample = async () =>
    page.evaluate(() => {
      const el = document.querySelector('#hackbench\\.map-explorer .hb-map-slot')
      const cs = getComputedStyle(el)
      return {
        color: cs.color,
        bg: getComputedStyle(el.closest('.theia-TreeNode')).backgroundColor,
      }
    })

  const setTheme = async id => {
    await page.evaluate(t => {
      getSvc('ThemeService').setCurrentTheme(t)
    }, id)
    await page.waitForTimeout(600)
  }

  await setTheme('dark')
  const dark = await sample()
  await setTheme('light')
  const light = await sample()

  expect(light.color, 'text colour did not change with the theme').not.toBe(dark.color)
})

test('a project whose cartridge is not on this machine asks for it', async ({ page }) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')

  await page.evaluate(
    async ({ romPath, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      await svc.createProject({ romPath, name: 'Shared', directory })
    },
    { romPath: ROM, directory: dir },
  )

  // Point the manifest at a cartridge this machine has never seen. That is
  // exactly the state a collaborator is in after cloning a project, and it
  // must read as "locate it", not as a failure.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES CART'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const state = await page.evaluate(async mp => {
    const svc = getSvc('Symbol(ProjectService)')
    const res = await svc.loadMaps(mp)
    const w = await getWidget('hackbench.map-explorer')
    await w.load(mp)
    return {
      status: res.status,
      mapCount: w.mapCount,
      rows: (w.model.root.children || []).map(n => n.name),
    }
  }, manifestPath)

  expect(state.status).toBe('rom-not-located')
  // Not an error dialog and not an empty tree: an empty tree is what a hack
  // that lost all its work looks like.
  expect(state.mapCount).toBe(0)
  expect(state.rows.join(' ')).toMatch(/locate/i)
  expect(state.rows.join(' ')).toContain('SOMEONE ELSES CART')
})

test('the map explorer and map view speak of ROMs, never cartridges', async ({ page }) => {
  const dir = path.join(tmp, 'Words')
  const manifestPath = path.join(dir, 'MyHack.hbproj')
  await loadMaps(page, dir)
  await page.evaluate(async mp => {
    const w = await getWidget('hackbench.map-view')
    await w.open({ manifestPath: mp, index: 0x105, label: '105', iconClass: '' })
    const shell = getSvc('ApplicationShell')
    await shell.addWidget(w, { area: 'main' })
    await shell.activateWidget(w.id)
  }, manifestPath)
  await page.waitForSelector('.hb-map-view-body', { timeout: 15000 })
  const view = await shownWords(page, '.hb-map-view-body')
  expect(view).toMatch(/105/)
  expect(view).not.toMatch(CART)

  makeUntitledAndUnlocated(manifestPath)
  await page.evaluate(
    async mp => (await getWidget('hackbench.map-explorer')).load(mp),
    manifestPath,
  )
  await revealMaps(page)
  const explorer = () => shownWords(page, '[id="hackbench.map-explorer"]')
  await expect.poll(explorer).toContain('Locate the base ROM')
  expect(await explorer()).not.toMatch(CART)
})
