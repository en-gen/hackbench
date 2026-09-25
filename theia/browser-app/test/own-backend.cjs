/**
 * A backend process a spec owns and controls directly - for restarting it
 * (reconnect.spec.cjs) or reading its log output (multi-window.spec.cjs),
 * neither of which the suite's shared backend safely allows.
 */
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { expect } = require('@playwright/test')

// Creating a project touches these, in per-user application data.
const REGISTRY_FILES = ['rom-registry.json', 'recent-projects.json']

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

function snapshotRegistry() {
  const snapshot = {}
  for (const name of REGISTRY_FILES) {
    const p = path.join(appDataDir(), name)
    snapshot[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  return snapshot
}

function restoreRegistry(snapshot) {
  for (const name of REGISTRY_FILES) {
    const p = path.join(appDataDir(), name)
    if (snapshot[name] === null) fs.rmSync(p, { force: true })
    else fs.writeFileSync(p, snapshot[name], 'utf8')
  }
}

/** Spawns the backend on `port`. With `capture: true`, `.output` accumulates its stdout and stderr. */
function startBackend(port, { capture = false } = {}) {
  const child = spawn(
    process.execPath,
    ['lib/backend/main.js', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    },
  )
  if (capture) {
    child.output = ''
    const collect = d => {
      child.output += d.toString()
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
  }
  return child
}

function stopBackend(child) {
  if (!child || child.exitCode !== null) return
  // The backend forks helpers (file watchers); take the whole tree down.
  if (process.platform === 'win32')
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
  else child.kill('SIGKILL')
}

async function waitForBackend(url, up) {
  await expect
    .poll(
      async () => {
        try {
          await fetch(url)
          return true
        } catch {
          return false
        }
      },
      { timeout: 120000, intervals: [500] },
    )
    .toBe(up)
}

module.exports = {
  appDataDir,
  snapshotRegistry,
  restoreRegistry,
  startBackend,
  stopBackend,
  waitForBackend,
}
