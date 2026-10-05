/**
 * SingleStepTests/65816 against Cpu65816, one `it` per opcode file
 * ({op}.{n|e}.json, 10,000 cases each). The data is not in the repo (license
 * unverified): set HACKBENCH_SINGLESTEP to its `v1` directory, or clone to
 * <hackbench-tools>/singlestep65816. Without it every case skips.
 * Scope: registers, flags, memory. Cycle and bus timing are out of scope.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { TOOLS_ROOT } from '../../support/corpus'
import { runCase, type StepCase } from '../../support/singleStep'

const base = process.env.HACKBENCH_SINGLESTEP ?? join(TOOLS_ROOT, 'singlestep65816')
const root = existsSync(join(base, 'v1')) ? join(base, 'v1') : base
const hex = (n: number) => n.toString(16).padStart(2, '0')

describe.skipIf(!existsSync(root))('SingleStepTests 65816', () => {
  for (let op = 0; op < 256; op++) {
    for (const mode of ['n', 'e']) {
      const file = join(root, `${hex(op)}.${mode}.json`)
      it.skipIf(!existsSync(file))(`${hex(op)}.${mode}`, { timeout: 120_000 }, () => {
        const cases = JSON.parse(readFileSync(file, 'utf8')) as StepCase[]
        expect(cases.length).toBe(10000)
        let failed = 0
        const first: string[] = []
        for (const tc of cases) {
          let diff: string[]
          try {
            diff = runCase(tc)
          } catch (e) {
            diff = [String(e)]
          }
          if (diff.length) {
            failed++
            if (first.length < 3) first.push(`${tc.name}: ${diff.join('; ')}`)
          }
        }
        expect(failed, first.join('\n')).toBe(0)
      })
    }
  }
})
