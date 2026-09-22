/**
 * A photographed walk through the editor with a real cartridge loaded.
 *
 * Playwright's own screenshot: 'on' fires at whatever state each test happens
 * to end in, which for a visual editor is usually not the interesting frame.
 * This spec opens a project and photographs each view deliberately, so a
 * green CI run leaves behind a legible record of what the editor drew.
 *
 * It is a test, not a camera. Each view is asserted to hold content BEFORE it
 * is photographed, because a blank panel is exactly what a presence-only
 * check cannot distinguish from a working one, and shipping a gallery of
 * blank panels would be worse than shipping none.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'

// Written next to the other Playwright output so one upload step collects it.
const SHOTS = path.resolve(__dirname, '../screenshots')

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}
function getWidget(id) {
  return getSvc('WidgetManager').getOrCreateWidget(id)
}`

let tmp

test.skip(!fs.existsSync(ROM), `cartridge not present at ${ROM}`)

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-shot-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Activation matters: a widget attached but not visible renders nothing. */
async function reveal(page, widgetId) {
  // Block body, not a concise one: activateWidget resolves to the Widget,
  // and returning it fails with "object reference chain is too long".
  await page.evaluate(async id => {
    await getSvc('ApplicationShell').activateWidget(id)
  }, widgetId)
  await page.waitForTimeout(800)
}

async function openProject(page, name) {
  return page.evaluate(
    async ({ romPath, directory, projectName }) => {
      const p = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: projectName,
        directory,
      })
      // Only the fields the test uses: the DTO itself carries references
      // deep enough to defeat serialization.
      return { manifestPath: p.manifestPath, name: p.name }
    },
    { romPath: ROM, directory: path.join(tmp, name), projectName: name },
  )
}

test('the editor views render a real cartridge, and are photographed doing it', async ({
  page,
}) => {
  const project = await openProject(page, 'Gallery')
  expect(project.manifestPath, 'the project should have been created').toBeTruthy()

  await page.screenshot({ path: path.join(SHOTS, '01-shell-project-open.png') })

  // Maps. mapCount comes from the parsed cart, so a non-zero count is
  // evidence the tree has real rows rather than an empty shell.
  const maps = await page.evaluate(async manifestPath => {
    const w = await getWidget('hackbench.map-explorer')
    await w.load(manifestPath)
    return w.mapCount
  }, project.manifestPath)
  expect(maps, 'the map explorer should list maps from the cartridge').toBeGreaterThan(0)
  await reveal(page, 'hackbench.map-explorer')
  await page.screenshot({ path: path.join(SHOTS, `02-maps-${maps}-entries.png`) })

  for (const [id, file] of [
    ['hackbench.gfx-explorer', '03-graphics.png'],
    ['hackbench.music-explorer', '04-music.png'],
    ['hackbench.emulator-view', '05-emulator.png'],
  ]) {
    await reveal(page, id)
    const visible = await page.evaluate(async wid => {
      const w = await getWidget(wid)
      return Boolean(w && w.isVisible)
    }, id)
    expect(visible, `${id} should be the active view after activation`).toBe(true)
    await page.screenshot({ path: path.join(SHOTS, file) })
  }

  // The gallery is only worth uploading if it is not blank. A PNG of a white
  // rectangle compresses to almost nothing, so size is a cheap blankness
  // proxy that would have caught the black-logo-on-black-bar defect.
  for (const f of fs.readdirSync(SHOTS)) {
    const bytes = fs.statSync(path.join(SHOTS, f)).size
    expect(bytes, `${f} looks blank at ${bytes} bytes`).toBeGreaterThan(5000)
  }
})
