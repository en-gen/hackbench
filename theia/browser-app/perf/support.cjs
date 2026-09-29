/**
 * Shared by the app perf specs (docs/superpowers/specs/2026-09-28-perf-gates-design.md, section 2).
 * The pure helpers are unit-tested without a browser (test/suite/gates/perfApp.test.ts).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
const SAMPLES = 8
const WARMUP = 2

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

/** Least-squares slope of `ys` against its index (bytes per open/close cycle). */
function heapSlope(ys) {
  const n = ys.length
  if (n < 2) throw new Error(`heapSlope needs at least 2 points, got ${n}`)
  const mx = (n - 1) / 2
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my)
    den += (i - mx) ** 2
  }
  return num / den
}

/** `id=factor` from HB_PERF_PLANT; null when unset. A factor below 1 or non-numeric is refused. */
function parsePlant(text) {
  if (!text) return null
  const i = text.lastIndexOf('=')
  const factor = Number(text.slice(i + 1))
  if (i < 1 || !Number.isFinite(factor) || factor < 1) {
    throw new Error(`bad plant ${JSON.stringify(text)}: want <id>=<factor >= 1>`)
  }
  return { id: text.slice(0, i), factor }
}

/** True unless HB_PERF_ONLY names ids and this is not one of them. */
function shouldRun(id, only = process.env.HB_PERF_ONLY) {
  return (
    !only ||
    only
      .split(',')
      .map(s => s.trim())
      .includes(id)
  )
}

/**
 * The duration of the app's own `hb:<name>` measure. A measure the app never
 * emitted (its perfEnd was removed or never reached) throws: it must fail the
 * spec, never record 0.
 */
function measureOf(entries, name) {
  const hits = entries.filter(e => e.name === `hb:${name}`)
  if (hits.length === 0) throw new Error(`the app emitted no 'hb:${name}' measure`)
  const d = hits[hits.length - 1].duration
  if (!(d > 0)) throw new Error(`'hb:${name}' measured ${d}ms`)
  return d
}

const readMeasures = page =>
  page.evaluate(() =>
    performance.getEntriesByType('measure').map(e => ({ name: e.name, duration: e.duration })),
  )

const clearMeasures = page =>
  page.evaluate(() => {
    performance.clearMeasures()
    performance.clearMarks()
  })

/** Throttles the page's CPU by the plant factor while `fn` runs, when `id` is the planted case. */
async function withPlant(page, id, fn) {
  const plant = parsePlant(process.env.HB_PERF_PLANT)
  if (!plant || plant.id !== id) return fn()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: plant.factor })
  try {
    return await fn()
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  }
}

async function boot(page) {
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.addScriptTag({ content: GET_SVC })
}

/** A project on a fresh temp dir; returns it and the dir to remove. */
async function newProject(page) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-perf-'))
  const project = await page.evaluate(
    ({ romPath, directory }) =>
      getSvc('Symbol(ProjectService)').createProject({ romPath, name: 'Perf', directory }),
    { romPath: ROM, directory },
  )
  return { project, directory }
}

/** Clears measures, runs `action`, waits for `hb:<name>` and returns its duration. */
async function sample(page, name, action) {
  await clearMeasures(page)
  await action()
  await page
    .waitForFunction(n => performance.getEntriesByName(n, 'measure').length > 0, `hb:${name}`, {
      timeout: 30000,
    })
    .catch(() => {})
  return measureOf(await readMeasures(page), name)
}

/** WARMUP discarded runs, then SAMPLES recorded ones, each a fresh `action(i)`. */
async function collect(page, name, action) {
  const out = []
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    const d = await sample(page, name, () => action(i))
    if (i >= WARMUP) out.push(d)
  }
  return out
}

/** Page-side bodies that create and open a view's widget for project `mp`; each returns the widget. */
const VIEWS = {
  maps: `const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map-view', { index: 0x105 })
    await w.open({ manifestPath: mp, index: 0x105, label: '105', iconClass: '' }); return w`,
  map16: `const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.map16-view', { layer: 'fg' })
    await w.open({ manifestPath: mp, label: 'Map16 Foreground', layer: 'fg' }); return w`,
  gfx: `const w = await getSvc('WidgetManager').getOrCreateWidget('hackbench.gfx-view', { index: 0 })
    await w.open({ manifestPath: mp, index: 0, label: '0' }); return w`,
  palette: `return getSvc('PaletteExplorerContribution').openGroup({ manifestPath: mp, groupId: 'player', variant: 0, pinned: true })`,
}

/** Opens a view the way a pin does (open, then attach and activate); resolves to its widget id. */
function openView(page, view, mp) {
  return page.evaluate(`(async () => {
    const mp = ${JSON.stringify(mp)}
    const w = await (async () => { ${VIEWS[view]} })()
    const shell = getSvc('ApplicationShell')
    await shell.addWidget(w, { area: 'main' })
    await shell.activateWidget(w.id)
    return w.id
  })()`)
}

const closeView = (page, id) =>
  page.evaluate(
    id =>
      getSvc('ApplicationShell')
        .closeWidget(id)
        .then(() => undefined),
    id,
  )

/** Appends one result line for run-app.mjs to collect. */
function record(id, unit, samples) {
  const file = process.env.HB_PERF_RESULTS_FILE
  if (!file) throw new Error('HB_PERF_RESULTS_FILE is not set; run through tools/perf/run-app.mjs')
  fs.appendFileSync(file, JSON.stringify({ id, unit, better: 'lower', samples }) + '\n')
}

module.exports = {
  APP,
  ROM,
  SAMPLES,
  WARMUP,
  boot,
  clearMeasures,
  closeView,
  collect,
  heapSlope,
  measureOf,
  newProject,
  openView,
  parsePlant,
  readMeasures,
  record,
  sample,
  shouldRun,
  withPlant,
}
