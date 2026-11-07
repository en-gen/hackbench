/**
 * Concurrent Playwright runs (run-lock slots) must not collide on a port. The
 * config picks a free port when HB_PORT is unset and writes it to process.env
 * for the workers; HB_PORT only forces one. Synthetic: loads the config in a
 * child process, starts no server and needs no ROM. A spec that names a port
 * of its own misses the one the config picked: 122 of 653 tests were refused
 * a connection on gh01's first full run, 2026-11-05.
 */
import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadTimeout } from '../support/loadTimeout'

vi.setConfig({ testTimeout: loadTimeout(30_000), hookTimeout: loadTimeout(30_000) })

const CONFIG = path.resolve(__dirname, '../../../theia/browser-app/playwright.config.cjs')
const SPECS = path.join(path.dirname(CONFIG), 'test')
// A literal port in a URL, or a literal fallback for HB_PORT. Not a bare 3000:
// that is also the commonest timeout in these specs.
const HARD_CODED_PORT =
  /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0):\d|HB_PORT\s*(?:\|\||\?\?)\s*['"`]?\d/
const SCRIPT = `const c=require(${JSON.stringify(CONFIG)});const w=c.webServer;
const e=process.env;process.stdout.write(JSON.stringify({cmd:w&&w.command,url:w&&w.url,port:e.HB_PORT,re:e.HB_RECONNECT_PORT,mw:e.HB_MULTIWINDOW_PORT}))`

function load(env: Record<string, string>) {
  const base = { ...process.env }
  for (const k of [
    'HB_PORT',
    'HB_RECONNECT_PORT',
    'HB_MULTIWINDOW_PORT',
    'HB_APP_URL',
    'HB_TEST_APPDATA',
    'HB_TEST_APPDATA_OWNER',
  ])
    delete base[k]
  const r = spawnSync(process.execPath, ['-e', SCRIPT], {
    encoding: 'utf8',
    env: { ...base, HB_SKIP_INSTALL_GUARD: '1', ...env },
  })
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null }
}

function specFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile() && e.name.endsWith('.spec.cjs'))
    .map(e => path.join(e.parentPath, e.name))
}

function hardCoded(dir: string): string[] {
  return specFiles(dir)
    .filter(f => HARD_CODED_PORT.test(fs.readFileSync(f, 'utf8')))
    .map(f => path.basename(f))
    .sort()
}

describe('Playwright specs take their port from HB_PORT', () => {
  it('no spec hard-codes one', () => {
    // A scan of zero files would pass: the count is part of the verdict.
    expect(specFiles(SPECS).length).toBeGreaterThan(30)
    expect(hardCoded(SPECS)).toEqual([])
  })

  it('goes red on a planted spec, for each form of hard-coded port', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-port-gate-'))
    const plant = (name: string, body: string) =>
      fs.writeFileSync(path.join(dir, `${name}.spec.cjs`), body)
    try {
      plant('ip', "const APP = process.env.HB_APP_URL || 'http://127.0.0.1:3000'\n")
      plant('other-port', "await page.goto('http://127.0.0.1:3002/')\n")
      plant('localhost', 'const APP = `http://localhost:3000`\n')
      plant('fallback', 'const APP = `http://127.0.0.1:${process.env.HB_PORT || 3000}`\n')
      plant('nullish', "const PORT = process.env.HB_PORT ?? '3000'\n")
      plant(
        'clean',
        'const APP = process.env.HB_APP_URL || `http://127.0.0.1:${process.env.HB_PORT}`\n' +
          'await page.waitForTimeout(3000)\n',
      )
      expect(hardCoded(dir)).toEqual([
        'fallback.spec.cjs',
        'ip.spec.cjs',
        'localhost.spec.cjs',
        'nullish.spec.cjs',
        'other-port.spec.cjs',
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('playwright.config.cjs ports', { timeout: 60000 }, () => {
  it('HB_PORT=3002 drives the webServer command and url', () => {
    const { out } = load({ HB_PORT: '3002' })
    expect(out.url).toBe('http://127.0.0.1:3002')
    expect(out.cmd).toContain('--port 3002')
    expect(out.port).toBe('3002')
  })

  it('unset HB_PORT picks free ports, none of them 3000, and publishes them for workers', () => {
    const { out } = load({})
    const ports = [out.port, out.re, out.mw].map(Number)
    for (const p of ports) expect(p).toBeGreaterThan(0)
    expect(ports).not.toContain(3000)
    expect(out.url).toBe(`http://127.0.0.1:${out.port}`)
    expect(out.cmd).toContain(`--port ${out.port}`)
  })

  it('two unset loads do not pick the same webServer port (best effort: free at pick time)', () => {
    const seen = new Set([load({}).out.port, load({}).out.port, load({}).out.port])
    expect(seen.size).toBeGreaterThan(1)
  })

  it('refuses an HB_PORT that is not an integer 1-65535 before it reaches a shell', () => {
    for (const bad of ['0', '65536', '3000; calc', '30.5', '-1', 'abc']) {
      const r = load({ HB_PORT: bad })
      expect(r.status, bad).not.toBe(0)
      expect(r.stderr).toContain('HB_PORT must be an integer 1-65535')
    }
  })

  it('refuses a reconnect or multi-window port that is not an integer 1-65535', () => {
    for (const name of ['HB_RECONNECT_PORT', 'HB_MULTIWINDOW_PORT']) {
      for (const bad of ['abc', '0', '65536', '30.5', '-1', '3000; calc']) {
        const r = load({ [name]: bad })
        expect(r.status, `${name}=${bad}`).not.toBe(0)
        expect(r.stderr).toContain(`${name} must be an integer 1-65535`)
      }
    }
  })

  it('an explicit reconnect or multi-window port is kept', () => {
    const { out } = load({ HB_RECONNECT_PORT: '3555', HB_MULTIWINDOW_PORT: '3556' })
    expect([out.re, out.mw]).toEqual(['3555', '3556'])
  })
})
