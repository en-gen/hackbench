/**
 * App feature timings. Each case's number is the app's own `hb:<name>` measure
 * (theia/extension/src/common/perf-marks.ts), taken where the work is done.
 */
const fs = require('fs')
const { test } = require('@playwright/test')
const s = require('./support.cjs')

test.describe.configure({ mode: 'serial' })

let page
const dirs = []
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await s.boot(page)
})
test.afterAll(async () => {
  await page?.close()
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

async function newProject() {
  const p = await s.newProject(page)
  dirs.push(p.directory)
  return p.project
}

for (const [view, name] of [
  ['maps', 'open-maps'],
  ['map16', 'open-map16'],
  ['gfx', 'open-gfx'],
  ['palette', 'open-palette'],
]) {
  const id = `app.${name}`
  test(id, async () => {
    test.skip(!s.shouldRun(id))
    const { manifestPath } = await newProject()
    let open
    const samples = await s.withPlant(page, id, () =>
      s.collect(page, name, async () => {
        // The previous sample's view goes first, so each sample opens a view from scratch.
        if (open) await s.closeView(page, open)
        open = await s.openView(page, view, manifestPath)
      }),
    )
    if (open) await s.closeView(page, open)
    s.record(id, 'ms', samples)
  })
}

test('app.open-project', async () => {
  const id = 'app.open-project'
  test.skip(!s.shouldRun(id))
  const samples = await s.withPlant(page, id, () =>
    s.collect(page, 'open-project', async () => {
      const p = await s.newProject(page)
      dirs.push(p.directory)
      await s.clearMeasures(page) // creating the project is not what is measured
      await page.evaluate(pr => getSvc('HackBenchContribution').show(pr), p.project)
    }),
  )
  s.record(id, 'ms', samples)
})

const editOnce = (widgetId, i) => {
  const [from, to] = i % 2 === 0 ? ['$391F', '$03E0'] : ['$03E0', '$391F']
  return page.evaluate(
    ([id, from, to]) => getSvc('WidgetManager').tryGetWidget(id).commit(0x00b2ce, from, to),
    [widgetId, from, to],
  )
}

test('app.edit', async () => {
  const id = 'app.edit'
  test.skip(!s.shouldRun(id))
  const { manifestPath } = await newProject()
  const w = await s.openView(page, 'palette', manifestPath)
  const samples = await s.withPlant(page, id, () => s.collect(page, 'edit', i => editOnce(w, i)))
  s.record(id, 'ms', samples)
})

test('app.undo', async () => {
  const id = 'app.undo'
  test.skip(!s.shouldRun(id))
  const { manifestPath } = await newProject()
  const w = await s.openView(page, 'palette', manifestPath)
  const samples = await s.withPlant(page, id, () =>
    s.collect(page, 'undo', async () => {
      await editOnce(w, 0)
      // Undo is enabled once the working-copy push refreshes the cached stack.
      await page.waitForFunction(() => getSvc('CommandRegistry').isEnabled('core.undo'))
      await s.clearMeasures(page)
      await page.evaluate(() => getSvc('CommandRegistry').executeCommand('core.undo'))
    }),
  )
  s.record(id, 'ms', samples)
})
