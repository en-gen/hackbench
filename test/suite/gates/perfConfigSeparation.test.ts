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
import * as fs from 'node:fs'
import * as path from 'node:path'

const repoRoot = path.resolve(__dirname, '../../..')

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

describe('the gh guard reaches both configs and the paired base round', () => {
  const globalSetups = (src: string): string[] => {
    const m = src.match(/globalSetup:\s*\[([^\]]*)\]/)
    return m ? Array.from(m[1].matchAll(/'([^']*)'/g)).map(x => x[1]) : []
  }
  const read = (f: string) => fs.readFileSync(path.join(repoRoot, f), 'utf8')
  const guard = 'test/suite/support/noRealGh.ts'

  it('both vitest configs register the guard', () => {
    expect(globalSetups(read('vitest.config.ts'))).toContain(guard)
    expect(globalSetups(read('vitest.perf.config.ts'))).toContain(guard)
  })

  it('every globalSetup the perf config names is a harness path', async () => {
    const { HARNESS_PATHS } = await import('../../../tools/perf/results.mjs')
    const named = globalSetups(read('vitest.perf.config.ts'))
    expect(named.length).toBeGreaterThan(0)
    for (const f of named) expect(HARNESS_PATHS).toContain(f)
  })
})
