/**
 * App feature timings. Each case's number is the app's own `hb:<name>` measure
 * (theia/extension/src/common/perf-marks.ts), taken where the work is done.
 */
const { test } = require('@playwright/test')
const s = require('./support.cjs')

test.describe.configure({ mode: 'serial' })

let page
test.beforeAll(async ({ browser }) => {
  page = await browser.newPage()
  await s.boot(page)
})
test.afterAll(async () => {
  await page?.close()
  s.removeProjects()
})

// Maps is COLD: a fresh project per sample, so the backend's L1 model cache
// misses and the measure is the first screen of a map drawn from nothing.
for (const [view, name, cold] of [
  ['maps', 'open-maps', true],
  ['map16', 'open-map16', false],
  ['gfx', 'open-gfx', false],
  ['palette', 'open-palette', false],
]) {
  const id = `app.${name}`
  test(id, async () => {
    test.skip(!s.shouldRun(id))
    let project = await s.newProject(page)
    let open
    const samples = await s.withPlant(page, id, () =>
      s.collect(() =>
        s.sample(page, name, async () => {
          // The previous sample's view goes first, so each sample opens from scratch.
          if (open) await s.closeView(page, open)
          if (cold) project = await s.newProject(page)
          open = await s.openView(page, view, project.manifestPath)
        }),
      ),
    )
    if (open) await s.closeView(page, open)
    s.record(id, 'ms', samples)
  })
}

test('app.open-project', async () => {
  const id = 'app.open-project'
  test.skip(!s.shouldRun(id))
  const samples = await s.withPlant(page, id, () =>
    s.collect(async () => {
      const project = await s.newProject(page) // creating it is not what is measured
      return s.sample(page, 'open-project', () =>
        page.evaluate(p => getSvc('HackBenchContribution').show(p), project),
      )
    }),
  )
  s.record(id, 'ms', samples)
})

/** Opens the project the way File > Open does, then a palette view on top so Edit > Undo is ours. */
async function projectWithPalette() {
  const project = await s.newProject(page)
  await page.evaluate(p => getSvc('HackBenchContribution').show(p), project)
  return s.openView(page, 'palette', project.manifestPath)
}

const editOnce = (widgetId, i) => {
  const [from, to] = i % 2 === 0 ? ['$391F', '$03E0'] : ['$03E0', '$391F']
  return page.evaluate(
    ([id, from, to]) =>
      getSvc('ApplicationShell')
        .widgets.find(w => w.id === id)
        .commit(0x00b2ce, from, to),
    [widgetId, from, to],
  )
}

test('app.edit', async () => {
  const id = 'app.edit'
  test.skip(!s.shouldRun(id))
  const widget = await projectWithPalette()
  const samples = await s.withPlant(page, id, () =>
    s.collect(i => s.sample(page, 'edit', () => editOnce(widget, i))),
  )
  s.record(id, 'ms', samples)
})

test('app.undo', async () => {
  const id = 'app.undo'
  test.skip(!s.shouldRun(id))
  const widget = await projectWithPalette()
  const samples = await s.withPlant(page, id, () =>
    s.collect(async () => {
      await editOnce(widget, 0)
      // HackBench's own cached edit-stack state, refreshed by the working-copy push.
      await page.waitForFunction(() => getSvc('EditStackContribution').state.canUndo)
      return s.sample(page, 'undo', () =>
        page.evaluate(() => getSvc('CommandRegistry').executeCommand('core.undo')),
      )
    }),
  )
  s.record(id, 'ms', samples)
})
