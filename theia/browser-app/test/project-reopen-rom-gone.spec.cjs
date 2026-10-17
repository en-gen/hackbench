/**
 * #975: reopening a project whose base ROM file was renamed must show it as
 * not located everywhere. Project properties read workstationPaths; the map
 * view reads mapDetails. Both are asserted, plus the recovery when the file
 * returns. Works on a COPY of the ROM in a temp dir; no corpus file is renamed.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')

const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'
const ROM = process.env.HB_ROM || romPath(VANILLA)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let tmp
test.beforeEach(async ({ page }) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reopen-'))
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })
})
test.afterEach(async ({ page }) => {
  // The ROM registry is per-user and keyed by hash: point it back at the real file.
  await page.evaluate(rp => getSvc('Symbol(ProjectService)').registerRom(rp), ROM)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('reopen with the base ROM renamed shows not located in properties and maps; restored ROM recovers', async ({
  page,
}) => {
  const copy = path.join(tmp, 'game.sfc')
  fs.copyFileSync(ROM, copy)
  const manifestPath = await page.evaluate(
    async ({ rom, directory }) => {
      const svc = getSvc('Symbol(ProjectService)')
      const p = await svc.createProject({ romPath: rom, name: 'Gone', directory })
      await svc.openProject(p.manifestPath)
      return p.manifestPath
    },
    { rom: copy, directory: path.join(tmp, 'Gone') },
  )
  const probe = () =>
    page.evaluate(async mp => {
      const svc = getSvc('Symbol(ProjectService)')
      const paths = await svc.workstationPaths(mp)
      const maps = await svc.mapDetails(mp, 0x105)
      return { rom: paths.romPath, maps: maps.status }
    }, manifestPath)

  const before = await probe()
  expect(before.rom).toBe(copy)
  expect(before.maps).not.toBe('rom-not-located')

  fs.renameSync(copy, copy + '.moved')
  await page.evaluate(mp => getSvc('Symbol(ProjectService)').openProject(mp), manifestPath)
  const gone = await probe()
  expect(gone.rom).toBeNull()
  expect(gone.maps).toBe('rom-not-located')

  fs.renameSync(copy + '.moved', copy)
  await page.evaluate(mp => getSvc('Symbol(ProjectService)').openProject(mp), manifestPath)
  const back = await probe()
  expect(back.rom).toBe(copy)
  expect(back.maps).not.toBe('rom-not-located')
})
