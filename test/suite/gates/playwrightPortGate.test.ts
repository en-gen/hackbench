/**
 * Concurrent Playwright runs (run-lock slots) must not collide on a port. The
 * config picks a free port when HB_PORT is unset and writes it to process.env
 * for the workers; HB_PORT only forces one. Synthetic: loads the config in a
 * child process, starts no server and needs no ROM.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'child_process'
import * as path from 'path'

const CONFIG = path.resolve(__dirname, '../../../theia/browser-app/playwright.config.cjs')
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
    env: { ...base, ...env },
  })
  return { status: r.status, stderr: r.stderr, out: r.status === 0 ? JSON.parse(r.stdout) : null }
}

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

  it('an explicit reconnect or multi-window port is kept', () => {
    const { out } = load({ HB_RECONNECT_PORT: '3555', HB_MULTIWINDOW_PORT: '3556' })
    expect([out.re, out.mw]).toEqual(['3555', '3556'])
  })
})
