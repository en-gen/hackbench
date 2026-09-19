import { defineConfig } from '@playwright/test'

/**
 * End-to-end suite: real VS Code, real ROM, real webview.
 *
 * Deliberately not part of `npm run test`. A run costs tens of seconds per
 * spec because each one boots a fresh workbench, so this belongs in CI and
 * pre-merge, not in the watch loop. `test/e2e/` sits outside the globs in
 * vitest.config.ts, so the two runners never see each other's files.
 *
 * No browser download is needed: Playwright drives the Electron binary that
 * @vscode/test-electron already unzipped, so `playwright install` is not a
 * prerequisite here.
 */
export default defineConfig({
  testDir: './test/e2e',
  // One workbench at a time. Parallel VS Code instances contend for the
  // window focus that keyboard-driven steps depend on.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  // Retrying would hide flake rather than surface it. Turn this on only with
  // a note saying which step proved genuinely racy.
  retries: 0,
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
