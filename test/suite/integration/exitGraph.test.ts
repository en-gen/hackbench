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
import { existsSync } from 'fs'
import * as path from 'path'
import { SmwRom, isOverworldLevel } from '../../../src/rom/SmwRom'

const ROM_DIR = path.resolve(__dirname, '../../roms')
const VANILLA = path.join(ROM_DIR, 'Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(VANILLA)

// All ROMs in the six-ROM corpus (test/roms/, gitignored). Only the ones
// actually present on disk are exercised.
const CORPUS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
].map(name => path.join(ROM_DIR, name)).filter(existsSync)

// CORPUS is empty in CI, where test/roms/ is absent (gitignored, and the ROMs
// are copyrighted). An it.each over an empty array leaves its describe block
// with no tests at all, which vitest treats as a suite-level failure, so the
// block needs its own skip guard rather than relying on the it.each.
const corpusPresent = CORPUS.length > 0

describe.skipIf(!romPresent)('buildLevelExitGraph -- vanilla acceptance', () => {
  let rom: SmwRom
  let graph: Map<number, number[]>

  beforeAll(() => {
    rom = SmwRom.open(VANILLA)
    graph = rom.buildLevelExitGraph()
  })

  it('$113 resolves to $1BB, not the $0BB filler', () => {
    expect(graph.get(0x113)).toEqual([0x1BB])
  })

  it('submap-range sources ($1xx) only ever resolve to submap ($1xx) destinations', () => {
    for (const [src, dests] of graph) {
      if (src < 0x100) continue
      for (const d of dests) expect(d).toBeGreaterThanOrEqual(0x100)
    }
  })

  // The two counts below are pinned to values measured against the vanilla
  // ROM at the commit that introduced them, not to an independently derived
  // expectation. They exist to make any change in reachability visible and
  // deliberate: a diff that moves them is not automatically wrong, but it
  // must be explained. Re-derive by running rom.classifyLevels() and
  // buildLevelExitGraph() against the vanilla ROM and comparing the sets,
  // not just the totals -- an unchanged total can still hide one sub-area
  // dropping out while another appears.
  it('sub-areas above $136 are reached: 55 of the 56 that exist', () => {
    const { subarea } = rom.classifyLevels()
    const above136 = subarea.filter(i => i > 0x136)
    expect(above136).toHaveLength(56)

    const reachedAbove136 = new Set<number>()
    for (const [, dests] of graph) for (const d of dests) if (d > 0x136) reachedAbove136.add(d)
    expect(reachedAbove136.size).toBe(55)
  })

  it('sub-areas attached to overworld roots: 99 of 109', () => {
    const { subarea } = rom.classifyLevels()
    const reached = new Set<number>()
    for (const [, dests] of graph) for (const d of dests) reached.add(d)
    expect(subarea).toHaveLength(109)
    expect(reached.size).toBe(99)
  })
})

describe.skipIf(!corpusPresent)('buildLevelExitGraph -- AC2 and AC6 across the full ROM corpus', () => {
  it.each(CORPUS)('no edge points at the filler L1 pointer, and the graph builds without throwing: %s', (romPath) => {
    const rom = SmwRom.open(romPath)
    let graph: Map<number, number[]> = new Map()
    expect(() => { graph = rom.buildLevelExitGraph() }).not.toThrow()

    // Recompute the filler pointer the same way SmwRom does, to assert no
    // edge in the graph resolves to a level sharing that pointer.
    const counts = new Map<number, number>()
    for (let i = 0; i < 0x200; i++) {
      const ptr = rom.getLevelL1Pointer(i)
      if (!ptr) continue
      counts.set(ptr, (counts.get(ptr) ?? 0) + 1)
    }
    let fillerPtr: number | null = null, fillerCount = 0
    for (const [ptr, count] of counts) if (count > fillerCount) { fillerPtr = ptr; fillerCount = count }
    if (fillerCount < 10) fillerPtr = null

    for (const [, dests] of graph) {
      for (const d of dests) {
        expect(rom.getLevelL1Pointer(d)).not.toBe(fillerPtr)
        // Every destination must be a genuine sub-area, never an overworld node.
        expect(isOverworldLevel(d)).toBe(false)
      }
    }
  })
})
