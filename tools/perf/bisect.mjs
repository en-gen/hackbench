#!/usr/bin/env node
// Bisect (design section 6, step 3): finds the first commit between --good
// and --bad that regresses one benchmark id, using the same paired.mjs the
// nightly workflow runs, so a bisect measures exactly what it measured.
//
//   node tools/perf/bisect.mjs --id <id> --good <sha> --bad <sha> [--dir <scratchDir>]
//
// Builds two git worktrees (good, fixed; bad..good range, walked by
// `git bisect`) under the given dir or a fresh one under the OS temp dir,
// then runs `git bisect run` with a small step script that pairs the good
// worktree against the bisect HEAD and exits 0/1 the way `git bisect run`
// expects (0 good, 1 bad).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--id') args.id = argv[++i]
    else if (a === '--good') args.good = argv[++i]
    else if (a === '--bad') args.bad = argv[++i]
    else if (a === '--dir') args.dir = argv[++i]
    else if (a === '--rounds') args.rounds = argv[++i]
  }
  return args
}

/** The script `git bisect run` executes at each candidate commit. Builds the
 *  candidate in place (whatever `npm ci` the checkout needs), pairs it
 *  against the fixed `goodDir`, and forwards compare.mjs's own exit code -
 *  0 or 1 mean exactly what `git bisect run` wants; 2 (malformed) is
 *  remapped to git's "skip" code (125) since it says nothing about good/bad.
 */
export function stepScriptSource({ repoRoot, goodDir, id, rounds }) {
  const roundsArg = rounds ? `'--rounds', '${rounds}',` : ''
  return `import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
try {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' })
} catch (e) {
  console.error('build failed at this commit:', e.message)
  process.exit(125)
}
const pairedOut = 'bisect-round.json'
try {
  execFileSync(process.execPath, [
    ${JSON.stringify(join(repoRoot, 'tools', 'perf', 'paired.mjs'))},
    '--base', ${JSON.stringify(goodDir)},
    '--cand', process.cwd(),
    '--suite', 'core',
    ${roundsArg}
    '--only', ${JSON.stringify(id)},
    '--out', pairedOut,
  ], { stdio: 'inherit' })
} catch (e) {
  console.error('paired run failed at this commit:', e.message)
  process.exit(125)
}
if (!existsSync(pairedOut)) process.exit(125)
try {
  execFileSync(process.execPath, [
    ${JSON.stringify(join(repoRoot, 'tools', 'perf', 'compare.mjs'))},
    '--in', pairedOut,
    '--seed', '1',
  ], { stdio: 'inherit' })
  process.exit(0)
} catch (e) {
  const code = e.status
  process.exit(code === 1 ? 1 : 125)
}
`
}

export function run({ id, good, bad, dir, rounds }, exec = execFileSync) {
  if (!id || !good || !bad) throw new Error('bisect.mjs needs --id, --good and --bad')
  const repoRoot = exec('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const scratch = dir ?? mkdtempSync(join(tmpdir(), 'hb-perf-bisect-'))
  const goodDir = join(scratch, 'good')
  const workDir = join(scratch, 'work')

  if (!existsSync(goodDir))
    exec('git', ['worktree', 'add', goodDir, good], { cwd: repoRoot, stdio: 'inherit' })
  if (!existsSync(workDir))
    exec('git', ['worktree', 'add', workDir, bad], { cwd: repoRoot, stdio: 'inherit' })
  exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: goodDir, stdio: 'inherit' })

  const stepPath = join(scratch, 'step.mjs')
  writeFileSync(stepPath, stepScriptSource({ repoRoot, goodDir, id, rounds }))

  exec('git', ['bisect', 'start', bad, good], { cwd: workDir, stdio: 'inherit' })
  try {
    const out = exec('git', ['bisect', 'run', process.execPath, stepPath], {
      cwd: workDir,
      encoding: 'utf8',
    })
    console.log(out)
    return { scratch, goodDir, workDir, output: out }
  } finally {
    exec('git', ['bisect', 'reset'], { cwd: workDir, stdio: 'inherit' })
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  try {
    run(args)
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
}
