/**
 * Proof that bisect.mjs (design D5) can fail: the git-bisect-run exit
 * mapping is a real function call, not a string check on generated source
 * (the design used to generate a step.mjs file; D5 replaced that with this
 * file's own --step mode, so the mapping is testable directly), and the
 * default worktree path follows CLAUDE.md's placement convention.
 */
import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'node:path'
import {
  defaultTaskDir,
  exitCodeForStep,
  mainRepoRoot,
  run,
  runStep,
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
    // Built with node:path so the case holds on the Linux CI runner and on Windows.
    const dir = defaultTaskDir(join(sep, 'Projects', 'hackbench'), 'core.x.y', 'abcdef1234567')
    expect(dir).toBe(
      join(sep, 'Projects', '.worktrees', 'hackbench', 'perf-bisect-core.x.y-abcdef1'),
    )
  })
})

describe('mainRepoRoot: resolves through a linked worktree', () => {
  it('strips the trailing .git from git-common-dir', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const exec = () => `${join(repo, '.git')}\n`
    expect(mainRepoRoot(exec as never)).toBe(repo)
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

describe('run: refuses bad input before creating any worktree', () => {
  it('refuses --rounds below the paired minimum, since every step would skip', () => {
    const calls: string[][] = []
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return `${join(sep, 'Projects', 'hackbench', '.git')}\n`
    }
    expect(() => run({ id: 'core.x', good: 'a', bad: 'b', rounds: 3 }, exec as never)).toThrow(
      /--rounds must be an integer >= 5/,
    )
    expect(calls.some(c => c.includes('worktree'))).toBe(false)
  })

  it('resolves a relative --dir against the repo root', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const added: string[] = []
    const exec = (cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return `${join(repo, '.git')}\n`
      if (args[0] === 'worktree' && args[1] === 'add') added.push(args[2])
      throw new Error('stop after worktree setup')
    }
    expect(() =>
      run({ id: 'core.x', good: 'a', bad: 'b', dir: join('tmp', 'bisect') }, exec as never),
    ).toThrow()
    expect(added[0]).toBe(resolve(repo, 'tmp', 'bisect', 'good'))
  })
})
