/**
 * Proof that bisect.mjs (design D5) can fail: the git-bisect-run exit
 * mapping is a real function call, not a string check on generated source
 * (the design used to generate a step.mjs file; D5 replaced that with this
 * file's own --step mode, so the mapping is testable directly), and the
 * default worktree path follows CLAUDE.md's placement convention.
 */
import { describe, it, expect } from 'vitest'
import { join, resolve, sep } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  defaultTaskDir,
  exitCodeForStep,
  buildCommands,
  mainRepoRoot,
  run,
  runStep,
  suiteOf,
  argsToOptions,
  stepOptions,
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

describe('run: cleanup boundary', () => {
  it('removes only the worktrees it created when the second add throws', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const calls: string[][] = []
    const exec = (cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse')
        return `${join(repo, '.git')}
`
      calls.push([cmd, ...args])
      if (args[1] === 'add' && args[2].endsWith('work')) throw new Error('add failed')
      return ''
    }
    expect(() =>
      run({ id: 'core.x', good: 'a', bad: 'b', dir: join('tmp', 'bisect') }, exec as never),
    ).toThrow(/add failed/)
    const removed = calls.filter(c => c[2] === 'remove').map(c => c[4])
    expect(removed).toEqual([resolve(repo, 'tmp', 'bisect', 'good')])
  })

  it('still removes goodDir when removing workDir throws', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const removed: string[] = []
    const exec = (cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse')
        return `${join(repo, '.git')}
`
      if (args[1] === 'remove') {
        removed.push(args[3])
        if (args[3].endsWith('work')) throw new Error('remove failed')
      }
      if (args[0] === 'bisect' && args[1] === 'start') throw new Error('stop')
      return ''
    }
    expect(() =>
      run({ id: 'core.x', good: 'a', bad: 'b', dir: join('tmp', 'bisect') }, exec as never),
    ).toThrow()
    const base = resolve(repo, 'tmp', 'bisect')
    expect(removed).toEqual([join(base, 'work'), join(base, 'good')])
  })

  const cleanupExec = (repo: string, failOn: string | null, calls: string[][], stops = true) =>
    ((cmd: string, args: string[]) => {
      if (args[0] === 'rev-parse')
        return `${join(repo, '.git')}
`
      calls.push([cmd, ...args])
      if (args[1] === 'remove' && failOn && args[3].endsWith(failOn)) throw new Error('rm failed')
      if (stops && args[0] === 'bisect' && args[1] === 'start') throw new Error('stop')
      return ''
    }) as never

  it('keeps taskDir and rethrows when a worktree removal fails', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const taskDir = mkdtempSync(join(tmpdir(), 'bisect-keep-'))
    const calls: string[][] = []
    try {
      expect(() =>
        run(
          { id: 'core.x', good: 'a', bad: 'b', dir: taskDir },
          cleanupExec(repo, 'work', calls, false),
        ),
      ).toThrow(/rm failed/)
      expect(existsSync(taskDir)).toBe(true)
      expect(calls.filter(c => c[2] === 'remove').map(c => c[4])).toEqual([
        join(taskDir, 'work'),
        join(taskDir, 'good'),
      ])
    } finally {
      rmSync(taskDir, { recursive: true, force: true })
    }
  })

  it('removes taskDir when every removal succeeds', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const taskDir = mkdtempSync(join(tmpdir(), 'bisect-rm-'))
    try {
      expect(() =>
        run({ id: 'core.x', good: 'a', bad: 'b', dir: taskDir }, cleanupExec(repo, null, [])),
      ).toThrow(/stop/)
      expect(existsSync(taskDir)).toBe(false)
    } finally {
      rmSync(taskDir, { recursive: true, force: true })
    }
  })
})

describe('argsToOptions: CLI string rounds', () => {
  it('parses --rounds to a number', () => {
    expect(argsToOptions({ id: 'x', rounds: '5' }).rounds).toBe(5)
  })
  it('rejects a non-numeric --rounds', () => {
    expect(() => argsToOptions({ rounds: 'abc' })).toThrow(/--rounds must be a number/)
  })
  it('leaves an omitted --rounds undefined', () => {
    expect(argsToOptions({ id: 'x' }).rounds).toBeUndefined()
  })
})

describe('step mode --rounds', () => {
  for (const bad of ['abc', '0', '', '4'])
    it(`refuses --rounds ${JSON.stringify(bad)}`, () => {
      expect(() => stepOptions({ id: 'x', rounds: bad })).toThrow(/--rounds/)
    })
  it('accepts 5 and runStep forwards it to paired', () => {
    expect(stepOptions({ id: 'x', rounds: '5' }).rounds).toBe(5)
    const seen: string[][] = []
    const exec = (_c: string, args: string[]) => {
      seen.push(args)
      return ''
    }
    runStep({ id: 'core.x', goodDir: 'good', rounds: 5 }, exec as never)
    expect(seen.some(a => a.includes('--rounds') && a.includes('5'))).toBe(true)
  })
  it('forwards a defined rounds even when falsy', () => {
    const seen: string[][] = []
    runStep({ id: 'core.x', goodDir: 'g', rounds: 0 }, ((_c: string, a: string[]) => {
      seen.push(a)
      return ''
    }) as never)
    expect(seen.some(a => a.includes('--rounds'))).toBe(true)
  })

  it('refuses a non-empty task directory before creating anything', () => {
    const repo = join(sep, 'Projects', 'hackbench')
    const taskDir = mkdtempSync(join(tmpdir(), 'bisect-nonempty-'))
    writeFileSync(join(taskDir, 'keep.txt'), 'owner data')
    const calls: string[][] = []
    try {
      expect(() =>
        run({ id: 'core.x', good: 'a', bad: 'b', dir: taskDir }, ((cmd: string, args: string[]) => {
          if (args[0] === 'rev-parse')
            return `${join(repo, '.git')}
`
          calls.push([cmd, ...args])
          return ''
        }) as never),
      ).toThrow(/not empty/)
      expect(calls.some(c => c[1] === 'worktree')).toBe(false)
      expect(readFileSync(join(taskDir, 'keep.txt'), 'utf8')).toBe('owner data')
    } finally {
      rmSync(taskDir, { recursive: true, force: true })
    }
  })
})
