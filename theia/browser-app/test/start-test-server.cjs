/**
 * Starts a HackBench backend for Playwright's HB_APP_URL on its own app data
 * and THEIA_CONFIG_DIR under the OS temp dir, and marks that folder with the
 * port so playwright.config.cjs can check the pairing. docs/testing.md.
 *
 *   node test/start-test-server.cjs [port]
 */
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { startBackend, stopBackend } = require('./own-backend.cjs')

const MARKER = 'hb-test-server.json'
const PREFIX = 'hb-testserver-'
// Theia's settings, recent and untitled workspaces, workspace metadata; the
// default is ~/.theia.
const THEIA_CONFIG = 'theia-config'

/** Creates the folder and its marker; returns the env the server must run with. */
function prepareTestServer(port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX))
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ port, pid: process.pid }))
  const env = {
    APPDATA: root,
    XDG_DATA_HOME: root,
    THEIA_CONFIG_DIR: path.join(root, THEIA_CONFIG),
  }
  return { root, env }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on('error', reject)
  })
}

async function waitUntilUp(url, child, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`backend exited (${child.exitCode}) before ${url} came up`)
    try {
      await fetch(url)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`backend at ${url} did not come up`)
      await new Promise(r => setTimeout(r, 500))
    }
  }
}

/** A running backend on a free port with its own marked app data; stop() removes both. */
async function startTestServer({ wait = false, port: fixed } = {}) {
  const port = fixed || (await freePort())
  const { root, env } = prepareTestServer(port)
  const child = startBackend(port, { env })
  const url = `http://127.0.0.1:${port}`
  const stop = () => {
    stopBackend(child)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  }
  if (wait) {
    try {
      await waitUntilUp(url, child)
    } catch (err) {
      stop()
      throw err
    }
  }
  return { url, port, root, child, stop }
}

async function main() {
  const { url, root, child, stop } = await startTestServer({ port: Number(process.argv[2]) })
  process.on('SIGINT', () => (stop(), process.exit(130)))
  child.on('exit', code => (stop(), process.exit(code ?? 1)))
  console.log(`HB_APP_URL=${url}
HB_TEST_APPDATA=${root}`)
}

if (require.main === module) main()

module.exports = { startTestServer, prepareTestServer, MARKER, PREFIX, THEIA_CONFIG }
