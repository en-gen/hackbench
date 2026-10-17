const { defineConfig } = require('@playwright/test')
const { isolateAppData } = require('./test/app-data.cjs')

// Before anything resolves a path: this process, its workers and every server
// it starts use a per-run app-data folder, never the user's (#637).
isolateAppData()

// The webServer runs the build output; a node_modules shared with another
// checkout would serve that checkout's extension (#1038).
if (!process.env.HB_APP_URL) {
  const problem = require('child_process').spawnSync(
    process.execPath,
    [require('path').join(__dirname, '..', '..', 'tools', 'scripts', 'check-theia-install.mjs')],
    { encoding: 'utf8' },
  )
  if (problem.status !== 0) throw new Error(problem.stderr || 'check-theia-install failed')
}

// Concurrent runs (run-lock slots) must not share a port. An unset port is
// replaced by a free one found now, in this process, and written to process.env:
// workers are forked after config load and inherit it, so config, specs and
// servers agree. Lock slots map to no port (docs/testing.md, Run lock).
const freePort = () =>
  Number(
    require('child_process').execFileSync(process.execPath, [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ]),
  )
for (const name of ['HB_PORT', 'HB_RECONNECT_PORT', 'HB_MULTIWINDOW_PORT']) {
  if (name === 'HB_PORT' && process.env.HB_APP_URL) continue // external server: no port of ours
  if (!process.env[name]) process.env[name] = String(freePort())
}
// HB_PORT is interpolated into a shell command below; the other two reach
// specs as URLs. Digits only, in range, else a bad value polls for minutes.
for (const name of ['HB_PORT', 'HB_RECONNECT_PORT', 'HB_MULTIWINDOW_PORT']) {
  const v = process.env[name]
  if (v !== undefined && !(/^\d+$/.test(v) && +v >= 1 && +v <= 65535)) {
    throw new Error(`${name} must be an integer 1-65535, got "${v}"`)
  }
}
const PORT = process.env.HB_PORT

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
        command: `yarn theia start --port ${PORT} --hostname 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}`,
        // Serves a bundle built earlier in the job, but Theia backend startup
        // and plugin deployment still overrun the 60s default on a runner.
        timeout: 300000,
        // Never reuse: a server already on the port has its own APPDATA,
        // likely the user's real one. Start one by hand and pass HB_APP_URL.
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
