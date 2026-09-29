const { defineConfig } = require('@playwright/test')
const { isolateAppData } = require('./test/app-data.cjs')

// Same isolation as the e2e config (#637): the server run-app.mjs starts owns
// the marked app-data folder for HB_APP_URL. The e2e config's testDir is
// ./test, so these specs are never collected there, and this one never
// collects e2e specs.
isolateAppData()

module.exports = defineConfig({
  testDir: './perf',
  testMatch: '**/*.perf.cjs',
  workers: 1,
  fullyParallel: false,
  timeout: 600000,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
})
