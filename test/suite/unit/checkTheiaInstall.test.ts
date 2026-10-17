// A worktree whose Theia install is a junction to another checkout bundles
// THAT checkout's extension and shares its build cache (#1038).
// Layouts are synthetic: no install, no ROM.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs without types
import { checkTheiaInstall } from '../../../tools/scripts/check-theia-install.mjs'

const root = mkdtempSync(path.join(tmpdir(), 'hb-theia-install-'))
afterAll(() => {
  // rmSync does not follow junctions, so shared targets survive until their own turn.
  rmSync(root, { recursive: true, force: true })
})

const SCRIPT = path.resolve('tools/scripts/check-theia-install.mjs')
const CONFIG = path.resolve('theia/browser-app/playwright.config.cjs')
const LINKS = ['hackbench-theia-extension', 'hackbench-browser-app', 'hackbench-electron-app']
const PKGS = ['extension', 'browser-app', 'electron-app']
const junction = (target: string, at: string) => symlinkSync(target, at, 'junction')
// A real shell sets PWD to the logical path on cd, and yarn/npm set INIT_CWD.
// spawnSync sets neither, so on POSIX the child sees only the symlink target
// and a linked theia folder looks like the target's own checkout (CI, Linux).
const logicalEnv = (cwd: string, base: NodeJS.ProcessEnv = process.env) => ({
  ...base,
  PWD: cwd,
  INIT_CWD: cwd,
})
const nmOf = (dir: string) => path.join(dir, 'theia', 'node_modules')

/** A checkout with packages and the guard script; `install` adds a real node_modules. */
function checkout(name: string, install: { linkTo?: string; only?: number[] } | null = {}): string {
  const dir = path.join(root, name)
  PKGS.forEach(p => mkdirSync(path.join(dir, 'theia', p), { recursive: true }))
  mkdirSync(path.join(dir, 'tools', 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, path.join(dir, 'tools', 'scripts', 'check-theia-install.mjs'))
  if (install) {
    mkdirSync(nmOf(dir), { recursive: true })
    LINKS.forEach((l, i) => {
      if (!install.only || install.only.includes(i))
        junction(path.join(install.linkTo ?? dir, 'theia', PKGS[i]), path.join(nmOf(dir), l))
    })
  }
  return dir
}
/** A worktree whose theia/node_modules is a junction to `main`'s. */
function junctioned(name: string, main: string): string {
  const wt = checkout(name, null)
  junction(nmOf(main), nmOf(wt))
  return wt
}
/** A worktree whose whole theia folder is a junction to a bare checkout's. */
function theiaJunctioned(name: string): string {
  const bare = checkout(`${name}-target`, { only: [] })
  const wt = checkout(name, null)
  rmSync(path.join(wt, 'theia'), { recursive: true })
  junction(path.join(bare, 'theia'), path.join(wt, 'theia'))
  return wt
}

const main = checkout('main')
const INSTALL = '`yarn --cwd theia install`'

describe('checkTheiaInstall', () => {
  it('passes a real install whose links stay inside', () => {
    expect(checkTheiaInstall(main)).toBeNull()
  })

  it('refuses a node_modules junction with the exact fix text (no newline in the path)', () => {
    const problem = checkTheiaInstall(junctioned('wt-junction', main)) as string
    expect(problem).toContain('theia/node_modules is a link to another folder')
    expect(problem).toContain('`cmd /c rmdir theia\\node_modules`')
    expect(problem).toContain(`then run ${INSTALL} from this worktree`)
    expect(problem).not.toContain('\n')
  })

  it('refuses a real node_modules with outside links, advising just the install', () => {
    const problem = checkTheiaInstall(checkout('wt-links', { linkTo: main })) as string
    expect(problem).toContain('hackbench-theia-extension')
    expect(problem).toContain(`Fix: run ${INSTALL} from this worktree.`)
    expect(problem).not.toContain('rmdir')
  })

  it.each([0, 1, 2])('refuses when only link %i points at another checkout', bad => {
    const wt = checkout(`wt-one-${bad}`)
    rmSync(path.join(nmOf(wt), LINKS[bad]))
    junction(path.join(main, 'theia', PKGS[bad]), path.join(nmOf(wt), LINKS[bad]))
    expect(checkTheiaInstall(wt)).toContain(LINKS[bad])
  })

  it('refuses a theia folder that is itself a junction, even with no hackbench links yet', () => {
    const problem = checkTheiaInstall(theiaJunctioned('wt-theia-link')) as string
    expect(problem).toContain('theia folder is itself a link')
    expect(problem).toContain('`cmd /c rmdir theia`')
    expect(problem).toContain('git checkout -- theia')
    expect(problem).toContain(INSTALL)
  })

  it('does not mistake a sibling sharing a name prefix for the same checkout', () => {
    const sibling = checkout('main-2', { linkTo: main })
    expect(checkTheiaInstall(sibling)).toContain('point at another checkout')
    expect(checkTheiaInstall(checkout('main-2b'))).toBeNull()
  })

  it('passes a partial install missing a link', () => {
    expect(checkTheiaInstall(checkout('wt-partial', { only: [0] }))).toBeNull()
  })

  it('leaves a missing node_modules to the build', () => {
    expect(checkTheiaInstall(checkout('wt-none', null))).toBeNull()
  })

  it.each(['extension', 'browser-app', 'electron-app'])(
    'refuses theia/%s/node_modules linked to another checkout',
    pkg => {
      const rel = `theia/${pkg}/node_modules`
      const wt = checkout(`wt-${pkg}`)
      const shared = path.join(main, rel)
      mkdirSync(shared, { recursive: true })
      junction(shared, path.join(wt, rel))
      const problem = checkTheiaInstall(wt) as string
      expect(problem).toContain(`${rel} is a link to another checkout`)
      expect(problem).toContain('`cmd /c rmdir ' + rel.replaceAll('/', '\\') + '`')
    },
  )

  it('refuses theia/node_modules/.cache linked to another checkout', () => {
    const wt = checkout('wt-cache')
    const shared = path.join(nmOf(main), '.cache')
    mkdirSync(shared, { recursive: true })
    junction(shared, path.join(nmOf(wt), '.cache'))
    expect(checkTheiaInstall(wt)).toContain('theia/node_modules/.cache is a link')
  })

  it('passes an in-checkout link for those folders', () => {
    const wt = checkout('wt-cache-own')
    mkdirSync(path.join(wt, 'elsewhere'))
    junction(path.join(wt, 'elsewhere'), path.join(nmOf(wt), '.cache'))
    expect(checkTheiaInstall(wt)).toBeNull()
  })

  it('CLI exits 1 with the message on a bad layout, 0 on a good one, also via a link', () => {
    const run = (cli: string, dir: string) =>
      spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' })
    expect(run(SCRIPT, main).status).toBe(0)
    const bad = run(SCRIPT, junctioned('wt-cli', main))
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('yarn --cwd theia install')
    const viaLink = path.join(root, 'tools-link')
    junction(path.dirname(SCRIPT), viaLink)
    const linked = run(path.join(viaLink, 'check-theia-install.mjs'), junctioned('wt-cli2', main))
    expect(linked.status).toBe(1)
  })
})

describe('guard wiring', () => {
  const read = (p: string) => readFileSync(path.resolve(p), 'utf8')
  const scripts = JSON.parse(read('theia/package.json')).scripts
  const hook = (name: string, wt: string) =>
    spawnSync(scripts[name], {
      shell: true,
      cwd: path.join(wt, 'theia'),
      env: logicalEnv(path.join(wt, 'theia')),
      encoding: 'utf8',
    })

  it.each(['prebuild', 'prebuild:browser', 'prebuild:electron'])(
    '%s runs the guard and fails in a junctioned worktree',
    name => {
      const r = hook(name, junctioned(`wt-hook-${name.replace(':', '-')}`, main))
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('yarn --cwd theia install')
    },
  )

  it('the prebuild hook also refuses when the theia folder is the junction', () => {
    expect(hook('prebuild', theiaJunctioned('wt-hook-theia')).status).toBe(1)
  })

  describe('playwright config', () => {
    const load = (cwd: string, extra: Record<string, string> = {}) => {
      const env = logicalEnv(cwd, { ...process.env, ...extra })
      for (const k of ['HB_APP_URL', 'HB_SKIP_INSTALL_GUARD']) if (!(k in extra)) delete env[k]
      return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONFIG)})`], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 60000,
      })
    }

    it('throws in a junctioned worktree, loads in a good one and when skipped', () => {
      const bad = junctioned('wt-config', main)
      const r = load(path.join(bad, 'theia', 'browser-app'))
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('yarn --cwd theia install')
      expect(load(path.join(main, 'theia', 'browser-app')).status).toBe(0)
      expect(load(bad, { HB_SKIP_INSTALL_GUARD: '1' }).status).toBe(0)
    })

    it('throws when the theia folder is the junction', () => {
      const r = load(path.join(theiaJunctioned('wt-config-theia'), 'theia', 'browser-app'))
      expect(r.status).not.toBe(0)
    })
  })
})

describe('logical path when cwd is already resolved (POSIX, #1038 review)', () => {
  // On POSIX process.cwd() is the symlink TARGET; the shell's PWD and yarn's
  // INIT_CWD keep the worktree path. Simulated on any platform by running in
  // the target with the logical path in the env.
  const wt = theiaJunctioned('wt-logical')
  const target = path.join(root, 'wt-logical-target', 'theia')
  const logical = path.join(wt, 'theia')
  const clean = () => {
    const env = { ...process.env }
    for (const k of ['PWD', 'INIT_CWD', 'HB_APP_URL', 'HB_SKIP_INSTALL_GUARD']) delete env[k]
    return env
  }
  const cli = (cwd: string, extra: Record<string, string>) =>
    spawnSync(
      process.execPath,
      [path.join(cwd, '..', 'tools', 'scripts', 'check-theia-install.mjs')],
      {
        cwd,
        env: { ...clean(), ...extra },
        encoding: 'utf8',
      },
    )

  it('the CLI follows INIT_CWD or a matching PWD to the junctioned worktree', () => {
    expect(cli(target, {}).status).toBe(0) // no logical path known: nothing to see
    expect(cli(target, { INIT_CWD: logical }).status).toBe(1)
    expect(cli(target, { PWD: logical }).status).toBe(1)
  })

  it('ignores a PWD that is not the cwd, so a stale value cannot refuse a good checkout', () => {
    const r = cli(path.join(main, 'theia'), { PWD: logical })
    expect(r.status).toBe(0)
  })

  it('the prebuild hook refuses via INIT_CWD', () => {
    const r = spawnSync(scripts().prebuild, {
      shell: true,
      cwd: target,
      env: { ...clean(), INIT_CWD: logical },
      encoding: 'utf8',
    })
    expect(r.status).toBe(1)
  })

  it('the Playwright config refuses via PWD', () => {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONFIG)})`], {
      cwd: path.join(target, 'browser-app'),
      env: { ...clean(), PWD: path.join(logical, 'browser-app') },
      encoding: 'utf8',
      timeout: 60000,
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('yarn --cwd theia install')
  })
})
function scripts(): Record<string, string> {
  return JSON.parse(readFileSync(path.resolve('theia/package.json'), 'utf8')).scripts
}
