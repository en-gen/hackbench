/**
 * Grouping every map in a ROM into the tree the explorer renders.
 *
 * The count is the whole point. This repo has produced five different level
 * counts by using "level" loosely, so the binding assertion here is a
 * COVERAGE one: the set of map indices reachable in the tree must equal the
 * set of real slots the catalog found, exactly. A tree that renders a tidy
 * hierarchy while dropping 42 maps passes every shape check.
 *
 * Swept across the whole ROM corpus rather than vanilla alone, because the
 * grouping inputs (overworld roots, the exit graph) degrade differently on
 * edited ROMs and a single-ROM acceptance test would not show it.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { buildMapTree, MapNode, MapTree } from '../../../src/rom/MapTree'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { CORPUS, INVICTUS, VANILLA, freshRom, hasRom, hasRoms } from '../support/corpus'

/**
 * DECLARED, not discovered. This list used to be a `readdirSync` of
 * `test/roms`, which is gitignored: in CI the listing came back empty, so
 * `for (const file of romFiles)` registered ZERO cases. 36 of this file's
 * cases did not skip, they ceased to exist, and neither the pass count nor
 * the skip count said a word. Naming the corpus registers every case on every
 * machine; `skipIf` below is what turns the absent ones into honest skips.
 */
const CARTS = [...CORPUS].sort()

function load(file: string): SmwRom {
  return new SmwRom(freshRom(file))
}

/** Every index appearing anywhere in the tree, in either root. */
function indicesIn(tree: MapTree): Set<number> {
  const out = new Set<number>()
  const walk = (n: MapNode): void => {
    out.add(n.index)
    n.children.forEach(walk)
  }
  tree.special.forEach(walk)
  tree.overworld.forEach(walk)
  tree.unassigned.forEach(walk)
  return out
}

function depthOf(n: MapNode, d = 0): number {
  return n.children.length === 0 ? d : Math.max(...n.children.map(c => depthOf(c, d + 1)))
}

describe('buildMapTree', () => {
  for (const file of CARTS) {
    describe.skipIf(!hasRom(file))(file, () => {
      /**
       * The assertion this feature exists to make. "Load all the maps" means
       * all of them: every non-filler slot the catalog found has to be
       * reachable in the rendered tree, or the explorer is hiding maps the
       * user owns.
       */
      it('covers every real map the catalog found, and invents none', () => {
        const rom = load(file)
        const catalog = buildLevelCatalog(rom)
        const expected = new Set(catalog.entries.filter(e => e.isReal).map(e => e.index))

        const tree = buildMapTree(rom)
        const actual = indicesIn(tree)

        const missing = [...expected].filter(i => !actual.has(i))
        const invented = [...actual].filter(i => !expected.has(i))

        expect(missing, 'maps the tree failed to place').toEqual([])
        expect(invented, 'indices the tree shows that hold no real data').toEqual([])
        expect(tree.mapCount).toBe(expected.size)
      })

      it('places every map exactly once at the top level of one root', () => {
        const tree = buildMapTree(load(file))
        // A sub-area reached from two levels is deliberately expanded under
        // both, so duplicates exist DEEPER in the tree. What must not happen
        // is the same map heading two folders, which would read as two
        // separate maps rather than one shared room.
        const tops = [...tree.special, ...tree.overworld, ...tree.unassigned].map(n => n.index)
        expect(new Set(tops).size).toBe(tops.length)
      })

      it('never files a map under both a level and the unassigned root', () => {
        const tree = buildMapTree(load(file))
        const under = new Set<number>()
        const walk = (n: MapNode): void => {
          under.add(n.index)
          n.children.forEach(walk)
        }
        tree.overworld.forEach(walk)
        tree.special.forEach(walk)
        // Unassigned means exactly "no overworld root reaches this".
        for (const n of tree.unassigned) {
          expect(under.has(n.index), `$${n.index.toString(16)} is in both roots`).toBe(false)
        }
      })

      it('nests sub-areas rather than flattening them', () => {
        const tree = buildMapTree(load(file))
        const deepest = Math.max(0, ...tree.overworld.map(n => depthOf(n)))
        // A flattening bug produces a correct map COUNT with every node at
        // depth 0, which the coverage assertion above cannot see.
        expect(deepest).toBeGreaterThan(0)
      })

      it('reports the grouping it could not do instead of implying none was lost', () => {
        const tree = buildMapTree(load(file))
        if (tree.unassigned.length > 0) {
          expect(tree.notes.join(' ')).toMatch(/unassigned/i)
        }
      })
    })
  }
})

describe.skipIf(!hasRom(VANILLA))('buildMapTree, on the vanilla cart', () => {
  /**
   * Vanilla's documented figure, from docs/glossary.md: 512 slots, 277 empty,
   * 235 maps. Pinned because it is the number every other count in this
   * project gets checked against.
   */
  it('finds the 235 maps the glossary documents for vanilla', () => {
    expect(buildMapTree(load(VANILLA)).mapCount).toBe(235)
  })

  /**
   * $012 holds the filler L1 pointer on vanilla, yet SmwRom.classifyLevels
   * reports it as an overworld level: it gates on levelHasObjects(), and the
   * filler room contains well-formed object data (SmwRom.ts, _findFillerL1Pointer).
   * Driving the tree from the catalog instead is what keeps it out, so this
   * pins the reason rather than the symptom.
   */
  it('excludes the filler slot that classifyLevels reports as a level', () => {
    const rom = load(VANILLA)
    expect(rom.classifyLevels().overworld).toContain(0x012)
    expect(indicesIn(buildMapTree(rom)).has(0x012)).toBe(false)
  })

  /**
   * classifyLevels dedupes by L1 pointer, so slots sharing a pointer with an
   * earlier slot never appear in it at all: 42 of them on vanilla. They are
   * real maps and the explorer has to show them.
   */
  it('keeps real maps that share an L1 pointer with an earlier slot', () => {
    const rom = load(VANILLA)
    const { overworld, subarea } = rom.classifyLevels()
    const classified = new Set([...overworld, ...subarea])
    const shown = indicesIn(buildMapTree(rom))

    const recovered = [...shown].filter(i => !classified.has(i))
    expect(recovered.length).toBeGreaterThan(0)
    for (const i of recovered) {
      const ptr = rom.getLevelL1Pointer(i)
      expect(ptr, `$${i.toString(16)} should hold a real pointer`).toBeTruthy()
    }
  })
})

/**
 * Proof the coverage assertion can go red.
 *
 * Without this, a buildMapTree that returned the catalog's own indices as a
 * flat list would satisfy every count check above, and so would one that
 * dropped maps if the expectation were computed from the tree itself.
 */
describe.skipIf(!hasRom(VANILLA))('group counts', () => {
  /**
   * An entrance is a launch tile the overworld grants a translevel, which is
   * what a hacker means by the word. Traced in OverworldEntrances, not counted
   * from the tree's own rows.
   */
  it('counts entrances from the overworld, not from the tree', () => {
    const rom = load(VANILLA)
    const tree = buildMapTree(rom)
    const derived = deriveOverworldEntrances(rom)

    expect(tree.counts.entrances).toBe(derived.entrances.length)
    // The documented vanilla figure, docs/glossary.md: 92 launch tiles
    // carrying a translevel.
    expect(tree.counts.entrances).toBe(92)
  })

  it('counts unassigned maps as the rows it actually shows', () => {
    const tree = buildMapTree(load(VANILLA))
    expect(tree.counts.unassigned).toBe(tree.unassigned.length)
  })
})

/**
 * Unknown is not zero.
 *
 * deriveOverworldEntrances refuses to guess on a ROM whose overworld another
 * editor rebuilt. A count of 0 there would read as "this hack has no
 * entrances", which is a confident false statement about someone's work.
 */
describe('group counts on a rebuilt overworld', () => {
  for (const file of CARTS) {
    it.skipIf(!hasRom(file))(
      `${file}: reports null rather than zero when the overworld is unreadable`,
      () => {
        const rom = load(file)
        const tree = buildMapTree(rom)
        const derived = deriveOverworldEntrances(rom)

        if (derived.overworldReadable) {
          expect(tree.counts.entrances).toBe(derived.entrances.length)
        } else {
          expect(tree.counts.entrances).toBeNull()
          expect(tree.notes.join(' ')).toMatch(/overworld/i)
        }
      },
    )
  }
})

describe.skipIf(!hasRom(VANILLA))('special maps', () => {
  /**
   * The title screen and the new-game intro are ordinary maps in ordinary
   * slots that nothing in the exit graph reaches. Found by reading the
   * immediate the game-mode code loads into OverworldOverride, matched by
   * byte pattern so a relocated routine is still found.
   *
   * Vanilla's values are documented in the disassembly as
   * !TitleScreenLevel = $C7 and !IntroCutsceneLevel = $C5 (constants.asm:157),
   * and its own data files are named 0C7_titlescreen.bin and
   * 0C5_introcutscene.bin (bank_06.asm:33, 35).
   */
  it('finds the title screen and the new-game intro, in play order', () => {
    const tree = buildMapTree(load(VANILLA))
    expect(tree.special.map(s => s.role)).toEqual(['title-screen', 'new-game'])
    expect(tree.special.map(s => s.index)).toEqual([0x0c7, 0x0c5])
  })

  it('cites where each slot was read from', () => {
    const tree = buildMapTree(load(VANILLA))
    // A citation the user can check, not a bare claim.
    expect(tree.special[0].foundAt).toBe('$00:96CB')
    expect(tree.special[1].foundAt).toBe('$00:9CB0')
  })

  it('takes them out of unassigned rather than listing them twice', () => {
    const tree = buildMapTree(load(VANILLA))
    const unassigned = tree.unassigned.map(n => n.index)
    expect(unassigned).not.toContain(0x0c7)
    expect(unassigned).not.toContain(0x0c5)
  })

  it('still covers every map once they have been moved', () => {
    const rom = load(VANILLA)
    const expected = new Set(
      buildLevelCatalog(rom)
        .entries.filter(e => e.isReal)
        .map(e => e.index),
    )
    const actual = indicesIn(buildMapTree(rom))
    expect([...expected].filter(i => !actual.has(i))).toEqual([])
  })
})

/**
 * Honest degradation on a ROM whose loader has been replaced.
 *
 * Grand Poo World 2 and Invictus both replace GM03LoadTitleScreen with a JML,
 * so the title-screen pattern is absent. Reading the vanilla ADDRESS on
 * Invictus yields $C8, a confident wrong answer, which is exactly what the
 * pattern match and the fail-closed note exist to prevent.
 */
describe('special maps on edited ROMs', () => {
  const EDITED = CARTS.filter(f => /Invictus|Grand Poo World 2/i.test(f))

  // `hasRoms` is false for an empty list. `EDITED.every(...)` was true for
  // one, so renaming a cart left this case running, looping over nothing and
  // passing (issue #469).
  it.skipIf(!hasRoms(EDITED))('declines to name a title screen it cannot read, and says so', () => {
    for (const file of EDITED) {
      const tree = buildMapTree(load(file))
      const roles = tree.special.map(s => s.role)

      expect(roles, `${file} should not claim a title screen`).not.toContain('title-screen')
      // Silence would be indistinguishable from "this ROM has no title screen".
      expect(tree.notes.join(' ')).toMatch(/title screen/i)
      // The new-game pattern survives on these carts, so it is still found.
      expect(roles, `${file} should still find new game`).toContain('new-game')
    }
  })
})

describe.skipIf(!hasRom(VANILLA))('the oracle can fail', () => {
  it('a tree missing one map fails the coverage check', () => {
    const rom = load(VANILLA)
    const tree = buildMapTree(rom)
    const expected = new Set(
      buildLevelCatalog(rom)
        .entries.filter(e => e.isReal)
        .map(e => e.index),
    )

    // Plant exactly the defect: drop a map from the tree.
    const damaged: MapTree = { ...tree, unassigned: tree.unassigned.slice(1) }
    const missing = [...expected].filter(i => !indicesIn(damaged).has(i))
    expect(missing.length).toBeGreaterThan(0)
  })

  // Gated, not early-returned: `if (!invictus) return` reported this case as
  // PASSED on any machine without that cart, which is a green tick for work
  // that never ran.
  it.skipIf(!hasRom(INVICTUS))(
    'reading the title screen at a fixed address would be confidently wrong',
    () => {
      const rom = load(INVICTUS)

      // The vanilla site, read blind. $00:96CB holds $5C (JML) on this cart
      // rather than $A9 (LDA #imm), so the byte after it is part of a jump
      // target and the slot it implies is garbage.
      const opcode = rom.rom.readAt(0x0096cb, 2)!
      expect(opcode[0], 'expected a replaced routine').not.toBe(0xa9)
      // What a fixed-address read would have reported: a plausible, wrong slot.
      expect(opcode[1] - 0x24).not.toBe(0x0c7)

      // And the tree correctly reports nothing rather than that garbage.
      expect(buildMapTree(rom).special.map(s => s.role)).not.toContain('title-screen')
    },
  )

  it('a flattened tree fails the nesting check', () => {
    const tree = buildMapTree(load(VANILLA))
    const flat: MapNode[] = tree.overworld.map(n => ({ ...n, children: [] }))
    expect(Math.max(0, ...flat.map(n => depthOf(n)))).toBe(0)
  })
})
