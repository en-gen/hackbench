import { test as base, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import {
  ROM_PATH, NO_ROM_REASON, launchWorkbench, makeWorkspace, removeWorkspace,
  openRom, openMap, webviewOf,
} from './fixtures/workbench'

/**
 * VS Code restores open editors across a restart, virtual files included, and
 * offers no way for an editor to opt out. A restored `smwrom://` tab points
 * into a ROM session that no longer exists, so `activate` closes them.
 *
 * This spec owns its own launches rather than using the shared worker
 * fixture: the whole point is to quit VS Code and start it again on the same
 * profile, which is what makes the editors come back.
 */
base.describe('restored ROM tabs', () => {
  base.skip(!ROM_PATH, NO_ROM_REASON)
  base.setTimeout(240_000)

  base('are closed on activation, while ordinary files are left restored', async () => {
    const dirs = makeWorkspace()
    // A plain workspace file, opened alongside the map. It is the control:
    // without it, "no map tab after restart" is equally consistent with VS
    // Code having restored nothing at all, and the test would pass whether
    // or not activate() did anything.
    fs.writeFileSync(path.join(dirs.workspaceDir, 'note.md'), '# control\n')

    try {
      // ── First session: open a map and a markdown file, then quit ────────
      const first = await launchWorkbench(dirs)

      // The control goes first, while the Files Explorer is still the visible
      // sidebar view. Opening the ROM swaps the sidebar to the HackBench
      // tree, and the workspace files are no longer on screen to click.
      const noteRow = first.win
        .locator('[aria-label="Files Explorer"] .monaco-list-row', { hasText: 'note.md' }).first()
      await noteRow.waitFor({ state: 'visible', timeout: 60_000 })
      await noteRow.dblclick()

      await openRom(first.win)
      await openMap(first.win, 'VANILLA SECRET 2')
      await webviewOf(first.win).locator('#toolbar').waitFor({ timeout: 90_000 })

      const firstTabs = first.win.locator('.tabs-container .tab')
      await expect.poll(async () => await firstTabs.allTextContents(), { timeout: 30_000 })
        .toEqual(expect.arrayContaining([
          expect.stringContaining('smwmap'),
          expect.stringContaining('note.md'),
        ]))

      await first.app.close()

      // ── Second session: same profile, so VS Code restores both tabs ─────
      const second = await launchWorkbench(dirs)
      const tabs = second.win.locator('.tabs-container .tab')

      // The control must come back, or this test proves nothing.
      await expect.poll(async () => await tabs.allTextContents(), { timeout: 60_000 })
        .toEqual(expect.arrayContaining([expect.stringContaining('note.md')]))

      // And the map tab must be gone, closed by activate().
      await expect.poll(async () => (await tabs.allTextContents()).filter(t => /smwmap/.test(t)),
        { timeout: 60_000 }).toEqual([])

      // No webview should have been left resolving against an unmounted
      // filesystem either.
      await expect(second.win.locator('iframe.webview')).toHaveCount(0)

      await second.app.close()
    } finally {
      removeWorkspace(dirs)
    }
  })
})
