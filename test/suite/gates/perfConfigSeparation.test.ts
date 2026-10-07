/**
 * Proof that `npm run test:unit` never runs benchmarks (issue #413's
 * acceptance list), and that vitest.perf.config.ts stays the mirror image.
 * A test that only asserted "the include glob contains the substring
 * test/perf" could not go red if someone widened test:unit's glob to
 * `test/**\/*.ts` - that string still would not contain "test/perf" while
 * matching every bench file anyway. This instead matches the REAL bench and
 * suite files on disk against each config's include globs with a small glob
 * matcher, so a widened glob is caught by what it would actually pick up.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')

// Tracked files only: untracked nested worktrees under .claude/ hold configs at
// arbitrary commits and must not decide this repo's verdict.
export function trackedConfigs(cwd: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', timeout: 20000 })
  return out.split(/\r?\n/).filter(f => /(^|\/)vitest(\..+)?\.config\.[mc]?[jt]s$/.test(f))
}

function includeArrayFrom(configSource: string): string[] {
  const match = configSource.match(/include:\s*\[([^\]]*)\]/)
  if (!match) throw new Error('no include array found in config source')
  return Array.from(match[1].matchAll(/'([^']*)'/g)).map(m => m[1])
}

/** Minimal glob matcher for the patterns these two configs actually use:
 *  literal segments, `*` within a segment, `**` across segments. Not a
 *  general-purpose implementation - just enough to hold this gate to real
 *  glob semantics instead of a substring check. */
function globToRegExp(glob: string): RegExp {
  let re = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?'
        i++
      } else {
        re += '.*'
      }
    } else if (c === '*') {
      re += '[^/]*'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(re + '$')
}

function matchesAny(relPath: string, globs: string[]): boolean {
  return globs.some(g => globToRegExp(g).test(relPath))
}

/** Collects files matching `suffix` under `dir`, skipping `__fixtures__`:
 *  lintGate.test.ts creates and deletes real files there mid-run, and with
 *  fileParallelism this walk can race it. Filtering to the real suffix (not
 *  just skipping that one directory) keeps this robust to any other test's
 *  scratch files too. */
function walk(dir: string, suffix: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__fixtures__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, suffix, out)
    else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(path.relative(repoRoot, full).split(path.sep).join('/'))
    }
  }
}

describe('vitest.config.ts and vitest.perf.config.ts do not overlap', () => {
  const unitConfig = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8')
  const perfConfig = fs.readFileSync(path.join(repoRoot, 'vitest.perf.config.ts'), 'utf8')
  const unitInclude = includeArrayFrom(unitConfig)
  const perfInclude = includeArrayFrom(perfConfig)

  const benchFiles: string[] = []
  walk(path.join(repoRoot, 'test', 'perf', 'core'), '.bench.ts', benchFiles)
  expect(benchFiles.length).toBeGreaterThan(0) // the gate below is meaningless over an empty list

  const suiteFiles: string[] = []
  walk(path.join(repoRoot, 'test', 'suite', 'gates'), '.test.ts', suiteFiles)
  expect(suiteFiles.length).toBeGreaterThan(0)

  it('every real bench file matches the perf config include list', () => {
    for (const f of benchFiles) expect(matchesAny(f, perfInclude)).toBe(true)
  })

  it('no real bench file matches the unit config include list', () => {
    for (const f of benchFiles) expect(matchesAny(f, unitInclude)).toBe(false)
  })

  it('every real gate test file matches the unit config include list', () => {
    for (const f of suiteFiles) expect(matchesAny(f, unitInclude)).toBe(true)
  })

  it('no real gate test file matches the perf config include list', () => {
    for (const f of suiteFiles) expect(matchesAny(f, perfInclude)).toBe(false)
  })

  it('binds the gate to the real script: test:unit runs plain vitest, not the perf config', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts['test:unit']).toBe('vitest run')
    expect(pkg.scripts['test:unit']).not.toContain('perf')
  })
})

describe('timing gates run serially, outside test:unit (#668, #537)', () => {
  const read = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8')
  const timingInclude = includeArrayFrom(read('vitest.timing.config.ts'))
  const suiteTests: string[] = []
  walk(path.join(repoRoot, 'test', 'suite'), '.test.ts', suiteTests)
  const timingFiles = suiteTests.filter(f => f.endsWith('.timing.test.ts')).sort()

  it('the default config excludes **/*.timing.test.ts under test.exclude', async () => {
    const { default: cfg } = await import('../../../vitest.config')
    expect(cfg.test?.exclude).toContain('**/*.timing.test.ts')
  })

  it('the timing include matches exactly the two timing files, of every suite test', () => {
    const matched = suiteTests.filter(f => matchesAny(f, timingInclude)).sort()
    expect(matched).toEqual([
      'test/suite/gates/perfPairedE2E.timing.test.ts',
      'test/suite/gates/perfSampler.timing.test.ts',
    ])
    expect(timingFiles).toEqual(matched)
  })

  it('the timing config is serial and test:timing runs it', async () => {
    const { default: cfg } = await import('../../../vitest.timing.config')
    expect(cfg.test?.fileParallelism).toBe(false)
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.scripts['test:timing']).toBe('vitest run --config vitest.timing.config.ts')
  })

  it('CI runs test:timing inside the unit job', () => {
    const ci = read('.github/workflows/ci.yml')
    const job = ci.match(/\n {2}unit:\r?\n([\s\S]*?)(?=\r?\n {2}[\w-]+:\r?\n|$)/)
    expect(job).not.toBeNull()
    expect(job![1]).toMatch(/run:\s*npm run test:timing\s*$/m)
  })
})

describe('the gh guard reaches both configs and the paired base round', () => {
  const globalSetups = (src: string): string[] => {
    const m = src.match(/globalSetup:\s*\[([^\]]*)\]/)
    return m ? Array.from(m[1].matchAll(/'([^']*)'/g)).map(x => x[1]) : []
  }
  const read = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8')
  const guard = 'test/suite/support/noRealGh.ts'

  it('every vitest config in the repo registers the guard', () => {
    const found = trackedConfigs(repoRoot)
    expect(found.length).toBeGreaterThanOrEqual(3)
    for (const f of found) expect(globalSetups(read(f)), f).toContain(guard)
  })

  it('every globalSetup the perf config names is a harness path', async () => {
    const { HARNESS_PATHS } = await import('../../../tools/perf/results.mjs')
    const named = globalSetups(read('vitest.perf.config.ts'))
    expect(named.length).toBeGreaterThan(0)
    for (const f of named) expect(HARNESS_PATHS).toContain(f)
  })
})

describe('trackedConfigs', () => {
  it('ignores an untracked nested directory holding an unguarded config', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ls-'))
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' })
      git('init', '-q')
      fs.writeFileSync(path.join(d, 'vitest.config.ts'), '')
      fs.mkdirSync(path.join(d, '.claude/worktrees/x'), { recursive: true })
      fs.writeFileSync(path.join(d, '.claude/worktrees/x/vitest.config.ts'), '')
      git('add', 'vitest.config.ts')
      expect(trackedConfigs(d)).toEqual(['vitest.config.ts'])
    } finally {
      fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
