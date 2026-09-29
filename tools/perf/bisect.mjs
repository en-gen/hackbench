#!/usr/bin/env node
// Bisect (design section 6, step 3): finds the first commit between --good
// and --bad that regresses one benchmark id, using the same paired.mjs the
// nightly workflow runs, so a bisect measures exactly what it measured.
//
//   node tools/perf/bisect.mjs --id <id> --good <sha> --bad <sha>
//        [--dir <taskDir>] [--rounds N]
//
// Builds two git worktrees under <parent-of-repo>/.worktrees/hackbench/
// perf-bisect-<id>-<good7> (design D5, CLAUDE.md's worktree-placement
// convention), removed in a finally, then runs `git bisect run` against
// `node tools/perf/bisect.mjs --step`, this file's own second mode: no
// generated source file, so the step logic is covered by ordinary imports
// and unit tests instead of a string template.

import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { MIN_ROUNDS } from './paired.mjs'

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/** The real repo root even when this process runs inside a linked worktree
 *  (git-common-dir always points at the main checkout's .git). */
export function mainRepoRoot(exec = execFileSync) {
  const gitCommonDir = exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
  }).trim()
  return dirname(gitCommonDir)
}

/** <parent-of-repo>/.worktrees/<repo-name>/perf-bisect-<id>-<good7> (design D5). */
export function defaultTaskDir(repoRoot, id, good) {
  return join(
    dirname(repoRoot),
    '.worktrees',
    basename(repoRoot),
    `perf-bisect-${id}-${good.slice(0, 7)}`,
  )
}

/** Maps compare.mjs's own exit code to what `git bisect run` expects: 0
 *  good, 1 bad, anything else (malformed input, a build failure) skip. */
export function exitCodeForStep(compareExitCode) {
  if (compareExitCode === 0) return 0
  if (compareExitCode === 1) return 1
  return 125
}

const YARN = process.platform === 'win32' ? 'yarn.cmd' : 'yarn'

/** The suite an id belongs to: core.* runs the core suite, the rest the app suite. */
export function suiteOf(id) {
  if (id.startsWith('core.')) return 'core'
  if (/^(app|startup|heap)\./.test(id)) return 'app'
  throw new Error(`cannot tell which suite '${id}' belongs to`)
}

/** What building `cwd` for `suite` runs, in order. The app suite needs the
 *  extension built BEFORE the browser bundle: the other order silently
 *  bundles a stale backend. */
export function buildCommands(suite, cwd, { theiaInstalled }) {
  const cmds = [[NPM, ['ci', '--no-audit', '--no-fund']]]
  if (suite === 'app') {
    if (!theiaInstalled) cmds.push([YARN, ['--cwd', 'theia', 'install']])
    cmds.push(
      [YARN, ['--cwd', 'theia/extension', 'build']],
      [YARN, ['--cwd', 'theia', 'build:browser']],
    )
  }
  return cmds.map(([cmd, args]) => ({ cmd, args, cwd }))
}

function build(suite, cwd, exec) {
  const theiaInstalled = existsSync(join(cwd, 'theia', 'node_modules'))
  for (const { cmd, args } of buildCommands(suite, cwd, { theiaInstalled })) {
    exec(cmd, args, { cwd, stdio: 'inherit', windowsHide: true })
  }
}

/** `git bisect run`'s step, run from inside the bisected worktree at HEAD:
 *  build this commit, pair it against `goodDir`, and exit per
 *  exitCodeForStep. A build or paired-run failure is 125 (skip), not 1
 *  (bad): a commit that will not even build is not evidence the benchmark
 *  regressed there. */
export function runStep({ id, goodDir, rounds }, exec = execFileSync) {
  const cwd = process.cwd()
  const suite = suiteOf(id)
  try {
    build(suite, cwd, exec)
  } catch (e) {
    console.error('build failed at this commit:', e.message)
    return 125
  }

  const pairedOut = join(cwd, 'bisect-round.json')
  try {
    const args = [
      'tools/perf/paired.mjs',
      '--base',
      goodDir,
      '--cand',
      cwd,
      '--suite',
      suite,
      '--only',
      id,
      '--out',
      pairedOut,
    ]
    if (rounds) args.push('--rounds', String(rounds))
    exec(process.execPath, args, { cwd, stdio: 'inherit' })
  } catch (e) {
    console.error('paired run failed at this commit:', e.message)
    return 125
  }
  if (!existsSync(pairedOut)) return 125

  try {
    exec(
      process.execPath,
      [join(cwd, 'tools', 'perf', 'compare.mjs'), '--in', pairedOut, '--seed', '1'],
      {
        cwd,
        stdio: 'inherit',
      },
    )
    return exitCodeForStep(0)
  } catch (e) {
    return exitCodeForStep(typeof e.status === 'number' ? e.status : 2)
  }
}

/** Sets up the good/work worktrees and drives `git bisect run` between them.
 *  Removes both worktrees in a finally regardless of outcome. */
export function run({ id, good, bad, dir, rounds }, exec = execFileSync) {
  if (!id || !good || !bad) throw new Error('bisect.mjs needs --id, --good and --bad')
  // paired.mjs refuses fewer rounds, and a refused step is a skip (125), so
  // bisect would skip every commit and name no culprit. Refuse up front.
  if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= MIN_ROUNDS)) {
    throw new Error(`--rounds must be an integer >= ${MIN_ROUNDS}, got ${JSON.stringify(rounds)}`)
  }
  const repoRoot = mainRepoRoot(exec)
  // Absolute, because git bisect runs each step from the work worktree.
  const taskDir = resolve(repoRoot, dir ?? defaultTaskDir(repoRoot, id, good))
  const goodDir = join(taskDir, 'good')
  const workDir = join(taskDir, 'work')

  exec('git', ['worktree', 'add', goodDir, good], { cwd: repoRoot, stdio: 'inherit' })
  exec('git', ['worktree', 'add', workDir, bad], { cwd: repoRoot, stdio: 'inherit' })
  try {
    build(suiteOf(id), goodDir, exec)
    exec('git', ['bisect', 'start', bad, good], { cwd: workDir, stdio: 'inherit' })
    try {
      const roundsArgs = rounds ? ['--rounds', String(rounds)] : []
      const out = exec(
        'git',
        [
          'bisect',
          'run',
          process.execPath,
          'tools/perf/bisect.mjs',
          '--step',
          '--id',
          id,
          '--good-dir',
          goodDir,
          ...roundsArgs,
        ],
        { cwd: workDir, encoding: 'utf8' },
      )
      console.log(out)
      return { taskDir, goodDir, workDir, output: out }
    } finally {
      exec('git', ['bisect', 'reset'], { cwd: workDir, stdio: 'inherit' })
    }
  } finally {
    exec('git', ['worktree', 'remove', '--force', workDir], { cwd: repoRoot, stdio: 'inherit' })
    exec('git', ['worktree', 'remove', '--force', goodDir], { cwd: repoRoot, stdio: 'inherit' })
    rmSync(taskDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CLI_OPTIONS = {
  id: { type: 'string' },
  good: { type: 'string' },
  bad: { type: 'string' },
  dir: { type: 'string' },
  rounds: { type: 'string' },
  step: { type: 'boolean', default: false },
  'good-dir': { type: 'string' },
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
const isMain = /bisect\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: CLI_OPTIONS, strict: true })
  if (values.step) {
    process.exit(runStep({ id: values.id, goodDir: values['good-dir'], rounds: values.rounds }))
  } else {
    try {
      run(values)
      process.exit(0)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(2)
    }
  }
}
