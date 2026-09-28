/**
 * Proof that the paired runner (tools/perf/paired.mjs, design section 3) can
 * fail end to end: `--plant <id>=<factor>` on the core suite makes that id
 * REGRESSION through the real CLI path (issue #413's acceptance list), not
 * through a stub. The core suite hook actually shells into this checkout's
 * own tools/perf/run-core.mjs, so this is the same command the nightly
 * workflow and a local bisect run.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import { parseArgs, SUITE_HOOKS, runPaired } from '../../../tools/perf/paired.mjs'
import { compareRounds, mulberry32 } from '../../../tools/perf/compare.mjs'

const repoRoot = path.resolve(__dirname, '../../..')

describe('paired.mjs argument parsing and suite hooks', () => {
  it('parses every flag', () => {
    const args = parseArgs([
      '--base',
      'b',
      '--cand',
      'c',
      '--suite',
      'core',
      '--rounds',
      '5',
      '--only',
      'a,b',
      '--plant',
      'a=1.5',
      '--out',
      'o.json',
    ])
    expect(args).toEqual({
      base: 'b',
      cand: 'c',
      suite: 'core',
      rounds: 5,
      only: 'a,b',
      plant: 'a=1.5',
      out: 'o.json',
    })
  })

  it('the core hook shells into run-core.mjs inside the given dir', () => {
    const { cmd, args, cwd } = SUITE_HOOKS.core('/some/dir', {
      out: 'out.json',
      only: 'a,b',
      plant: 'a=1.3',
    })
    expect(cwd).toBe('/some/dir')
    expect(cmd).toBe(process.execPath)
    expect(args).toContain('tools/perf/run-core.mjs')
    expect(args).toContain('--only')
    expect(args).toContain('a,b')
    expect(args).toContain('--plant')
    expect(args).toContain('a=1.3')
  })

  it('the app hook is a named stub, not silently missing', () => {
    expect(() => SUITE_HOOKS.app('/dir', {})).toThrow(/PR 2/)
  })
})

describe('paired.mjs end to end: --plant makes that id REGRESSION', () => {
  it('a planted 2x slowdown on core.lclz2.decompress.synthetic-64k regresses only that id', async () => {
    // A large factor (2x, versus the 10% core threshold) so this end-to-end
    // wall-clock measurement stays decisive even under full-suite CPU
    // contention, which the lint gate's own CLI_TIMEOUT_MS comment notes
    // affects timing-sensitive tests running alongside ~300 other files.
    const id = 'core.lclz2.decompress.synthetic-64k'
    const doc = runPaired({
      base: repoRoot,
      cand: repoRoot,
      suite: 'core',
      rounds: 5,
      only: id,
      plant: `${id}=2.0`,
    })
    const verdicts = compareRounds(doc.baseRounds, doc.candRounds, {
      rng: mulberry32(1),
      resamples: 500,
    })
    const v = verdicts.find(x => x.id === id)
    expect(v?.verdict).toBe('regression')
  }, 120000)
})

describe('bisect.mjs step script', () => {
  it('names the given id and good directory', async () => {
    const { stepScriptSource } = await import('../../../tools/perf/bisect.mjs')
    const src = stepScriptSource({
      repoRoot,
      goodDir: '/tmp/good',
      id: 'core.x.y',
      rounds: undefined,
    })
    expect(src).toContain('\'--only\', "core.x.y"')
    expect(src).toContain('/tmp/good')
    expect(src).toContain('paired.mjs')
    expect(src).toContain('compare.mjs')
  })

  it('parses its own CLI flags', async () => {
    const { parseArgs: parseBisectArgs } = await import('../../../tools/perf/bisect.mjs')
    const args = parseBisectArgs([
      '--id',
      'core.x.y',
      '--good',
      'abc',
      '--bad',
      'def',
      '--dir',
      os.tmpdir(),
    ])
    expect(args).toEqual({ id: 'core.x.y', good: 'abc', bad: 'def', dir: os.tmpdir() })
  })
})
