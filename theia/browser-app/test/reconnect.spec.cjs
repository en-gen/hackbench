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
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT = Number(process.env.HB_RECONNECT_PORT || 3100)
const APP = `http://127.0.0.1:${PORT}`
const ROM =
  process.env.HB_ROM || 'C:/Projects/hackbench/test/roms/Super Mario World (USA).vanilla.sfc'
const haveRom = fs.existsSync(ROM)

const GET_SVC = `function getSvc(name) {
  const d = window.theia.container._bindingDictionary
  for (const k of d._map.keys()) {
    const n = typeof k === 'function' ? k.name : String(k)
    if (n === name) return window.theia.container.get(k)
  }
  return null
}`

// Same per-machine state isolation as emulator-view.spec.cjs: creating a
// project touches recent-projects.json and rom-registry.json.
function appDataDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'hackbench')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'hackbench')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'hackbench')
}
const REGISTRY_FILES = ['rom-registry.json', 'recent-projects.json']
const snapshot = {}

let backend
let tmp

function startBackend() {
  const child = spawn(
    process.execPath,
    ['lib/backend/main.js', '--port', String(PORT), '--hostname', '127.0.0.1'],
    { cwd: path.resolve(__dirname, '..'), stdio: 'ignore' },
  )
  return child
}

function stopBackend(child) {
  if (!child || child.exitCode !== null) return
  // The backend forks helpers (file watchers); take the whole tree down.
  if (process.platform === 'win32')
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

async function waitForBackend(up) {
  await expect
    .poll(
      async () => {
        try {
          await fetch(APP)
          return true
        } catch {
          return false
        }
      },
      { timeout: 120000, intervals: [500] },
    )
    .toBe(up)
}

test.beforeAll(() => {
  for (const name of REGISTRY_FILES) {
    const p = path.join(appDataDir(), name)
    snapshot[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
})

test.afterAll(() => {
  stopBackend(backend)
  for (const name of REGISTRY_FILES) {
    const p = path.join(appDataDir(), name)
    if (snapshot[name] === null) fs.rmSync(p, { force: true })
    else fs.writeFileSync(p, snapshot[name], 'utf8')
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test('a backend restart under an open project reconnects without reloading the page', async ({
  page,
}) => {
  test.skip(!haveRom, `ROM fixture not present on this machine (${ROM})`)
  test.setTimeout(300000)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reconnect-'))

  backend = startBackend()
  await waitForBackend(true)
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
  await waitForBackend(false)
  backend = startBackend()
  await waitForBackend(true)

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
