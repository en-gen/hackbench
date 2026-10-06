/* global HB_COUNT, hbState, hbPick */
/**
 * Every explorer reloads when the project's ROM location changes (#576), and
 * keeps the user's place across an ordinary edit.
 *
 * A relocation can only point at another copy of the SAME ROM (a different
 * one is refused), so "reloaded" cannot mean "shows other content". It means:
 * an explorer that was stuck on "Locate the ROM" fills in, collapsed with
 * nothing selected; and one that was already filled in rebuilds from scratch
 * (a selection or expansion made before the move is gone). Counts come from
 * the widgets' own state, never from "the tree is visible".
 *
 * The per-edit notice is the other path: selection and expansion of rows that
 * still exist survive it (Palettes only: Maps does not subscribe to edits).
 * The edit event is fired locally on the frontend client, the same call the
 * backend's push makes.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

/** Vanilla's documented map count, from docs/glossary.md. */
const VANILLA_MAPS = 235

const IN_PAGE = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
const HB_COUNT = {
  maps: w => w.mapCount,
  palettes: w => (w.model.root.children || []).filter(c => c.kind === 'group').length,
  graphics: w => w.fileCount,
  music: w => w.trackCount,
}
function hbWalk(n) {
  return [n, ...(n.children || []).flatMap(hbWalk)]
}
/** First selectable row; one with children and an expand state is preferred. */
function hbPick(w) {
  const rows = (w.model.root.children || []).flatMap(hbWalk).filter(n => 'selected' in n)
  return rows.find(n => (n.children || []).length > 0 && 'expanded' in n) || rows[0]
}
/** Selection and expansion, as plain data. */
function hbState(w) {
  const rows = (w.model.root.children || []).flatMap(hbWalk)
  return {
    selected: w.model.selectedNodes.map(n => n.id),
    expanded: rows.filter(n => n.expanded).map(n => n.id).sort(),
  }
}`

/** perEdit: the explorer re-reads on the edit event and must keep its place. */
const EXPLORERS = [
  { kind: 'maps', id: 'hackbench.map-explorer', perEdit: false },
  {
    kind: 'palettes',
    id: 'hackbench.palette-explorer',
    perEdit: true,
  },
  { kind: 'graphics', id: 'hackbench.gfx-explorer', perEdit: false },
  {
    kind: 'music',
    id: 'hackbench.music-explorer',
    perEdit: false,
  },
]

let tmp

test.describe('explorer reload (#576)', () => {
  test.skip(!fs.existsSync(ROM), 'needs the vanilla corpus ROM')

  test.beforeEach(async ({ page }) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reload-'))
    await page.goto(APP, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
    await page.waitForTimeout(4000)
    await page.addScriptTag({ content: IN_PAGE })
  })

  test.afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  })

  async function createProject(page, name, rom) {
    return page.evaluate(
      ({ romPath, directory, name }) =>
        getSvc('Symbol(ProjectService)').createProject({ romPath, name, directory }),
      { romPath: rom, directory: path.join(tmp, name), name },
    )
  }

  /** Create the explorer, point it at the project, and wait for its first load. */
  async function openExplorer(page, ex, project) {
    await page.evaluate(
      async ({ ex, project }) => {
        const w = await getSvc('WidgetManager').getOrCreateWidget(ex.id)
        // Maps is loaded by the open-project command, the rest by the context.
        if (ex.kind === 'maps') await w.load(project.manifestPath)
        else getSvc('ProjectContext').current = project
        await getSvc('ApplicationShell').activateWidget(ex.id)
      },
      { ex, project },
    )
  }

  const count = (page, ex) =>
    page.evaluate(({ ex }) => HB_COUNT[ex.kind](getSvc('WidgetManager').tryGetWidget(ex.id)), {
      ex,
    })
  const state = (page, ex) =>
    page.evaluate(({ ex }) => hbState(getSvc('WidgetManager').tryGetWidget(ex.id)), { ex })

  /** Resolves once the explorer has swapped in a new tree (every load does). */
  async function markRoot(page, ex) {
    await page.evaluate(
      ({ ex }) => {
        window.__root0 = getSvc('WidgetManager').tryGetWidget(ex.id).model.root
      },
      { ex },
    )
  }
  const rebuilt = (page, ex) =>
    expect
      .poll(() =>
        page.evaluate(
          ({ ex }) => getSvc('WidgetManager').tryGetWidget(ex.id).model.root !== window.__root0,
          { ex },
        ),
      )
      .toBe(true)

  /** Relocate through the Project Properties dialog, as a user does, and Save. */
  async function relocateViaProperties(page, project, moved) {
    await page.evaluate(
      async ({ p, moved }) => {
        getSvc('ProjectContext').current = p
        const dlg = getSvc('ProjectPropertiesDialog')
        dlg.fileDialog.showOpenDialog = async () => ({ path: { fsPath: () => moved } })
        void getSvc('CommandRegistry').executeCommand('hackbench.project.properties')
      },
      { p: project, moved },
    )
    await page.waitForSelector('.hb-dialog-facts', { timeout: 15000 })
    await page.locator('.dialogBlock button:has-text("Browse...")').first().click()
    await expect
      .poll(() => page.locator('.dialogBlock input[readonly]').first().inputValue())
      .toBe(moved)
    await page.locator('.dialogBlock .theia-button.main').click()
  }

  for (const ex of EXPLORERS) {
    test(`${ex.kind}: a ROM waiting to be located fills in after Project Properties relocates it`, async ({
      page,
    }) => {
      // The only registered copy is deleted before anything reads it, so the
      // explorer opens on "Locate the ROM".
      const gone = path.join(tmp, 'gone.sfc')
      fs.copyFileSync(ROM, gone)
      const project = await createProject(page, 'Revive', gone)
      fs.rmSync(gone)
      await openExplorer(page, ex, project)
      await expect.poll(() => count(page, ex)).toBe(0)
      await page.waitForTimeout(500)
      expect(await count(page, ex)).toBe(0)

      const moved = path.join(tmp, 'moved.sfc')
      fs.copyFileSync(ROM, moved)
      await relocateViaProperties(page, project, moved)

      if (ex.kind === 'maps') await expect.poll(() => count(page, ex)).toBe(VANILLA_MAPS)
      else await expect.poll(() => count(page, ex), { timeout: 30000 }).toBeGreaterThan(0)
      expect((await state(page, ex)).selected).toEqual([])
    })

    for (const via of ['service', 'properties']) {
      test(`${ex.kind}: a ROM swap (${via}) under a loaded explorer rebuilds it, nothing selected, default expansion`, async ({
        page,
      }) => {
        const project = await createProject(page, 'Loaded', ROM)
        await openExplorer(page, ex, project)
        await expect.poll(() => count(page, ex), { timeout: 30000 }).toBeGreaterThan(0)
        const fresh = await state(page, ex)

        // Make the state differ from a fresh load: select a row, flip its fold.
        await page.evaluate(
          async ({ ex }) => {
            const w = getSvc('WidgetManager').tryGetWidget(ex.id)
            const node = hbPick(w)
            if ('expanded' in node && node.children.length > 0) {
              if (node.expanded) await w.model.collapseNode(node)
              else await w.model.expandNode(node)
            }
            w.model.selectNode(node)
          },
          { ex },
        )
        const touched = await state(page, ex)
        expect(touched.selected).toHaveLength(1)

        const copy = path.join(tmp, 'copy.sfc')
        fs.copyFileSync(ROM, copy)
        await markRoot(page, ex)
        if (via === 'service') {
          const r = await page.evaluate(
            ({ p, copy }) => getSvc('Symbol(ProjectService)').relocateRom(p, copy),
            { p: project.manifestPath, copy },
          )
          expect(r.status).toBe('ok')
        } else {
          // A full Properties save also re-announces the project (ProjectContext.onChanged):
          // the later, ordinary load must not bring the folds back.
          await relocateViaProperties(page, project, copy)
        }

        await rebuilt(page, ex)
        await page.waitForTimeout(1500) // let the re-announce's load finish too
        await expect.poll(() => state(page, ex)).toEqual(fresh)
      })
    }

    if (!ex.perEdit) continue
    test(`${ex.kind}: an ordinary edit keeps the selection and fold of rows that still exist`, async ({
      page,
    }) => {
      const project = await createProject(page, 'Edited', ROM)
      await openExplorer(page, ex, project)
      await expect.poll(() => count(page, ex), { timeout: 30000 }).toBeGreaterThan(0)

      await page.evaluate(
        async ({ ex }) => {
          const w = getSvc('WidgetManager').tryGetWidget(ex.id)
          const node = hbPick(w)
          if ('expanded' in node && node.children.length > 0) {
            if (node.expanded) await w.model.collapseNode(node)
            else await w.model.expandNode(node)
          }
          w.model.selectNode(node)
        },
        { ex },
      )
      const before = await state(page, ex)
      expect(before.selected).toHaveLength(1)

      await markRoot(page, ex)
      await page.evaluate(
        p =>
          getSvc('ProjectFrontendClient').onEditEvent({
            specversion: '1.0',
            id: 'test',
            source: 'urn:test',
            type: 'hackbench.edit.applied',
            subject: p,
            data: { domain: 'palette', ranges: [] },
          }),
        project.manifestPath,
      )
      await rebuilt(page, ex)
      await expect.poll(() => state(page, ex)).toEqual(before)
    })
  }

  test('locating the ROM from the emulator panel fills in all four explorers', async ({ page }) => {
    const gone = path.join(tmp, 'gone.sfc')
    fs.copyFileSync(ROM, gone)
    const project = await createProject(page, 'Emulated', gone)
    fs.rmSync(gone)
    for (const ex of EXPLORERS) await openExplorer(page, ex, project)
    for (const ex of EXPLORERS) await expect.poll(() => count(page, ex)).toBe(0)

    const moved = path.join(tmp, 'moved.sfc')
    fs.copyFileSync(ROM, moved)
    // pickRom is what the panel's "Locate ROM..." button runs; the button itself
    // needs a registered libretro core, which this test has no use for.
    await page.evaluate(async moved => {
      const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.emulator-view')
      w.fileDialog.showOpenDialog = async () => ({ path: { fsPath: () => moved } })
      await w.pickRom()
    }, moved)

    for (const ex of EXPLORERS) {
      if (ex.kind === 'maps') await expect.poll(() => count(page, ex)).toBe(VANILLA_MAPS)
      else await expect.poll(() => count(page, ex), { timeout: 30000 }).toBeGreaterThan(0)
      expect((await state(page, ex)).selected).toEqual([])
    }
  })
})
