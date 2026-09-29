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
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIN_ROUNDS } from './paired.mjs'

// Every step runs THIS checkout's tools: a historical commit may predate them,
// and a missing script exits 1, which git bisect would read as "bad".
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url))

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

function npmCi(cwd, exec) {
  exec(NPM, ['ci', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit' })
}

/** `git bisect run`'s step, run from inside the bisected worktree at HEAD:
 *  build this commit, pair it against `goodDir`, and exit per
 *  exitCodeForStep. A build or paired-run failure is 125 (skip), not 1
 *  (bad): a commit that will not even build is not evidence the benchmark
 *  regressed there. */
export function runStep({ id, goodDir, rounds }, exec = execFileSync) {
  const cwd = process.cwd()
  try {
    npmCi(cwd, exec)
  } catch (e) {
    console.error('build failed at this commit:', e.message)
    return 125
  }

  const pairedOut = join(cwd, 'bisect-round.json')
  try {
    const args = [
      join(TOOLS_DIR, 'paired.mjs'),
      '--base',
      goodDir,
      '--cand',
      cwd,
      '--suite',
      'core',
      '--only',
      id,
      '--out',
      pairedOut,
    ]
    if (rounds !== undefined) args.push('--rounds', String(rounds))
    exec(process.execPath, args, { cwd, stdio: 'inherit' })
  } catch (e) {
    console.error('paired run failed at this commit:', e.message)
    return 125
  }
  if (!existsSync(pairedOut)) return 125

  try {
    exec(process.execPath, [join(TOOLS_DIR, 'compare.mjs'), '--in', pairedOut, '--seed', '1'], {
      cwd,
      stdio: 'inherit',
    })
    return exitCodeForStep(0)
  } catch (e) {
    return exitCodeForStep(typeof e.status === 'number' ? e.status : 2)
  }
}

function checkRounds(rounds) {
  if (rounds !== undefined && !(Number.isInteger(rounds) && rounds >= MIN_ROUNDS)) {
    throw new Error(`--rounds must be an integer >= ${MIN_ROUNDS}, got ${JSON.stringify(rounds)}`)
  }
}

/** Sets up the good/work worktrees and drives `git bisect run` between them.
 *  Removes both worktrees in a finally regardless of outcome. */
export function run({ id, good, bad, dir, rounds }, exec = execFileSync) {
  if (!id || !good || !bad) throw new Error('bisect.mjs needs --id, --good and --bad')
  // paired.mjs refuses fewer rounds, and a refused step is a skip (125), so
  // bisect would skip every commit and name no culprit. Refuse up front.
  checkRounds(rounds)
  const repoRoot = mainRepoRoot(exec)
  // Absolute, because git bisect runs each step from the work worktree.
  const taskDir = resolve(repoRoot, dir ?? defaultTaskDir(repoRoot, id, good))
  // Cleanup deletes taskDir, so it must hold nothing this run did not create.
  if (existsSync(taskDir) && readdirSync(taskDir).length > 0) {
    throw new Error(`task directory is not empty: ${taskDir} (remove it or pass another --dir)`)
  }
  const goodDir = join(taskDir, 'good')
  const workDir = join(taskDir, 'work')

  const created = []
  let result
  let failure
  let failed = false
  let removeError
  try {
    exec('git', ['worktree', 'add', goodDir, good], { cwd: repoRoot, stdio: 'inherit' })
    created.push(goodDir)
    exec('git', ['worktree', 'add', workDir, bad], { cwd: repoRoot, stdio: 'inherit' })
    created.push(workDir)
    npmCi(goodDir, exec)
    exec('git', ['bisect', 'start', bad, good], { cwd: workDir, stdio: 'inherit' })
    try {
      const roundsArgs = rounds !== undefined ? ['--rounds', String(rounds)] : []
      const out = exec(
        'git',
        [
          'bisect',
          'run',
          process.execPath,
          join(TOOLS_DIR, 'bisect.mjs'),
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
      result = { taskDir, goodDir, workDir, output: out }
    } finally {
      exec('git', ['bisect', 'reset'], { cwd: workDir, stdio: 'inherit' })
    }
  } catch (e) {
    failed = true
    failure = e
  } finally {
    // Each removal is attempted even if an earlier one throws. A failed
    // removal keeps taskDir (it still holds a registered worktree).
    for (const d of created.reverse()) {
      try {
        exec('git', ['worktree', 'remove', '--force', d], { cwd: repoRoot, stdio: 'inherit' })
      } catch (e) {
        console.error(`could not remove worktree ${d}:`, e.message)
        removeError ??= e
      }
    }
    if (!removeError) rmSync(taskDir, { recursive: true, force: true })
  }
  if (failed) throw failure
  if (removeError) throw removeError
  return result
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

/** parseArgs yields --rounds as a string; run() wants a number. */
export function argsToOptions(values) {
  const opts = { ...values }
  if (values.rounds !== undefined) {
    const n = Number(values.rounds)
    if (values.rounds.trim() === '' || Number.isNaN(n)) {
      throw new Error(`--rounds must be a number, got ${JSON.stringify(values.rounds)}`)
    }
    opts.rounds = n
  }
  return opts
}

/** Step mode takes the same --rounds validation as the run branch. */
export function stepOptions(values) {
  const opts = argsToOptions(values)
  checkRounds(opts.rounds)
  return opts
}

// Same invoked-directly test as tools/scripts/check-content.mjs.
const isMain = /bisect\.mjs$/i.test(process.argv[1] ?? '')
if (isMain) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: CLI_OPTIONS, strict: true })
  if (values.step) {
    try {
      const { rounds } = stepOptions(values)
      process.exit(runStep({ id: values.id, goodDir: values['good-dir'], rounds }))
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(125)
    }
  } else {
    try {
      run(argsToOptions(values))
      process.exit(0)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(2)
    }
  }
}
