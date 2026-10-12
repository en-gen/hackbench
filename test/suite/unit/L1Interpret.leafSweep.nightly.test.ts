/**
 * Stage A of #653, the corpus half: the per-ROM leaf table over every hack.
 * Runs through `npm run test:corpus` (vitest.corpus.config.ts), not `test:unit`:
 * the sweep takes about ten minutes. The synthetic grouping tests stay in
 * L1Interpret.leafSweep.corpus.test.ts and run in `test:unit`.
 */
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasRom, freshRom, VANILLA, CORPUS } from '../support/corpus'
import { sweep, type DiffRun } from '../support/l1Differential'
import {
  groupLeaves,
  agreeingStandardLeaves,
  formatTable,
  formatHeader,
} from '../support/leafGrouping'

// Report only (#653): the hacks assert nothing, the table is the product. The leaf set is
// vanilla's, so every case needs the vanilla ROM too.
let vanillaRuns: DiffRun[] | undefined
const vanillaLeaves = () => agreeingStandardLeaves((vanillaRuns ??= sweep(freshRom(VANILLA))))

for (const name of CORPUS) {
  describe.skipIf(!hasRom(name) || !hasRom(VANILLA))(`${name}: agreeing leaves (#653)`, () => {
    it('tabulates the vanilla-agreeing leaves', () => {
      const leaves = vanillaLeaves()
      if (name === VANILLA) {
        expect(leaves.length).toBe(61)
        // Pins the set, not only its size: SHA-256 of the decimal leaf addresses joined by commas (code addresses, not ROM bytes).
        expect(createHash('sha256').update(leaves.join(',')).digest('hex')).toBe(
          '891bdcf1f77729c5e10ee39c389f5083f0f7e98579da6f46d5f3fd6f6f717f79',
        )
      }
      const runs = name === VANILLA ? vanillaRuns! : sweep(freshRom(name))
      const g = groupLeaves(runs)
      const table = `${formatHeader(g, leaves)}\n${formatTable(g, leaves)}`
      console.log(`${name}\n${table}`)
      const dir = process.env.LEAF_SWEEP_OUT
      if (dir) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${name}.tsv`), table)
      }
    }, 600_000)
  })
}
