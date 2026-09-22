const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './test',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  // A stray .only silently reduces the suite to one test and still exits 0.
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list']],
  use: {
    // 'on', not 'only-on-failure': a green run should still show what the
    // editor rendered. Presence of a view is not evidence it drew anything,
    // and a blank canvas passes every assertion that only checks attachment.
    screenshot: 'on',
    trace: process.env.CI ? 'retain-on-failure' : 'off',
  },
  // HB_ROM aside, HB_APP_URL means a shell is already running somewhere we do
  // not own, so Playwright must neither start nor stop one. Playwright has no
  // switch for that, and reuseExistingServer does not cover it because the
  // external origin may differ from webServer.url.
  webServer: process.env.HB_APP_URL
    ? undefined
    : {
        command: 'yarn start',
        url: 'http://127.0.0.1:3000',
        // Serves a bundle built earlier in the job, but Theia backend startup
        // and plugin deployment still overrun the 60s default on a runner.
        timeout: 300000,
        reuseExistingServer: !process.env.CI,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
