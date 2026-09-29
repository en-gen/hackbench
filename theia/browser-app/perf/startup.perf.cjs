/** startup.shell: navigation start to the shell's `hb:shell-ready` measure, fresh page per sample. */
const { test } = require('@playwright/test')
const s = require('./support.cjs')

test('startup.shell', async ({ browser }) => {
  const id = 'startup.shell'
  test.skip(!s.shouldRun(id))
  const samples = await s.collect(async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      return await s.withPlant(page, id, async () => {
        await page.goto(s.APP, { waitUntil: 'domcontentloaded' })
        return s.awaitMeasure(page, 'shell-ready')
      })
    } finally {
      await context.close()
    }
  })
  s.record(id, 'ms', samples)
})
