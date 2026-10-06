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

function runRefresh(scriptText: string): string {
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
      `if (!process.argv.includes('--skip-agents-md'))
         for (const f of ['CLAUDE.md', 'AGENTS.md'])
           require('fs').appendFileSync(f, 'symbols: 13349')`,
    )
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base')
    // python is stubbed out: only the analyze step is under test.
    execFileSync(
      findBash(),
      ['-c', 'python() { :; }; export -f python; bash tools/scripts/gitnexus-refresh.sh'],
      {
        cwd: dir,
        stdio: 'pipe',
      },
    )
    return git('status', '--porcelain').toString()
  } finally {
    // git's object files are read-only, which Windows rmSync refuses.
    makeWritable(dir)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe('gitnexus-refresh.sh leaves the context files alone', () => {
  it('keeps git status clean', () => {
    expect(runRefresh(fs.readFileSync(script, 'utf8'))).toBe('')
  })

  it('goes red when the flag is removed', () => {
    const unprotected = fs.readFileSync(script, 'utf8').replaceAll('--skip-agents-md ', '')
    expect(runRefresh(unprotected)).toContain('CLAUDE.md')
  })
})
