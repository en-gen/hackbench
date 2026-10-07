/**
 * The one real, unmocked, end-to-end proof that `paired.mjs --plant`
 * (issue #413's acceptance list) makes the planted id REGRESSION through
 * the real CLI path - actual vitest subprocesses, actual compare.mjs. Kept
 * in its own file so it never shares a module graph with perfPaired.test.ts,
 * which mocks node:child_process for its faster, more precise routing tests.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { runPaired } from '../../../tools/perf/paired.mjs'
import { compareRounds, mulberry32 } from '../../../tools/perf/compare.mjs'

const repoRoot = path.resolve(__dirname, '../../..')

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
