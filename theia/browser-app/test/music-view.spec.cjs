/**
 * The audio explorer, end to end against the shell.
 *
 * Two defects shape this file. Issue #379 shipped a view that was
 * registered and populated but unreachable from the UI, so nothing here
 * asserts "the widget exists" - every check goes through a gesture a user
 * can make, or a count read from the ROM. And a control that renders while
 * doing nothing passes an "is it on screen" check, so the transport is
 * checked by what it CHANGES.
 *
 * The panel deliberately does NOT open a tab when a row is clicked, unlike
 * the map and graphics explorers. That is asserted directly rather than
 * left implicit, because the preview-tab pattern is the house default and a
 * later change could reintroduce it without anything else failing.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
// Absolute path into the main checkout, overridable via HB_ROM: the same
// convention every sibling spec uses, since test/roms/ is gitignored and a
// worktree does not carry its own copy of the corpus.
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'
const ROM_UNREADABLE_BANK =
  process.env.HB_ROM_UNREADABLE_BANK || 'C:/Projects/hackbench/test/roms/Grand Poo World 2 1.1.sfc'

/**
 * Per-bank song counts for the stock ROM, measured across the six-ROM
 * corpus and pinned in test/suite/unit/MusicCatalog.rom.test.ts. Repeated
 * here as literals rather than read back from the code under test.
 */
const STOCK = { level: 29, overworld: 9, credits: 12 }
const STOCK_TOTAL = STOCK.level + STOCK.overworld + STOCK.credits

/** The stock level music bank's ROM address, cited in the footer. */
const LEVEL_BANK_ADDR = '$0EAED6'

/**
 * Commands in the stock level bank sharing a song with another command:
 * $04 with $16 and $0F with $10, so 27 songs sit behind 29 commands.
 */
const SHARED_COMMANDS = ['$04', '$0F', '$10', '$16']

/** Real maps on the stock ROM, all attributed to level-bank commands. */
const STOCK_REAL_MAPS = 235

/** Real maps on Grand Poo World 2, whose banks cannot be located. */
const GPW2_REAL_MAPS = 291

const PANEL = '#hackbench\\.music-explorer'

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
 * Bring the panel to the front by clicking its actual activity-bar tab,
 * not by calling ApplicationShell.activateWidget: a programmatic activate
 * cannot tell "wired to the shell" apart from "reachable by the gesture a
 * user makes", which is the whole of #379.
 */
async function revealMusic(page) {
  await page.locator('#shell-tab-hackbench\\.map-explorer').click()
  await page.locator('#shell-tab-hackbench\\.music-explorer').click()
  await page.waitForSelector(`${PANEL} .theia-TreeNode`, { timeout: 15000 })
}

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-music-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  // Contributions finish registering slightly after the shell paints;
  // shared with load-maps.spec.cjs's identical wait for the same reason.
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Create a project, load its audio, and report what the widget holds. */
async function loadMusic(page, dir, romPath = ROM) {
  return page.evaluate(
    async ({ romPath, directory }) => {
      const projects = getSvc('Symbol(ProjectService)')
      if (!projects) return { error: 'ProjectService not resolvable from the frontend' }
      const project = await projects.createProject({ romPath, name: 'MyHack', directory })
      const w = await getWidget('hackbench.music-explorer')
      await w.load(project.manifestPath)

      const roots = w.model.root.children || []
      const tracks = []
      const walk = n => {
        if (n.kind === 'track') tracks.push(n)
        for (const c of n.children || []) walk(c)
      }
      for (const r of roots) walk(r)

      const musicGroup = roots.find(r => r.id === 'group:music')
      const sfxGroup = roots.find(r => r.id === 'group:sfx')
      return {
        manifestPath: project.manifestPath,
        trackCount: w.trackCount,
        groups: roots.map(r => r.id),
        banks: (musicGroup ? musicGroup.children : []).map(b => ({
          name: b.name,
          count: b.children.length,
          summary: b.summary,
        })),
        sfxChildren: (sfxGroup ? sfxGroup.children : []).map(c => c.name),
        rootNames: roots.map(r => r.name),
        refusals: [...w.refusals.values()],
        provenance: [...w.provenance.entries()].map(([k, v]) => `${k}=${v}`),
        trackTotal: tracks.length,
        mapCounts: tracks.map(t => (t.maps || []).length),
        sharedRows: tracks
          .filter(t => t.bank === 'level' && (t.sharedWith || []).length > 0)
          .map(t => t.bgmHex),
        creditsShared: tracks.filter(t => t.bank === 'credits' && (t.sharedWith || []).length > 0)
          .length,
        levelTracks: tracks.filter(t => t.bank === 'level').length,
      }
    },
    { romPath, directory: dir },
  )
}

test('the ROM groups the audio, and the tree shows those groups', async ({ page }) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  expect(result.error).toBeUndefined()
  expect(result.groups).toEqual(['group:music', 'group:sfx'])
  // Counts read from the ROM, not assumed: a hack whose banks differ
  // reports its own.
  expect(result.banks).toEqual([
    { name: 'level', count: STOCK.level, summary: String(STOCK.level) },
    { name: 'overworld', count: STOCK.overworld, summary: String(STOCK.overworld) },
    { name: 'credits', count: STOCK.credits, summary: String(STOCK.credits) },
  ])
  expect(result.trackCount).toBe(STOCK_TOTAL)
  expect(result.trackTotal).toBe(STOCK_TOTAL)
})

test('the sfx group holds one folder per APU port', async ({ page }) => {
  // Grouped by port for the same reason the music banks are grouped: id
  // $05 on port 0 is a different sound from $05 on port 3. The contents of
  // each folder are covered by sfx-explorer.spec.cjs.
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  expect(result.groups).toContain('group:sfx')
  expect(result.sfxChildren).toEqual(['port 0 ($1DF9)', 'port 3 ($1DFC)'])
})

test('tracks carry the maps that play them, which is the ROM-derived attribution', async ({
  page,
}) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  // Eight level-header slots select a command, so at least eight rows carry
  // maps. A panel showing none would mean the attribution walk returned
  // nothing and said nothing about it.
  expect(result.mapCounts.filter(n => n > 0).length).toBeGreaterThanOrEqual(8)
  expect(result.mapCounts.reduce((a, b) => a + b, 0)).toBe(STOCK_REAL_MAPS)
})

test('commands sharing one song are marked as sharing it', async ({ page }) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  // Per bank, because sharing is a property of one bank's pointer table.
  // The level bank shares two pairs; the credits bank is far more extreme,
  // with twelve command slots resolving to four songs, so every one of its
  // rows is shared and a combined assertion would say nothing useful.
  expect(result.sharedRows.sort()).toEqual(SHARED_COMMANDS)
  expect(result.creditsShared).toBe(STOCK.credits)
})

test('the explorer is in the activity bar beside the other explorers', async ({ page }) => {
  await loadMusic(page, path.join(tmp, 'MyHack'))

  const side = await page.evaluate(() =>
    getSvc('ApplicationShell')
      .getWidgets('left')
      .map(w => w.id),
  )
  expect(side).toContain('hackbench.music-explorer')
})

test('the rows render and are reachable through the activity-bar tab', async ({ page }) => {
  await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  // Not an exact count: TreeWidget virtualises rows, so the DOM count
  // depends on viewport height. Exact counts are asserted on the model.
  expect(await page.locator(`${PANEL} .theia-TreeNode`).count()).toBeGreaterThan(2)
  const groups = await page.locator(`${PANEL} .hb-music-groupname`).allTextContents()
  expect(groups).toContain('music')
})

/**
 * The instruction this panel exists to honour. Clicking a row selects it
 * and opens NOTHING: the transport belongs in the panel, so a tab would
 * put the play controls away from the list they act on.
 */
test('clicking a row selects it and does not open a tab', async ({ page }) => {
  await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  const tabsBefore = await page.locator('#theia-main-content-panel .lm-TabBar-tab').count()
  await page.locator(`${PANEL} .theia-TreeNode`).first().click()

  // Selection really moved, so this is not "no tab appeared because
  // nothing happened at all".
  const selected = await page.evaluate(async () => {
    const w = await getWidget('hackbench.music-explorer')
    const sel = w.model.selectedNodes[0]
    return sel ? sel.id : null
  })
  expect(selected).toBeTruthy()

  expect(await page.locator('#theia-main-content-panel .lm-TabBar-tab').count()).toBe(tabsBefore)
  // The detail tab this panel replaced is gone for good.
  await expect(page.locator('.hb-music-view')).toHaveCount(0)
})

test('the transport is rendered when there is something playable', async ({ page }) => {
  await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  await expect(page.locator(`${PANEL} [data-transport="true"]`)).toBeVisible({ timeout: 15000 })
  for (const action of ['prev', 'play', 'stop', 'next']) {
    await expect(page.locator(`${PANEL} [data-action="${action}"]`)).toBeVisible()
  }
  await expect(page.locator(`${PANEL} [data-volume="true"]`)).toBeVisible()
})

test('the port toggles say they restart the track, because they do', async ({ page }) => {
  // The engine cannot write an SPC port once a snapshot is loaded, so both
  // rebuild and reload. A control that silently half-works is worse than
  // one that explains itself; the promise is in the title attribute.
  await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  for (const toggle of ['hurry-up', 'yoshi-drums']) {
    const el = page.locator(`${PANEL} [data-toggle="${toggle}"]`)
    await expect(el).toBeVisible()
    await expect(el).toHaveAttribute('aria-pressed', 'false')
    expect(await el.getAttribute('title')).toMatch(/restarts the track/i)
  }

  // Engaging one really latches, rather than only restyling.
  await page.locator(`${PANEL} [data-toggle="hurry-up"]`).click()
  await expect(page.locator(`${PANEL} [data-toggle="hurry-up"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const latched = await page.evaluate(
    async () => (await getWidget('hackbench.music-explorer')).hurryUp,
  )
  expect(latched).toBe(true)
})

test('a track builds a playable SPC carrying the selected port bytes', async ({ page }) => {
  // Goes through the service rather than the speakers: CI has no audio
  // device, and what is worth pinning is that the snapshot is well formed
  // and carries the right byte on the right port.
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  const built = await page.evaluate(async mp => {
    const music = getSvc('Symbol(MusicService)')
    const A = 256 // where a .spc file's ARAM dump starts
    const plain = await music.trackSpc(mp, 'level', 0x02, {})
    const hurry = await music.trackSpc(mp, 'level', 0x02, { hurryUp: true })
    const yoshi = await music.trackSpc(mp, 'level', 0x02, { yoshiDrums: true })
    return {
      size: plain.length,
      header: String.fromCharCode(...plain.slice(0, 27)),
      bgmOnPort2: plain[A + 0xf6],
      plainPort0: plain[A + 0xf4],
      hurryPort0: hurry[A + 0xf4],
      yoshiPort1: yoshi[A + 0xf5],
    }
  }, result.manifestPath)

  expect(built.header).toBe('SNES-SPC700 Sound File Data')
  expect(built.size).toBe(65920)
  expect(built.bgmOnPort2).toBe(0x02)
  // Absent unless asked for, or every track would play with a stray SFX.
  expect(built.plainPort0).toBe(0)
  expect(built.hurryPort0).toBe(0xff) // !SFX_HURRYUP, constants.asm:322
  expect(built.yoshiPort1).toBe(0x02) // !SFX_YOSHIDRUMON, constants.asm:325
})

test('the SPC engine assets are served, and nothing else is', async ({ page }) => {
  const served = await page.evaluate(async () => {
    const probe = async u => {
      const r = await fetch(u)
      return { status: r.status, type: r.headers.get('content-type') }
    }
    return {
      js: await probe('/hackbench/spc/spc.js'),
      wasm: await probe('/hackbench/spc/spc.wasm'),
      unlisted: await probe('/hackbench/spc/spc_player.css'),
    }
  })

  expect(served.js.status).toBe(200)
  expect(served.js.type).toMatch(/javascript/)
  expect(served.wasm.status).toBe(200)
  expect(served.wasm.type).toBe('application/wasm')
  // The route serves two files by name, not a directory: a static mount
  // would also publish whatever a future version of the package ships.
  expect(served.unlisted.status).toBe(404)
})

test('the footer cites the selected bank address and size', async ({ page }) => {
  await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  await page.evaluate(async () => {
    const w = await getWidget('hackbench.music-explorer')
    const music = w.model.root.children.find(r => r.id === 'group:music')
    const level = music.children.find(b => b.name === 'level')
    w.model.selectNode(level.children[0])
    w.update()
  })

  const footer = page.locator(`${PANEL} [data-provenance="true"]`)
  await expect(footer).toBeVisible({ timeout: 15000 })
  const text = await footer.textContent()
  expect(text).toContain(LEVEL_BANK_ADDR)
  expect(text).toMatch(/\d+ bytes/)
})

test('naming a track persists it and shows it in the row', async ({ page }) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  const named = await page.evaluate(async mp => {
    const music = getSvc('Symbol(MusicService)')
    const stored = await music.setTrackAlias(mp, 'level', 0x05, '  Boss fight  ')
    const w = await getWidget('hackbench.music-explorer')
    await w.load(mp)
    const bank = w.model.root.children
      .find(r => r.id === 'group:music')
      .children.find(b => b.name === 'level')
    const row = bank.children.find(n => n.bgmCommand === 0x05)
    return { stored, alias: row.alias, name: row.name }
  }, result.manifestPath)

  // Trimmed on the way in, so a stray space is not a different name.
  expect(named.stored).toBe('Boss fight')
  expect(named.alias).toBe('Boss fight')
  expect(named.name).toBe('Boss fight')

  // And it is on disk, not just in the widget.
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'))
  expect(manifest.aliases['music.level']['05']).toBe('Boss fight')
})

test('a name given in one bank does not rename the same command in another', async ({ page }) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))

  const both = await page.evaluate(async mp => {
    const music = getSvc('Symbol(MusicService)')
    await music.setTrackAlias(mp, 'level', 0x02, 'Grass')
    const level = await music.loadBank(mp, 'level')
    const overworld = await music.loadBank(mp, 'overworld')
    const pick = res => res.bank.tracks.find(t => t.bgmCommand === 0x02).alias
    return { level: pick(level), overworld: pick(overworld) }
  }, result.manifestPath)

  // BGM $02 is a different song in each bank, so naming one must not touch
  // the other.
  expect(both.level).toBe('Grass')
  expect(both.overworld).toBe('')
})

test('a project whose ROM is not on this machine asks for it', async ({ page }) => {
  const dir = path.join(tmp, 'Shared')
  const manifestPath = path.join(dir, 'Shared.hbproj')

  await page.evaluate(
    async ({ romPath, directory }) => {
      const projects = getSvc('Symbol(ProjectService)')
      await projects.createProject({ romPath, name: 'Shared', directory })
    },
    { romPath: ROM, directory: dir },
  )

  // Point the manifest at a ROM this machine has never seen, exactly the
  // state a collaborator is in after cloning a project.
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.baseRom.sha256 = 'f'.repeat(64)
  manifest.baseRom.title = 'SOMEONE ELSES ROM'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

  const state = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.music-explorer')
    await w.load(mp)
    return {
      trackCount: w.trackCount,
      rows: (w.model.root.children || []).map(n => n.name),
    }
  }, manifestPath)

  // Not an error dialog and not an empty tree: an empty tree is what a
  // hack that lost all its work looks like.
  expect(state.trackCount).toBe(0)
  expect(state.rows.join(' ')).toMatch(/locate/i)
  expect(state.rows.join(' ')).toContain('SOMEONE ELSES ROM')
})

/**
 * A ROM whose music-bank upload routines have been replaced (AddmusicK does
 * this) must read as a refusal WITH what is still knowable, not as "no
 * music": a soundtrack-focused hack reporting zero tracks is
 * indistinguishable from a ROM HackBench cannot read unless the UI says
 * which.
 */
test('a ROM whose banks cannot be read says why and still lists what the maps ask for', async ({
  page,
}) => {
  test.skip(
    !fs.existsSync(ROM_UNREADABLE_BANK),
    `ROM fixture not present on this machine (${ROM_UNREADABLE_BANK})`,
  )
  const result = await loadMusic(page, path.join(tmp, 'Unreadable'), ROM_UNREADABLE_BANK)
  expect(result.error).toBeUndefined()

  // All three banks refuse on this ROM.
  expect(result.refusals).toHaveLength(3)
  expect(result.refusals[0]).toMatch(/could not be verified/i)
  expect(result.refusals[0]).toContain('$009702')
  // User-facing prose says ROM, never cartridge.
  expect(result.refusals.join(' ')).not.toMatch(/cartridge/i)
  expect(result.provenance).toHaveLength(0)

  // The fallback: the commands this ROM's maps ask for, with counts, under
  // each bank rather than nothing at all.
  expect(result.levelTracks).toBe(8)
  expect(result.mapCounts.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(GPW2_REAL_MAPS)
  expect(result.rootNames.join(' ')).not.toMatch(/no bgm tracks/i)
})

test('no transport is offered on a ROM where nothing can play', async ({ page }) => {
  test.skip(
    !fs.existsSync(ROM_UNREADABLE_BANK),
    `ROM fixture not present on this machine (${ROM_UNREADABLE_BANK})`,
  )
  // A row of buttons that cannot work is a worse answer than none; the
  // refusal in the footer is what explains it.
  await loadMusic(page, path.join(tmp, 'Unreadable'), ROM_UNREADABLE_BANK)
  await revealMusic(page)

  await expect(page.locator(`${PANEL} [data-transport="true"]`)).toHaveCount(0)
})

/**
 * The panel is closable, and a closed widget is disposed and evicted from
 * WidgetManager, so reopening builds a fresh instance. This is the only
 * test that closes it, so it is the only one that can catch a regression
 * where the reopened panel comes back inert.
 */
test('closing and reopening the panel leaves it working', async ({ page }) => {
  const result = await loadMusic(page, path.join(tmp, 'MyHack'))
  await revealMusic(page)

  await page.evaluate(async () => {
    const w = await getWidget('hackbench.music-explorer')
    w.close()
  })
  await expect(page.locator('#shell-tab-hackbench\\.music-explorer')).toHaveCount(0)

  await page.evaluate(async () => {
    await getSvc('CommandRegistry').executeCommand('hackbench.music.focus')
  })
  const after = await page.evaluate(async mp => {
    const w = await getWidget('hackbench.music-explorer')
    await w.load(mp)
    return w.trackCount
  }, result.manifestPath)

  expect(after).toBe(STOCK_TOTAL)
  await page.waitForSelector(`${PANEL} .theia-TreeNode`, { timeout: 15000 })
})
