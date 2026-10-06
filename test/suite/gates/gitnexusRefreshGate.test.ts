/**
 * #644: `npm run gitnexus` must not touch CLAUDE.md or AGENTS.md.
 *
 * The real analyzer is replaced by a stub that rewrites both files exactly
 * when it is NOT given --skip-agents-md, as gitnexus analyze does. Evidence
 * scope: the stub models the flag; the flag itself is gitnexus's own.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { findBash } from '../support/gitBash'

const repoRoot = path.resolve(__dirname, '../../..')
const script = path.join(repoRoot, 'tools/scripts/gitnexus-refresh.sh')

function makeWritable(p: string): void {
  fs.chmodSync(p, 0o700)
  if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) makeWritable(path.join(p, e))
}

// Which analyze call the stub lets succeed; earlier ones exit 1, so the script
// walks its fallbacks (analyze, then --repair-fts, then --force).
type Mode = 'first' | 'repair' | 'force'
const MODES: Mode[] = ['first', 'repair', 'force']

function runRefresh(scriptText: string, mode: Mode = 'first'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gnrefresh-'))
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    fs.mkdirSync(path.join(dir, 'tools/scripts'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.gitnexus'))
    fs.writeFileSync(path.join(dir, 'tools/scripts/gitnexus-refresh.sh'), scriptText)
    fs.writeFileSync(path.join(dir, 'tools/scripts/normalize-generated-docs.py'), '')
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      fs.writeFileSync(path.join(dir, f), '# Quality gates\n')
    }
    fs.writeFileSync(
      path.join(dir, '.gitnexus/run.cjs'),
      `const a = process.argv
       if (!a.includes('--skip-agents-md'))
         for (const f of ['CLAUDE.md', 'AGENTS.md'])
           require('fs').appendFileSync(f, 'symbols: 13349')
       const ok = { first: true, repair: a.includes('--repair-fts'), force: a.includes('--force') }
       process.exit(ok[process.env.STUB_OK] ? 0 : 1)`,
    )
    git('add', '-A')
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'base',
    )
    // python is stubbed out: only the analyze step is under test.
    execFileSync(
      findBash(),
      ['-c', 'python() { :; }; export -f python; bash tools/scripts/gitnexus-refresh.sh'],
      {
        cwd: dir,
        stdio: 'pipe',
        env: { ...process.env, STUB_OK: mode },
      },
    )
    return git('status', '--porcelain').toString()
  } finally {
    // git's object files are read-only, which Windows rmSync refuses.
    makeWritable(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const real = fs.readFileSync(script, 'utf8')
const CALLS: [Mode, string][] = [
  ['first', 'analyze --skip-agents-md "$@"'],
  ['repair', 'analyze --skip-agents-md --repair-fts'],
  ['force', 'analyze --skip-agents-md --force'],
]

describe('gitnexus-refresh.sh leaves the context files alone', () => {
  it.each(MODES)('keeps git status clean when %s succeeds', mode => {
    expect(runRefresh(real, mode)).toBe('')
  })

  // Each mutant strips the flag from ONE call and runs the path that reaches it.
  it.each(CALLS)('goes red when the flag is removed from the %s call', (mode, call) => {
    expect(real).toContain(call)
    expect(runRefresh(real.replace(call, call.replace(' --skip-agents-md', '')), mode)).toContain(
      'CLAUDE.md',
    )
  })

  // A bare `gitnexus analyze` (which CLAUDE.md tells agents to run) reads this.
  it('.gitnexusrc sets skipAgentsMd', () => {
    const rc = JSON.parse(fs.readFileSync(path.join(repoRoot, '.gitnexusrc'), 'utf8'))
    expect(rc.skipAgentsMd).toBe(true)
  })
})
