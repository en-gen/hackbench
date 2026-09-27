/**
 * Differential: the L1 handler interpreter against the hand ports, on vanilla
 * (en-gen/hackbench#664). Every standard object x size x tileset dispatcher,
 * and every extended object, at columns 0, 3 and 15 of screen 5, each on a row
 * where it fits (test/suite/support/l1Differential.ts).
 *
 * Every disagreement and refusal must be on the allow-list
 * (test/suite/support/l1AllowList.ts), and every entry must absorb exactly the
 * measured number of cases with the measured output.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { fingerprint } from '../../../src/rom/Fingerprint'
import { EXECUTE_PTR_LONG_SHA256 } from '../../../src/rom/objectHandlers/interpret'
import { hasRom, freshRom, VANILLA } from '../support/corpus'
import {
  sweep,
  caseCount,
  dispatcherTilesets,
  caseName,
  hex6,
  type DiffRun,
} from '../support/l1Differential'
import { tally, KNOWN_DISAGREEMENTS, KNOWN_REFUSALS, type Tally } from '../support/l1AllowList'

/** ExecutePtrLong in the vanilla cart (bank_00.asm:864). */
const EXECUTE_PTR_LONG = 0x0086fa

describe.skipIf(!hasRom(VANILLA))('interpret vs the ports, vanilla (#664)', () => {
  let runs: DiffRun[] = []
  let t: Tally

  beforeAll(() => {
    runs = sweep(freshRom(VANILLA))
    t = tally(runs, caseName)
  }, 600_000)

  it('recognizes ExecutePtrLong on vanilla by its fingerprint', () => {
    expect(fingerprint(freshRom(VANILLA).readAt(EXECUTE_PTR_LONG, 36))).toBe(
      EXECUTE_PTR_LONG_SHA256,
    )
  })

  it('ran every case, and most agree', () => {
    expect(runs.length).toBe(caseCount(dispatcherTilesets(freshRom(VANILLA)).length))
    expect(runs.filter(r => r.differs === false).length / runs.length).toBeGreaterThan(0.9)
  })

  it('has no disagreement outside the allow-list', () => {
    expect(t.unexpected.slice(0, 20)).toEqual([])
  })

  it('has no refusal outside the allow-list', () => {
    expect(t.unexplainedRefusals.slice(0, 20)).toEqual([])
  })

  it('absorbs exactly the measured cases under each disagreement entry', () => {
    const want = KNOWN_DISAGREEMENTS.map(k => ({
      routine: hex6(k.routine),
      why: k.why,
      expect: k.expect,
    }))
    expect(t.disagreements).toEqual(want)
  })

  it('refuses exactly the measured number of cases per handler', () => {
    expect(t.refusals).toEqual(KNOWN_REFUSALS)
  })
})
