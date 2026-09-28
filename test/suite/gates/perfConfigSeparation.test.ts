/**
 * Proof that `npm run test:unit` never runs benchmarks (issue #413's
 * acceptance list), and that vitest.perf.config.ts stays the mirror image:
 * neither command's include list can match the other's files. A test that
 * only asserted "the perf config exists" could not go red if someone
 * widened test:unit's include glob to swallow test/perf, so this reads the
 * actual include arrays and checks them against real relative paths.
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

describe('vitest.config.ts and vitest.perf.config.ts do not overlap', () => {
  const unitConfig = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8')
  const perfConfig = fs.readFileSync(path.join(repoRoot, 'vitest.perf.config.ts'), 'utf8')
  const unitInclude = includeArrayFrom(unitConfig)
  const perfInclude = includeArrayFrom(perfConfig)

  it('test:unit never mentions test/perf', () => {
    for (const glob of unitInclude) expect(glob).not.toContain('test/perf')
  })

  it('the perf config never mentions test/suite', () => {
    for (const glob of perfInclude) expect(glob).not.toContain('test/suite')
  })

  it('the perf config only matches .bench.ts files', () => {
    for (const glob of perfInclude) expect(glob).toContain('.bench.ts')
  })

  it('binds the gate to the real script: test:unit runs plain vitest, not the perf config', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.scripts['test:unit']).toBe('vitest run')
    expect(pkg.scripts['test:unit']).not.toContain('perf')
  })

  it('a bench file actually exists where the perf config looks', () => {
    const benchDir = path.join(repoRoot, 'test', 'perf', 'core')
    const benchFiles = fs.readdirSync(benchDir).filter(f => f.endsWith('.bench.ts'))
    expect(benchFiles.length).toBeGreaterThan(0)
  })
})
