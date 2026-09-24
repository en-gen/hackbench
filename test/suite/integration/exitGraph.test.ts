/**
 * buildLevelExitGraph -- acceptance checks against the real ROM corpus.
 *
 * These pin down the six numbered acceptance criteria from issue #308/#309
 * against actual ROM data, since the synthetic tests in SmwRom.classify.test.ts
 * can't prove the fix holds on real pointer tables and real DATA_05F800 content.
 *
 * Thresholds below are pinned to values measured on the vanilla ROM, not
 * loose bounds: a regression that halves the graph must fail these tests.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, isOverworldLevel } from '../../../src/rom/SmwRom'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { CORPUS, VANILLA, hasRom, romPath } from '../support/corpus'

// Same resolution as exitGraphReach.test.ts, so this does not skip in a worktree.
const VANILLA_ROM = romPath(VANILLA)

// The six-ROM corpus (outside the repo, see support/corpus.ts). One case per ROM, so an absent
// ROM skips rather than vanishing (CLAUDE.md, Quality gates).

describe.skipIf(!hasRom(VANILLA))('buildLevelExitGraph -- vanilla acceptance', () => {
  let rom: SmwRom
  let graph: Map<number, number[]>

  beforeAll(() => {
    rom = SmwRom.open(VANILLA_ROM)
    graph = rom.buildLevelExitGraph().graph
  })

  it('$113 resolves to $1BB, not the $0BB filler', () => {
    expect(graph.get(0x113)).toEqual([0x1bb])
  })

  it('submap-range sources ($1xx) only ever resolve to submap ($1xx) destinations', () => {
    for (const [src, dests] of graph) {
      if (src < 0x100) continue
      for (const d of dests) expect(d).toBeGreaterThanOrEqual(0x100)
    }
  })

  // The counts below are pinned to values measured against the vanilla ROM,
  // not to an independently derived expectation. A diff that moves them is not
  // automatically wrong, but it must be explained.
  //
  // The universe is every slot whose L1 pointer is not the filler, taken from
  // buildLevelCatalog. It is deliberately NOT classifyLevels().subarea: that
  // dedupes by L1 pointer and gates on levelHasObjects() (#311), and a
  // destination is a SLOT, not a pointer. CODE_05D8B7 indexes Layer1Ptrs,
  // Layer2Ptrs and Ptrs05EC00 all by the same level number
  // (SMWDisX bank_05.asm:7227-7255), so two slots sharing L1 data are still
  // two maps.
  let subareas: number[]
  let reached: Set<number>

  beforeAll(() => {
    subareas = buildLevelCatalog(rom)
      .entries.filter(e => e.isReal && !isOverworldLevel(e.index))
      .map(e => e.index)
    reached = new Set([...graph.values()].flat())
  })

  it('sub-areas above $136 are reached: 68 of the 78 that exist', () => {
    const above136 = subareas.filter(i => i > 0x136)
    expect(above136).toHaveLength(78)
    // Pinned by slot, not count: an unchanged total can hide one sub-area
    // dropping out while another appears. $193-$19B are the credits enemy
    // scenes (game mode $23, SMWDisX bank_00.asm:2508) and $1C8 is Yoshi Wings
    // (bank_00.asm:5009), entered by game mode or flag rather than a screen
    // exit; exitGraphReach.test.ts traces each one.
    const unreached = above136.filter(i => !reached.has(i))
    expect(unreached).toEqual([
      0x193, 0x194, 0x195, 0x196, 0x197, 0x198, 0x199, 0x19a, 0x19b, 0x1c8,
    ])
  })

  it('sub-areas attached to overworld roots: 132 of 155', () => {
    expect(subareas).toHaveLength(155)
    // Every destination is a real sub-area, so the reached set is a subset of
    // the universe; the 23 left over are a subset of exitGraphReach's orphans.
    expect([...reached].filter(i => !subareas.includes(i))).toEqual([])
    expect(reached.size).toBe(132)
  })

  it('holds 178 edges', () => {
    // Reachability, loop and shape pins miss an edge whose loss changes none
    // of them, such as $016 -> $0FD or $11D -> $1E7. The total catches those.
    expect([...graph.values()].flat()).toHaveLength(178)
  })
})

describe('buildLevelExitGraph -- AC2 and AC6 across the full ROM corpus', () => {
  for (const name of CORPUS) {
    it.skipIf(!hasRom(name))(
      `no edge points at the filler L1 pointer, and the graph builds without throwing: ${name}`,
      () => {
        const rom = SmwRom.open(romPath(name))
        let graph: Map<number, number[]> = new Map()
        expect(() => {
          graph = rom.buildLevelExitGraph().graph
        }).not.toThrow()

        // Recompute the filler pointer the same way SmwRom does, to assert no
        // edge in the graph resolves to a level sharing that pointer.
        const counts = new Map<number, number>()
        for (let i = 0; i < 0x200; i++) {
          const ptr = rom.getLevelL1Pointer(i)
          if (!ptr) continue
          counts.set(ptr, (counts.get(ptr) ?? 0) + 1)
        }
        let fillerPtr: number | null = null,
          fillerCount = 0
        for (const [ptr, count] of counts)
          if (count > fillerCount) {
            fillerPtr = ptr
            fillerCount = count
          }
        if (fillerCount < 10) fillerPtr = null

        for (const [, dests] of graph) {
          for (const d of dests) {
            expect(rom.getLevelL1Pointer(d)).not.toBe(fillerPtr)
            // Every destination must be a genuine sub-area, never an overworld node.
            expect(isOverworldLevel(d)).toBe(false)
          }
        }
      },
    )
  }
})
