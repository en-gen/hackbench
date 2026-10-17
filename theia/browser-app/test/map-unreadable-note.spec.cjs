/**
 * A map whose layer 1 stream was not read to its $FF shows a plain-words toast (#788).
 *
 * The note itself is made by MapTree and unit-tested there on synthetic ROMs; no corpus ROM
 * has an unterminated stream the exit graph reaches, so this spec plants the grouped DTO the
 * server returns (the `projects` service property on the widget, which a wrapper over a proxy
 * method cannot do: docs/testing.md "Playwright and RPC") and proves the widget SHOWS the
 * exact text MapTree produces for one map, and shows nothing of the kind without it.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)
// MapTree.ts's note for one unreadable map, $001.
const NOTE =
  '1 map has object data that could not be read to its end, so screen exits from it may be missing: $001.'

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

test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-unreadable-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})

test.afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

/** Loads a fresh project in the map explorer; `plant` adds the note to the server's reply. */
async function load(page, plant) {
  await page.evaluate(
    async ({ romFile, directory, note }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const project = await svc.createProject({ romPath: romFile, name: 'MyHack', directory })
      const w = await getWidget('hackbench.map-explorer')
      const real = w.projects
      if (note) {
        w.projects = new Proxy(real, {
          get: (target, key) =>
            key === 'loadMaps'
              ? async mp => {
                  const r = await target.loadMaps(mp)
                  r.tree.notes = [...r.tree.notes, note]
                  return r
                }
              : target[key],
        })
      }
      try {
        await w.load(project.manifestPath)
      } finally {
        w.projects = real
      }
    },
    { romFile: ROM, directory: path.join(tmp, 'P'), note: plant ? NOTE : null },
  )
}

const toast = page =>
  page.locator('.theia-notification-message').filter({ hasText: 'read to its end' })

test('a map read short of its $FF is named in a plain-words toast', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'no vanilla corpus ROM on this machine')
  await load(page, true)
  const t = toast(page).filter({ visible: true }).first()
  await expect(t).toBeVisible()
  await expect(t).toHaveText(NOTE)
})

test('no such toast when the server reports every map read to its end', async ({ page }) => {
  test.skip(!fs.existsSync(ROM), 'no vanilla corpus ROM on this machine')
  await load(page, false)
  await page.waitForTimeout(1500)
  await expect(toast(page)).toHaveCount(0)
})
