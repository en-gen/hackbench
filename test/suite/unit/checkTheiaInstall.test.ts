// A worktree whose theia/node_modules is a junction to another checkout
// bundles THAT checkout's extension and shares its build cache (#1038).
// Layouts are synthetic: no install, no ROM.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { checkTheiaInstall } from '../../../tools/scripts/check-theia-install.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'hb-theia-install-'))
afterAll(() => {
  // rmSync does not follow junctions, so the shared target survives.
  rmSync(root, { recursive: true, force: true })
})

const LINKS = ['hackbench-theia-extension', 'hackbench-browser-app', 'hackbench-electron-app']
const PKGS = ['extension', 'browser-app', 'electron-app']

/** A checkout with packages, and a real install whose links point `linkTo`. */
function checkout(name: string, linkTo: string | null = null): string {
  const dir = path.join(root, name)
  PKGS.forEach(p => mkdirSync(path.join(dir, 'theia', p), { recursive: true }))
  if (linkTo !== undefined) {
    const nm = path.join(dir, 'theia', 'node_modules')
    mkdirSync(nm, { recursive: true })
    LINKS.forEach((l, i) =>
      symlinkSync(path.join(linkTo ?? dir, 'theia', PKGS[i]), path.join(nm, l), 'junction'),
    )
  }
  return dir
}

describe('checkTheiaInstall', () => {
  const main = checkout('main')

  it('passes a real install whose links stay inside', () => {
    expect(checkTheiaInstall(main)).toBeNull()
  })

  it('refuses a node_modules junction to another checkout, naming the fix', () => {
    const wt = path.join(root, 'wt-junction')
    mkdirSync(path.join(wt, 'theia'), { recursive: true })
    symlinkSync(
      path.join(main, 'theia', 'node_modules'),
      path.join(wt, 'theia', 'node_modules'),
      'junction',
    )
    const problem = checkTheiaInstall(wt)
    expect(problem).toContain('yarn --cwd theia install')
    expect(problem).toContain('rmdir theia\node_modules')
  })

  it('refuses a real node_modules whose workspace links point at another checkout', () => {
    const wt = checkout('wt-links', main)
    const problem = checkTheiaInstall(wt)
    expect(problem).toContain('hackbench-theia-extension')
    expect(problem).toContain('yarn --cwd theia install')
  })

  it('refuses even an in-checkout link, and a theia folder that is itself a link', () => {
    const own = checkout('wt-own')
    // Isolate the link check: the target is inside `own` itself.
    rmSync(path.join(own, 'theia', 'node_modules'), { recursive: true })
    const inner = path.join(own, 'real_modules')
    mkdirSync(inner)
    symlinkSync(inner, path.join(own, 'theia', 'node_modules'), 'junction')
    expect(checkTheiaInstall(own)).toContain('is a link')
    const viaTheia = path.join(root, 'wt-theia-link')
    mkdirSync(viaTheia)
    symlinkSync(path.join(main, 'theia'), path.join(viaTheia, 'theia'), 'junction')
    expect(checkTheiaInstall(viaTheia)).toContain('yarn --cwd theia install')
  })

  it('leaves a missing node_modules to the build', () => {
    expect(checkTheiaInstall(checkout('wt-none', undefined as unknown as null))).toBeNull()
  })

  it('CLI exits non-zero with the message on a bad layout, zero on a good one', () => {
    const cli = path.resolve('tools/scripts/check-theia-install.mjs')
    const run = (dir: string) => spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' })
    expect(run(main).status).toBe(0)
    const bad = run(path.join(root, 'wt-links'))
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('yarn --cwd theia install')
  })
})

describe('guard wiring', () => {
  const read = (p: string) => readFileSync(path.resolve(p), 'utf8')
  it('theia build scripts run the guard before bundling', () => {
    const scripts = JSON.parse(read('theia/package.json')).scripts
    for (const s of ['prebuild', 'prebuild:browser', 'prebuild:electron']) {
      expect(scripts[s], s).toContain('check-theia-install.mjs')
    }
  })
  it('playwright config runs it only when it starts its own server', () => {
    const cfg = read('theia/browser-app/playwright.config.cjs')
    expect(cfg).toMatch(/!process\.env\.HB_APP_URL[\s\S]{0,200}check-theia-install/)
  })
})
