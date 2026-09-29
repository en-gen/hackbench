/** startup.shell: navigation start to the shell's `hb:shell-ready` measure, fresh page per sample. */
const { test } = require('@playwright/test')
const s = require('./support.cjs')

test('startup.shell', async ({ browser }) => {
  const id = 'startup.shell'
  test.skip(!s.shouldRun(id))
  const samples = []
  for (let i = 0; i < s.WARMUP + s.SAMPLES; i++) {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      const d = await s.withPlant(page, id, async () => {
        await page.goto(s.APP, { waitUntil: 'domcontentloaded' })
        await page
          .waitForFunction(
            () => performance.getEntriesByName('hb:shell-ready', 'measure').length > 0,
            null,
            { timeout: 90000 },
          )
          .catch(() => {})
        return s.measureOf(await s.readMeasures(page), 'shell-ready')
      })
      if (i >= s.WARMUP) samples.push(d)
    } finally {
      await context.close()
    }
  }
  s.record(id, 'ms', samples)
})
