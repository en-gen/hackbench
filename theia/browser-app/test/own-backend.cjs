/**
 * A backend process a spec owns and controls directly - for restarting it
 * (reconnect.spec.cjs) or reading its log output (multi-window.spec.cjs),
 * neither of which the suite's shared backend safely allows.
 */
const { spawn, execSync } = require('child_process')
const path = require('path')
const { expect } = require('@playwright/test')

/** The spawn call for the backend; `env` is laid over this process's env, which carries the per-run app data. */
function backendSpawnArgs(port, { capture = false, env = {} } = {}) {
  return [
    process.execPath,
    ['lib/backend/main.js', '--port', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, ...env },
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    },
  ]
}

/** Spawns the backend on `port`. With `capture: true`, `.output` accumulates its stdout and stderr. */
function startBackend(port, options = {}) {
  const child = spawn(...backendSpawnArgs(port, options))
  if (options.capture) {
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

module.exports = { backendSpawnArgs, startBackend, stopBackend, waitForBackend }
