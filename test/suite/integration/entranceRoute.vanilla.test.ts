/**
 * #945 / #935: which of the 512 slots change entrance when a sub area takes the entrance on the
 * normal route (D66 call 1) instead of the lowest secondary id. Vanilla ROM only; skipped without it.
 * The expected list holds slot ids and entrance ids, no ROM bytes. Evidence scope: the exit graph
 * of the vanilla cart on one machine.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import { readMapEntrances } from '../../../src/rom/ReadMapEntrances'
import { chooseEntrance } from '../../../src/rom/L3Loader'
import { VANILLA, hasRom, romPath } from '../support/corpus'

type Change = [slot: number, was: number | null, now: number | null]

/** The rule #909 and #916 shipped, kept here as the reference the sweep compares against. */
const lowestId = (via?: MapEntrances): number | null =>
  !via || via.overworld || via.primary || via.secondary.length === 0 ? null : Math.min(...via.secondary) // prettier-ignore

/** Every slot where `choose` differs from the lowest-id rule. */
function changedSlots(
  entrances: ReadonlyMap<number, MapEntrances>,
  choose: (via?: MapEntrances) => number | null,
): Change[] {
  const out: Change[] = []
  for (let slot = 0; slot < 0x200; slot++) {
    const via = entrances.get(slot)
    const was = lowestId(via)
    const now = choose(via)
    if (was !== now) out.push([slot, was, now])
  }
  return out
}

const EXPECTED: Change[] = []

describe.skipIf(!hasRom(VANILLA))('route entrance over the 512 vanilla slots (#945)', () => {
  let entrances: ReadonlyMap<number, MapEntrances>
  beforeAll(() => {
    entrances = readMapEntrances(SmwRom.open(romPath(VANILLA)))!
  })

  it('reads the exit graph: 28 slots have secondary entrances and every one is an entry map', () => {
    const withSecondary = [...entrances].filter(([, v]) => v.secondary.length > 0)
    expect(withSecondary).toHaveLength(28)
    expect(withSecondary.every(([, v]) => v.overworld && v.route === null)).toBe(true)
    // So no vanilla slot is a sub area entered only by secondary entrances: nothing to re-route.
  })

  it('changes exactly the committed list of slots (0 of 512)', () => {
    expect(changedSlots(entrances, chooseEntrance)).toEqual(EXPECTED)
  })

  // The committed list is empty, so "a list with a slot removed" cannot plant; a chooser that
  // ignores the overworld entry does, and must list every one of the 28 entry maps.
  it('can fail: a chooser that skips the overworld rule is red against the list', () => {
    const wrong = (via?: MapEntrances) => via?.secondary[0] ?? null
    const changed = changedSlots(entrances, wrong)
    expect(changed).toHaveLength(28)
    expect(changed).not.toEqual(EXPECTED)
  })
})
