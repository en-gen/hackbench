const { defineConfig } = require('@playwright/test')
const { isolateAppData } = require('./test/app-data.cjs')

// Same isolation as the e2e config (#637): run-app.mjs starts the marked
// server for HB_APP_URL. The e2e config's testDir is ./test, so it never
// collects these, and this one never collects e2e specs.
isolateAppData()

module.exports = defineConfig({
  testDir: './perf',
  testMatch: '**/*.perf.cjs',
  workers: 1,
  timeout: 600000,
  forbidOnly: true,
})
