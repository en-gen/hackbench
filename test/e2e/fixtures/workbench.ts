import { test as base, expect, _electron as electron, type ElectronApplication, type Page, type FrameLocator } from '@playwright/test'
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const REPO_ROOT = path.resolve(__dirname, '../../..')

/**
 * The ROM these tests drive. Gitignored and absent in CI, exactly like the
 * corpus the integration suite uses, so every spec guards itself with
 * `test.skip(!ROM_PATH, ...)` rather than failing on a machine that has no
 * cart.
 */
export const ROM_PATH = ((): string | undefined => {
  const candidates = [
    process.env['HACKBENCH_E2E_ROM'],
    path.join(REPO_ROOT, 'test/roms/Super Mario World (USA).vanilla.sfc'),
  ].filter((p): p is string => !!p)
  return candidates.find(p => fs.existsSync(p))
})()

export const NO_ROM_REASON =
  'needs test/roms/Super Mario World (USA).vanilla.sfc, or HACKBENCH_E2E_ROM'

/**
 * Where VS Code gets unzipped. This is deliberately the repo root and not a
 * system temp directory: `workbench.html` sits 146 characters below the repo
 * root, and Chromium's file loader fails with a misleading ERR_FILE_NOT_FOUND
 * once the full path passes Windows' 260-character MAX_PATH. A junction does
 * not help, because Electron resolves it back to the real path.
 */
const VSCODE_CACHE = path.join(REPO_ROOT, '.vscode-test')

export interface Workbench {
  app: ElectronApplication
  win: Page
  /** The temp dirs backing this launch -- e.g. so a test can drop a file next to the ROM. */
  dirs: { userDataDir: string, extensionsDir: string, workspaceDir: string }
}

/** The map editor's document, two frames below the workbench. */
export function webviewOf(win: Page): FrameLocator {
  // VS Code nests webviews twice: an outer `iframe.webview` the workbench
  // owns, and the extension's own document inside `#active-frame`.
  return win.frameLocator('iframe.webview.ready').frameLocator('#active-frame')
}

/**
 * Boots VS Code with the extension loaded from source. Callers own the
 * directories so a test can reuse a profile across two launches, which is how
 * the editor-restore behaviour gets exercised.
 */
export async function launchWorkbench(dirs: {
  userDataDir: string
  extensionsDir: string
  workspaceDir: string
}): Promise<{ app: ElectronApplication, win: Page }> {
  const exe = await downloadAndUnzipVSCode({ cachePath: VSCODE_CACHE })
  const app = await electron.launch({
    executablePath: exe,
    args: [
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--disable-telemetry',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      `--user-data-dir=${dirs.userDataDir}`,
      `--extensions-dir=${dirs.extensionsDir}`,
      dirs.workspaceDir,
    ],
    timeout: 120_000,
  })
  const win = await app.firstWindow({ timeout: 120_000 })
  await win.waitForSelector('.monaco-workbench', { timeout: 120_000 })
  return { app, win }
}

/** Fresh profile, empty extension directory, and a workspace holding the ROM. */
export function makeWorkspace(): { userDataDir: string, extensionsDir: string, workspaceDir: string } {
  // The empty extensions dir matters: without it VS Code loads whatever the
  // developer has installed, and a stray extension's notification steals the
  // focus the tests rely on.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e2e-user-'))
  const extensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e2e-ext-'))
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-e2e-ws-'))

  // The ROM has to be inside the workspace for the Explorer to show it, and
  // the Explorer is how it gets opened: `hackbench.openRom` otherwise raises
  // a native file dialog, which no automation can drive.
  if (ROM_PATH) fs.copyFileSync(ROM_PATH, path.join(workspaceDir, 'rom.sfc'))
  return { userDataDir, extensionsDir, workspaceDir }
}

/**
 * Best-effort cleanup of the temp profile.
 *
 * On Windows the process keeps a handle on the user-data directory for a
 * moment after it exits, so a prompt delete raises EPERM. Retry briefly, and
 * never let a leftover temp directory fail a test that otherwise passed.
 */
export function removeWorkspace(dirs: Record<string, string>): void {
  for (const dir of Object.values(dirs)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
    } catch {
      // The OS will reap it. Nothing here is worth a red test.
    }
  }
}

interface WorkerFixtures { workbench: Workbench }
interface TestFixtures {
  /** A freshly opened map editor, closed again when the test ends. */
  mapEditor: { win: Page, webview: FrameLocator }
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Worker-scoped: one VS Code and one ROM parse for the whole run rather
  // than one per test. Booting the workbench and walking the Explorer context
  // menu is the slowest and least reliable part of this suite, and there is
  // no reason for every test to repeat it. Per-test isolation comes from the
  // `mapEditor` fixture below, which opens and closes the editor itself.
  workbench: [async ({}, use) => {
    const dirs = makeWorkspace()
    const { app, win } = await launchWorkbench(dirs)

    if (ROM_PATH) await openRom(win)

    await use({ app, win, dirs })

    await app.close()
    removeWorkspace(dirs)
  }, { scope: 'worker' }],

  mapEditor: async ({ workbench }, use) => {
    const { win } = workbench
    await openMap(win, 'VANILLA SECRET 2')
    const webview = webviewOf(win)
    await webview.locator('#toolbar').waitFor({ timeout: 90_000 })
    await webview.locator('#model-canvas').waitFor({ timeout: 90_000 })

    await use({ win, webview })

    // Close the editor so the next test gets a webview with default toggles.
    // These panels set `retainContextWhenHidden: false`, so a closed tab is a
    // disposed one, which is exactly the isolation each test needs.
    await closeActiveEditor(win)
  },
})

export { expect }

/**
 * The palette, scoped to the widget that is actually on screen. VS Code keeps
 * more than one `.quick-input-widget` in the DOM, and an unscoped selector
 * resolves to a hidden one's rows first, which then never become visible.
 */
export function quickInput(win: Page) {
  return win.locator('.quick-input-widget').filter({ visible: true }).first()
}

/**
 * Opens the ROM through the Explorer context menu, which is the only path that
 * skips the native file dialog: VS Code hands the command the URI that was
 * right-clicked, and `romPathFromCommandArg` takes the path from it.
 */
export async function openRom(win: Page): Promise<void> {
  // The Explorer is the default view, so this needs no command. That matters
  // for more than brevity: the palette is keyboard-driven, and pressing
  // Ctrl+Shift+P as the very first interaction races the workbench finishing
  // its layout. Waiting on a workspace file instead is both a readiness
  // signal and the thing the test needs.
  const romRow = win.locator('[aria-label="Files Explorer"] .monaco-list-row', { hasText: 'rom.sfc' }).first()
  await romRow.waitFor({ state: 'visible', timeout: 90_000 })

  const treeRow = win.locator('.pane-body .monaco-list-row').first()

  // Retry the open as a unit. Every step here can lose a race with the
  // workbench still settling, and the menu is the fragile one: a right-click
  // on an unselected row produces a menu with no resource context, where
  // every `when` clause keyed on `resourceExtname` quietly evaluates false
  // and "Open ROM…" is simply absent. Asserting the item is there before
  // clicking turns that into a retry instead of a 20-second timeout.
  await expect(async () => {
    // Clear any overlay left behind by a previous attempt. Without this a
    // single stuck context menu makes every retry fail identically, since its
    // context-view-block swallows the clicks below -- the retry loop then just
    // reproduces the same failure until the outer timeout.
    await win.keyboard.press('Escape')
    await romRow.click()
    await romRow.click({ button: 'right' })
    // Click the menu item, not the label span inside it: VS Code binds
    // activation to the item, so a click on the span can land without
    // dismissing the menu, leaving its overlay to swallow everything after.
    const item = win.getByRole('menuitem', { name: /Open ROM/i }).first()
    await item.waitFor({ state: 'visible', timeout: 10_000 })
    await item.click({ timeout: 10_000 })

    // The menu's context-view overlay can outlive the click that activated it,
    // and while it is up its context-view-block swallows every later click --
    // including the activity-bar one below, which is where this used to hang
    // until the outer timeout. Wait for it to go, and push it if it lingers.
    await win.locator('.context-view').first()
      .waitFor({ state: 'hidden', timeout: 5_000 })
      .catch(async () => { await win.keyboard.press('Escape') })

    // Reveal the view by clicking its activity-bar entry, not through the
    // palette, which does not reliably take focus after a menu dismissal.
    await win.getByRole('tab', { name: /HackBench/i }).first().click({ timeout: 10_000 })
    await expect(treeRow).toBeVisible({ timeout: 20_000 })
  }).toPass({ timeout: 150_000 })
}

/** Opens a map by clicking its tree row. Quick-open cannot see smwrom:// files. */
export async function openMap(win: Page, label: string): Promise<void> {
  const row = win.locator('.pane-body .monaco-list-row', { hasText: label }).first()
  await row.waitFor({ state: 'visible', timeout: 30_000 })
  await row.dblclick()
}

/**
 * Closes the open editor tab. Middle-click rather than the close button: the
 * button only exists while the tab is hovered or active, and its class has
 * moved around between VS Code versions, whereas middle-click-to-close is
 * stable workbench behaviour.
 */
export async function closeActiveEditor(win: Page): Promise<void> {
  const tabs = win.locator('.tabs-container .tab')
  if (await tabs.count() === 0) return
  await tabs.first().click({ button: 'middle' })
  await expect(tabs).toHaveCount(0, { timeout: 20_000 })
}
