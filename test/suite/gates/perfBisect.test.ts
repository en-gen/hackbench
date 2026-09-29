/**
 * Proof that bisect.mjs (design D5) can fail: the git-bisect-run exit
 * mapping is a real function call, not a string check on generated source
 * (the design used to generate a step.mjs file; D5 replaced that with this
 * file's own --step mode, so the mapping is testable directly), and the
 * default worktree path follows CLAUDE.md's placement convention.
 */
import { describe, it, expect } from 'vitest'
import {
  defaultTaskDir,
  exitCodeForStep,
  buildCommands,
  mainRepoRoot,
  runStep,
  suiteOf,
} from '../../../tools/perf/bisect.mjs'

describe('exitCodeForStep: the git bisect run mapping', () => {
  it('maps compare.mjs exit 0 (ok) to bisect good (0)', () => {
    expect(exitCodeForStep(0)).toBe(0)
  })
  it('maps compare.mjs exit 1 (regression) to bisect bad (1)', () => {
    expect(exitCodeForStep(1)).toBe(1)
  })
  it('maps compare.mjs exit 2 (malformed) to bisect skip (125)', () => {
    expect(exitCodeForStep(2)).toBe(125)
  })
  it('maps any other exit code to skip (125), never good or bad', () => {
    expect(exitCodeForStep(17)).toBe(125)
    expect(exitCodeForStep(undefined as unknown as number)).toBe(125)
  })
})

describe('defaultTaskDir: CLAUDE.md worktree placement', () => {
  it('is <parent-of-repo>/.worktrees/<repo-name>/perf-bisect-<id>-<good7>', () => {
    const dir = defaultTaskDir('C:\\Projects\\hackbench', 'core.x.y', 'abcdef1234567')
    expect(dir).toBe('C:\\Projects\\.worktrees\\hackbench\\perf-bisect-core.x.y-abcdef1')
  })
})

describe('mainRepoRoot: resolves through a linked worktree', () => {
  it('strips the trailing .git from git-common-dir', () => {
    const exec = () => 'C:\\Projects\\hackbench\\.git\n'
    expect(mainRepoRoot(exec as never)).toBe('C:\\Projects\\hackbench')
  })
})

describe('runStep, exec mocked', () => {
  function fakeExec(script: { npmFails?: boolean; pairedFails?: boolean; compareStatus?: number }) {
    return (cmd: string, args: string[]) => {
      if (cmd.includes('npm')) {
        if (script.npmFails) throw new Error('npm ci failed')
        return ''
      }
      if (args.some(a => String(a).includes('paired.mjs'))) {
        if (script.pairedFails) throw new Error('paired run failed')
        // pretend it wrote bisect-round.json; runStep only checks existsSync,
        // so the caller creates the file in the test body when needed
        return ''
      }
      if (args.some(a => String(a).includes('compare.mjs'))) {
        const status = script.compareStatus ?? 0
        if (status !== 0) {
          const err = new Error(`compare exited ${status}`) as Error & { status: number }
          err.status = status
          throw err
        }
        return ''
      }
      throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`)
    }
  }

  it('a build failure is a skip (125), not a bad (1)', () => {
    expect(runStep({ id: 'core.x', goodDir: 'good' }, fakeExec({ npmFails: true }) as never)).toBe(
      125,
    )
  })

  it('a failed paired run is a skip (125)', () => {
    expect(
      runStep({ id: 'core.x', goodDir: 'good' }, fakeExec({ pairedFails: true }) as never),
    ).toBe(125)
  })
})

describe('suite selection and build steps (D5)', () => {
  it('picks the suite from the id prefix and refuses an unknown one', () => {
    expect(suiteOf('core.lclz2.x')).toBe('core')
    for (const id of ['app.open-map16', 'startup.shell', 'heap.gfx-reopen']) {
      expect(suiteOf(id)).toBe('app')
    }
    expect(() => suiteOf('bogus.x')).toThrow(/cannot tell/)
  })

  it('core builds with npm ci only', () => {
    const cmds = buildCommands('core', '/w', { theiaInstalled: true })
    expect(cmds.map(c => c.args[0])).toEqual(['ci'])
  })

  it('app builds the extension BEFORE the browser bundle, installing theia only if missing', () => {
    const steps = (installed: boolean) =>
      buildCommands('app', '/w', { theiaInstalled: installed }).map(c => c.args.join(' '))
    expect(steps(true)).toEqual([
      'ci --no-audit --no-fund',
      '--cwd theia/extension build',
      '--cwd theia build:browser',
    ])
    expect(steps(false)[1]).toBe('--cwd theia install')
  })

  it('runStep for an app id runs paired with --suite app and the app build', () => {
    const seen: string[] = []
    const exec = (cmd: string, args: string[]) => {
      seen.push([cmd, ...args].join(' '))
      return ''
    }
    expect(runStep({ id: 'app.open-map16', goodDir: 'good' }, exec as never)).toBe(125) // paired wrote nothing
    expect(seen.some(c => c.includes('theia build:browser'))).toBe(true)
    expect(seen.some(c => c.includes('--suite app'))).toBe(true)
  })
})
