/**
 * heap.<view>-reopen: open and close a view CYCLES times, forcing GC through
 * CDP before each heap reading, and report the least-squares slope in bytes
 * per cycle. One heap number is too noisy to gate on; a slope is not.
 */
const fs = require('fs')
const { test } = require('@playwright/test')
const s = require('./support.cjs')

const CYCLES = 20

for (const view of ['map16', 'gfx', 'palette', 'maps']) {
  const id = `heap.${view}-reopen`
  test(id, async ({ browser }) => {
    test.skip(!s.shouldRun(id))
    const page = await browser.newPage()
    let directory
    try {
      await s.boot(page)
      const p = await s.newProject(page)
      directory = p.directory
      const cdp = await page.context().newCDPSession(page)
      const cycle = async () => {
        const widgetId = await s.openView(page, view, p.project.manifestPath)
        await page.waitForTimeout(300) // let the first draw land before tearing down
        await s.closeView(page, widgetId)
      }
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage')
        return (await cdp.send('Runtime.getHeapUsage')).usedSize
      }
      for (let i = 0; i < s.WARMUP; i++) await cycle()
      const points = []
      for (let i = 0; i < CYCLES; i++) {
        await cycle()
        points.push(await heap())
      }
      s.record(id, 'bytes/cycle', [s.heapSlope(points)])
    } finally {
      await page.close()
      if (directory) fs.rmSync(directory, { recursive: true, force: true })
    }
  })
}
