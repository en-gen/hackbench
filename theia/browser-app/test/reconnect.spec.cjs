/**
 * A backend restart under an open project: the page stays, the frontend
 * reconnects by itself, and the project keeps working without a reload.
 *
 * The backend holds nothing that is not on disk (the working copy is the
 * base ROM plus the project's saved layers, rebuilt on first request), and
 * each new connection hands the service a fresh client for pushes. This
 * test is what shows both, not a reading of the code.
 *
 * It runs its OWN backend on a separate port, since killing the shared one
 * would take every other suite down with it. Skips without the ROM fixture.
 */
const { test, expect } = require('@playwright/test')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { romPath, VANILLA } = require('../../../test/suite/support/corpus.cjs')
const { startBackend, stopBackend, waitForBackend } = require('./own-backend.cjs')

const PORT = Number(process.env.HB_RECONNECT_PORT || 3100)
const APP = `http://127.0.0.1:${PORT}`
const ROM = process.env.HB_ROM || romPath(VANILLA)
const haveRom = fs.existsSync(ROM)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

let backend
let tmp

test.afterAll(() => {
  stopBackend(backend)
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('a backend restart under an open project reconnects without reloading the page', async ({
  page,
}) => {
  test.skip(!haveRom, `ROM fixture not present on this machine (${ROM})`)
  test.setTimeout(300000)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reconnect-'))

  backend = startBackend(PORT)
  await waitForBackend(APP, true)
  await page.goto(APP, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#theia-app-shell', { timeout: 90000 })
  await page.waitForTimeout(4000)
  await page.addScriptTag({ content: GET_SVC })

  const opened = await page.evaluate(
    async ({ romPath, directory }) => {
      const project = await getSvc('Symbol(ProjectService)').createProject({
        romPath,
        name: 'Reconnect',
        directory,
      })
      getSvc('ProjectContext').current = project
      // Survives only if the page is never reloaded.
      window.__hbSamePage = true
      return project.manifestPath
    },
    { romPath: ROM, directory: path.join(tmp, 'Reconnect') },
  )
  // An edit before the restart: it must still be there after, read back
  // from disk by a backend that never saw it happen.
  const before = await page.evaluate(
    mp => getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, '$391F', '$03E0'),
    opened,
  )
  expect(before.status).toBe('ok')

  stopBackend(backend)
  await waitForBackend(APP, false)
  backend = startBackend(PORT)
  await waitForBackend(APP, true)

  // The frontend reconnects on its own: poll a real call until it answers.
  await expect
    .poll(
      () =>
        page.evaluate(
          mp =>
            Promise.race([
              getSvc('Symbol(ProjectService)')
                .editStack(mp)
                .then(r => r.status)
                // A call caught mid-handover is rejected ("reconnecting
                // channel"); that is not-yet, not a verdict.
                .catch(e => `error: ${e.message}`),
              new Promise(r => setTimeout(() => r('no answer'), 3000)),
            ]),
          opened,
        ),
      { timeout: 120000, intervals: [1000] },
    )
    .toBe('ok')

  const after = await page.evaluate(async mp => {
    const project = getSvc('ProjectContext').current
    const stack = await getSvc('Symbol(ProjectService)').editStack(mp)
    // A push, not just a request: the new backend must have this
    // connection's client, or other views never hear about edits.
    const pushed = new Promise(resolve => {
      const sub = getSvc('ProjectFrontendClient').onChanged(changed => {
        sub.dispose()
        resolve(changed)
      })
      setTimeout(() => resolve('no push'), 5000)
    })
    const edit = await getSvc('Symbol(PaletteService)').setColor(mp, 0x00b2ce, '$03E0', '$001F')
    return {
      samePage: window.__hbSamePage === true,
      project: project?.manifestPath,
      canUndo: stack.status === 'ok' && stack.canUndo,
      undoLabel: stack.status === 'ok' ? stack.undoLabel : null,
      edit: edit.status,
      pushed: await pushed,
    }
  }, opened)

  expect(after.samePage, 'the page was reloaded').toBe(true)
  expect(after.project, 'the open project was lost').toBe(opened)
  expect(after.canUndo, 'the edit made before the restart is gone').toBe(true)
  expect(after.undoLabel).toMatch(/\$03E0/)
  // setColor names the colour it expects to replace: 'ok' means the new
  // backend read the pre-restart edit back from disk.
  expect(after.edit).toBe('ok')
  expect(after.pushed, 'no working-copy push reached the frontend after reconnecting').toBe(opened)
})
