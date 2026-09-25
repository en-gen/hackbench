/**
 * buildLevelExitGraph must be able to reach every real map.
 *
 * It sourced its destination set from classifyLevels().subarea, which carries
 * two defects MapTree.ts already documents and routes around:
 *
 *  - classifyLevels dedupes by L1 pointer, so a slot sharing a pointer with an
 *    earlier slot is in neither returned list. Sharing L1 data is a space
 *    optimisation, not identity: the secondary-exit table names a SLOT. On
 *    vanilla, $0EB's pointer is shared by $0F0, $0FB, $1DA, $1E7 and $1F9, and
 *    the four later ones were discarded.
 *  - it gates on levelHasObjects(), the defect in issue #311, which rejects 24
 *    real rooms.
 *
 * Together those made 47 real maps ineligible as a destination, so no entry
 * map's chain could ever reach them.
 *
 * Measured on the vanilla cart before the fix: 235 real maps, 188 classified,
 * 59 orphans (neither an entry map nor reachable from one).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const VANILLA_ROM = romPath(VANILLA)

const hex = (n: number) => '$' + n.toString(16).toUpperCase().padStart(3, '0')

describe.skipIf(!hasRom(VANILLA))('exit graph reachability', () => {
  // Built in beforeAll, not in the describe body: describe.skipIf still runs
  // the body at collection time, so opening the ROM there crashes CI, which has
  // no ROM. The suite must skip, not explode.
  let rom: SmwRom
  let graph: Map<number, number[]>
  let entryMaps: Set<number>
  let parents: Map<number, number[]>
  let realMaps: number[]
  let orphans: number[]

  beforeAll(() => {
    rom = SmwRom.open(VANILLA_ROM)
    const entranceIndex = deriveOverworldEntrances(rom)
    graph = rom.buildLevelExitGraph(entranceIndex.levelBounds).graph
    const catalog = buildLevelCatalog(rom)
    entryMaps = new Set(entranceIndex.entryMaps)

    parents = new Map<number, number[]>()
    for (const [src, kids] of graph)
      for (const k of kids) {
        if (!parents.has(k)) parents.set(k, [])
        parents.get(k)!.push(src)
      }

    realMaps = catalog.entries.filter(e => e.isReal).map(e => e.index)
    orphans = realMaps.filter(i => !entryMaps.has(i) && !parents.get(i)?.length)
  })

  it('reaches the slots that share an L1 pointer with an earlier slot', () => {
    // $1E7 holds a goal tape with extra bits 1 and shares $0EB's L1 pointer.
    // The dedupe discarded it, so nothing could reach it.
    for (const slot of [0x1e7, 0x0f0, 0x0fb, 0x1da, 0x1f9]) {
      expect(parents.get(slot)?.length ?? 0, `${hex(slot)} should be reachable`).toBeGreaterThan(0)
    }
  })

  it('leaves only maps that nothing reaches by a screen exit, by design', () => {
    // 59 before the destination-set fix, 26 after. Pinned to the measured
    // value, not a loose bound: a regression must fail here.
    expect(orphans.length).toBe(26)

    // The 26 are NOT damage. 24 are entered by game mode or a special flag,
    // which a screen-exit graph cannot model and should not pretend to.
    // Identified from the sprite pointer table's own labels (Ptrs05EC00,
    // bank_05.asm, where index i sits at line 8709 + i).
    const CREDITS = [
      // Koopaling/Bowser credits scenes, loaded by
      0x093, 0x094, 0x095, 0x096, 0x097, 0x098, 0x099, 0x09a, 0x09b, 0x193, 0x194, 0x195, 0x196,
      0x197, 0x198, 0x199, 0x19a, 0x19b,
    ] // game mode $23, GM23PrepEnemyList
    // (bank_00.asm:2508), indexed by
    // CreditsScreenNumber.
    const BONUS_GAME = [0x000, 0x100] // BonusGameActivate, bank_00.asm:8540
    const INTRO_TITLE = [0x0c5, 0x0c7] // IntroSprites0C5, TitleScrSprites0C7
    const YOSHI_WINGS = [0x0c8, 0x1c8] // YoshiHeavenFlag, bank_00.asm:5009
    const BY_DESIGN = [...CREDITS, ...BONUS_GAME, ...INTRO_TITLE, ...YOSHI_WINGS]

    // Exactly two are genuinely unreferenced: an unused test level, and a third
    // copy of DP1's data that no launch tile starts.
    const TRUE_ORPHANS = [
      0x016, // DP1Sprites015, third copy, no launch tile
      0x108, // TestLevelSprites, unused
    ]

    expect([...orphans].sort((a, b) => a - b)).toEqual(
      [...BY_DESIGN, ...TRUE_ORPHANS].sort((a, b) => a - b),
    )
  })

  it('still produces a connected graph rather than an empty one', () => {
    // Guards against a "fix" that widens destinations by disabling the filter.
    expect(graph.size).toBeGreaterThan(50)
    expect(realMaps.length).toBe(235)
    expect(rom.buildLevelExitGraph(deriveOverworldEntrances(rom).levelBounds).graph.size).toBe(
      graph.size,
    )
  })

  it('sees the Front Door and Back Door converge', () => {
    // $10D (Front Door) and $10E (Back Door) meet at $1C7. $1C7 was orphaned
    // before the destination-set fix, so a measurement taken then reported no
    // convergence anywhere in the cart. This pins the case that proved it wrong.
    const reach = (root: number) => {
      const seen = new Set<number>()
      const stack = [root]
      while (stack.length) {
        const n = stack.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        for (const c of graph.get(n) ?? []) stack.push(c)
      }
      seen.delete(root)
      return seen
    }
    const front = reach(0x10d)
    const back = reach(0x10e)
    expect([...front].filter(x => back.has(x))).toEqual([0x1c7])

    // Exactly two entry-map pairs in the cart share any sub area. $015/$017
    // share theirs only because they share an L1 pointer, so it is the same
    // level twice; $10D/$10E is a genuine convergence of two distinct levels.
    const owners = new Map<number, number[]>()
    for (const root of entryMaps)
      for (const m of reach(root)) {
        if (!owners.has(m)) owners.set(m, [])
        owners.get(m)!.push(root)
      }
    const groups = new Set<string>()
    for (const [, roots] of owners) {
      if (roots.length > 1)
        groups.add(
          roots
            .sort((a, b) => a - b)
            .map(hex)
            .join(' '),
        )
    }
    expect([...groups].sort()).toEqual([
      hex(0x015) + ' ' + hex(0x017),
      hex(0x10d) + ' ' + hex(0x10e),
    ])
  })

  it('does not invent destinations that are filler or out of range', () => {
    const realSet = new Set(realMaps)
    const bad: string[] = []
    for (const [src, kids] of graph)
      for (const k of kids) {
        if (k < 0 || k >= LEVEL_COUNT) bad.push(`${hex(src)} -> ${hex(k)} out of range`)
        else if (!realSet.has(k)) bad.push(`${hex(src)} -> ${hex(k)} is filler`)
      }
    expect(bad).toEqual([])
  })
})
