/**
 * heap.<view>-reopen: open and close a view CYCLES times, forcing GC through
 * CDP before each heap reading, and report the least-squares slope in bytes
 * per cycle. One heap number is too noisy to gate on; a slope is not.
 *
 * A plant on a heap id makes the page retain factor x 64 KiB per cycle, so a
 * planted pair goes red through this same CDP path.
 */
const { test } = require('@playwright/test')
const s = require('./support.cjs')

const CYCLES = 20
const PLANT_BYTES = 64 * 1024

for (const [view, name] of [
  ['map16', 'open-map16'],
  ['gfx', 'open-gfx'],
  ['palette', 'open-palette'],
  ['maps', 'open-maps'],
]) {
  const id = `heap.${view}-reopen`
  test(id, async ({ browser }) => {
    test.skip(!s.shouldRun(id))
    const plant = s.parsePlant(process.env.HB_PERF_PLANT)
    const leak = plant?.id === id ? plant.factor : 0
    const page = await browser.newPage()
    try {
      await s.boot(page)
      const project = await s.newProject(page)
      const cdp = await page.context().newCDPSession(page)
      const cycle = async () => {
        let widgetId
        // The view is open once the app says its first content is drawn.
        await s.sample(page, name, async () => {
          widgetId = await s.openView(page, view, project.manifestPath)
        })
        await s.closeView(page, widgetId)
        if (leak) {
          await page.evaluate(
            n => (window.__hbLeak ??= []).push(new Array(n).fill(1.5)),
            (leak * PLANT_BYTES) / 8,
          )
        }
      }
      const heap = async () => {
        await cdp.send('HeapProfiler.collectGarbage')
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
      s.removeProjects()
    }
  })
}
