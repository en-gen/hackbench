const { defineConfig } = require('@playwright/test')
module.exports = defineConfig({
  testDir: './test',
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  reporter: [['list']],
  use: { trace: 'off' },
})
