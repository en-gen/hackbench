/**
 * Gives each Playwright run its own app data and Theia config dir under the OS
 * temp dir, so specs never touch the user's (#637, #343). docs/testing.md,
 * "Playwright never touches your app data".
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { MARKER, PREFIX: SERVER_PREFIX, THEIA_CONFIG } = require('./start-test-server.cjs')

const PREFIX = 'hb-appdata-'
const DAY_MS = 24 * 60 * 60 * 1000
let owned = null

const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
const isUnder = (child, parent) => {
  const rel = path.relative(norm(parent), norm(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function refuse(root, why) {
  return new Error(
    `Playwright refuses app data at ${root || '(none)'}: ${why}. See docs/testing.md.`,
  )
}

/** True when `root` was made by start-test-server.cjs for the port in `url`. */
function markedFor(root, url) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8'))
    return String(marker.port) === new URL(url).port
  } catch {
    return false
  }
}

const OWNER = 'hb-owner.json'

/** True while the process that made this folder (its owner file, or a test server's marker) still runs. */
function ownerAlive(root) {
  for (const file of [OWNER, MARKER]) {
    try {
      process.kill(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).pid, 0)
      return true
    } catch (e) {
      if (e.code === 'EPERM') return true
    }
  }
  return false
}

/** Runs and test servers that crashed before their exit handler left folders behind. */
function sweepStale() {
  const tmp = os.tmpdir()
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(PREFIX) && !name.startsWith(SERVER_PREFIX)) continue
    const p = path.join(tmp, name)
    try {
      if (Date.now() - fs.statSync(p).mtimeMs <= DAY_MS) continue
      // A run or test server can outlive a day; its folder goes only once its pid is gone.
      if (ownerAlive(p)) continue
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // In use by another run, or already gone.
    }
  }
}

/**
 * Points this process's APPDATA, XDG_DATA_HOME and THEIA_CONFIG_DIR at the
 * run's folder. The runner creates it; its workers reload the config and
 * inherit it. With HB_APP_URL the folder is the one start-test-server.cjs
 * made for that port.
 */
function isolateAppData() {
  const env = process.env
  if (process.platform === 'darwin') {
    throw new Error(
      'Playwright cannot isolate app data on macOS: src/project/appData.ts ignores the environment there. See docs/testing.md.',
    )
  }
  let root = env.HB_TEST_APPDATA
  if (env.HB_APP_URL) {
    if (!root || !markedFor(root, env.HB_APP_URL)) {
      throw refuse(
        root,
        'HB_APP_URL needs the HB_TEST_APPDATA start-test-server.cjs printed for that port',
      )
    }
  } else if (root) {
    if (!env.HB_TEST_APPDATA_OWNER) {
      throw refuse(root, 'HB_TEST_APPDATA is set, but no Playwright run created it')
    }
  } else {
    sweepStale()
    root = owned = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
    fs.writeFileSync(path.join(root, OWNER), JSON.stringify({ pid: process.pid }))
    env.HB_TEST_APPDATA = root
    env.HB_TEST_APPDATA_OWNER = String(process.pid)
    process.on('exit', cleanupAppData)
  }
  if (!isUnder(root, os.tmpdir())) throw refuse(root, 'it is not under the OS temp dir')
  env.APPDATA = env.XDG_DATA_HOME = root
  env.THEIA_CONFIG_DIR = path.join(root, THEIA_CONFIG)
}

/** Removes the folder this process created; a worker's or a caller's is left alone. */
function cleanupAppData() {
  process.removeListener('exit', cleanupAppData)
  if (!owned) return
  try {
    fs.rmSync(owned, { recursive: true, force: true, maxRetries: 5 })
  } catch (e) {
    // A throw from an exit listener would turn a green run red.
    console.warn(`Could not remove Playwright app data at ${owned}: ${e.message}`)
  }
  owned = null
}

module.exports = { isolateAppData, cleanupAppData }
