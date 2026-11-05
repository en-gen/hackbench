/**
 * #945 / #935: which of the 512 slots change entrance when a sub area takes the entrance on the
 * normal route (D66 call 1) instead of the lowest secondary id. Vanilla ROM only; skipped without it.
 * Plainly: on vanilla the old and new rules agree on every slot, because no non-entry map has a
 * secondary entrance. So the evidence here is the 28-slot pin and the unreached list; the
 * change-comparison plant below only proves the loop can report a difference. The expected list
 * holds slot ids and entrance ids, no ROM bytes. Evidence scope: the exit graph of the vanilla
 * cart on one machine.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import { entrancesOfMap, readMapEntrances } from '../../../src/rom/ReadMapEntrances'
import { readLevelStart } from '../../../src/rom/LevelStart'
import { chooseEntrance, chooseEntranceNoted } from '../../../src/rom/L3Loader'
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
    const via = entrancesOfMap(entrances, slot)
    const was = lowestId(via)
    const now = choose(via)
    if (was !== now) out.push([slot, was, now])
  }
  return out
}

const EXPECTED: Change[] = []
// Slots no walk step enters: 301 of 512, most of them unused slots. Slot ids only, no ROM bytes.
const UNREACHED_SLOTS: number[] = [
  0x0, 0x12, 0x19, 0x1e, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30,
  0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40,
  0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f, 0x50,
  0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60,
  0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70,
  0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80,
  0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90,
  0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0,
  0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb0,
  0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xc5, 0xc7, 0xc8, 0x100,
  0x10c, 0x112, 0x124, 0x129, 0x12e, 0x12f, 0x131, 0x133, 0x137, 0x138, 0x139, 0x13a, 0x13b, 0x13c,
  0x13d, 0x13e, 0x13f, 0x140, 0x141, 0x142, 0x143, 0x144, 0x145, 0x146, 0x147, 0x148, 0x149, 0x14a,
  0x14b, 0x14c, 0x14d, 0x14e, 0x14f, 0x150, 0x151, 0x152, 0x153, 0x154, 0x155, 0x156, 0x157, 0x158,
  0x159, 0x15a, 0x15b, 0x15c, 0x15d, 0x15e, 0x15f, 0x160, 0x161, 0x162, 0x163, 0x164, 0x165, 0x166,
  0x167, 0x168, 0x169, 0x16a, 0x16b, 0x16c, 0x16d, 0x16e, 0x16f, 0x170, 0x171, 0x172, 0x173, 0x174,
  0x175, 0x176, 0x177, 0x178, 0x179, 0x17a, 0x17b, 0x17c, 0x17d, 0x17e, 0x17f, 0x180, 0x181, 0x182,
  0x183, 0x184, 0x185, 0x186, 0x187, 0x188, 0x189, 0x18a, 0x18b, 0x18c, 0x18d, 0x18e, 0x18f, 0x190,
  0x191, 0x192, 0x193, 0x194, 0x195, 0x196, 0x197, 0x198, 0x199, 0x19a, 0x19b, 0x19c, 0x19d, 0x19e,
  0x19f, 0x1a0, 0x1a1, 0x1a2, 0x1a3, 0x1a4, 0x1a5, 0x1a6, 0x1a7, 0x1a8, 0x1a9, 0x1aa, 0x1ab, 0x1ac,
  0x1ad, 0x1ae, 0x1af, 0x1b0, 0x1b1, 0x1b2, 0x1b3, 0x1b4, 0x1b5, 0x1b6, 0x1b7, 0x1b8, 0x1b9, 0x1ba,
  0x1c8,
]

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

  it('the unreachable-sub-area note fires on exactly the committed slots', () => {
    const noted: number[] = []
    for (let slot = 0; slot < 0x200; slot++) {
      if (chooseEntranceNoted(entrancesOfMap(entrances, slot)).note) noted.push(slot)
    }
    expect(noted).toEqual(UNREACHED_SLOTS)
  })

  // Two-way: the slots carrying the note are exactly the slots readLevelStart refuses a start for.
  // Evidence scope: all 512 vanilla slots, one machine. The note and the refusal come from
  // independent code (the exit graph's route record vs the level-start walk), so a slot on one
  // side only is a real disagreement. The 301 is asserted, so an empty sweep cannot pass.
  it('the no-route note and a refused level start agree on all 512 slots (301 unreached)', () => {
    const rom = SmwRom.open(romPath(VANILLA))
    const noted = new Set<number>()
    const refused = new Set<number>()
    for (let slot = 0; slot < 0x200; slot++) {
      if (chooseEntranceNoted(entrancesOfMap(entrances, slot)).note) noted.add(slot)
      if (!readLevelStart(rom, slot).ok) refused.add(slot)
    }
    expect(noted.size).toBe(301)
    expect([...noted].sort((a, b) => a - b)).toEqual([...refused].sort((a, b) => a - b))
  }, 120_000)

  // The committed list is empty, so "a list with a slot removed" cannot plant; a chooser that
  // ignores the overworld entry does, and must list every one of the 28 entry maps.
  it('can fail: a chooser that skips the overworld rule is red against the list', () => {
    const wrong = (via?: MapEntrances) => via?.secondary[0] ?? null
    const changed = changedSlots(entrances, wrong)
    expect(changed).toHaveLength(28)
    expect(changed).not.toEqual(EXPECTED)
  })
})
