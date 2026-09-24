/**
 * buildLevelSubtree -- nesting shapes measured against the real ROM corpus.
 *
 * The synthetic tests in test/suite/unit/LevelSubtree.test.ts prove the
 * diamond/back-edge distinction and the expansion caps on hand-built graphs.
 * These prove the distinction survives contact with real pointer tables, where
 * vanilla holds 24 distinct back edges, each one standing between path
 * expansion and an infinite one. Most run through slots that share L1 data,
 * such as $0D0/$0D1/$0F5/$0F6, which exit into each other.
 *
 * Every number below was measured on the ROM it names, not derived from an
 * independent expectation. A diff that moves one is not automatically wrong,
 * but it must be explained.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, isOverworldLevel } from '../../../src/rom/SmwRom'
import { buildLevelSubtree, LevelTreeNode } from '../../../src/rom/LevelTree'
import { VANILLA, hasRom, romPath } from '../support/corpus'

// Same resolution as exitGraphReach.test.ts, so this does not skip in a worktree.
const VANILLA_ROM = romPath(VANILLA)

// The corpus is outside the repo and absent in CI. One case per ROM, so an absent
// ROM skips rather than vanishing (CLAUDE.md, Quality gates).
//
// maxRootNodes is the largest expansion under any single root, which is the
// figure the caps in LevelTree.ts are sized against. The whole-ROM totals that
// used to be pinned here moved with any change to classifyLevels or
// _findFillerL1Pointer, so all six numbers had to be re-pasted at once.
const CORPUS = [
  { name: 'Super Mario World (USA).vanilla.sfc', maxRootNodes: 118, loops: 81, maxDepth: 6 },
  { name: 'Super Mario World (USA).magic.sfc', maxRootNodes: 118, loops: 81, maxDepth: 6 },
  { name: 'Grand Poo World 2 1.1.sfc', maxRootNodes: 23, loops: 20, maxDepth: 5 },
  { name: 'GrandPooWorld_V1.2.sfc', maxRootNodes: 118, loops: 80, maxDepth: 6 },
  { name: 'Invictus 1.0.sfc', maxRootNodes: 44, loops: 13, maxDepth: 5 },
  { name: 'Seven_Vanilla_Levels.sfc', maxRootNodes: 118, loops: 76, maxDepth: 6 },
]

const hex = (n: number) => '$' + n.toString(16).toUpperCase().padStart(3, '0')

/** Compact `index[children]`, with `!` marking a loop and `~` a truncation marker. */
function shape(node: LevelTreeNode): string {
  const mark = node.kind === 'loop' ? '!' : node.kind === 'truncated' ? '~' : ''
  const self = `${hex(node.index)}${mark}`
  return node.children.length === 0 ? self : `${self}[${node.children.map(shape).join(' ')}]`
}

interface Stats {
  nodes: number
  loops: number
  truncated: number
  maxDepth: number
  maxRootNodes: number
  distinct: Set<number>
  loopEdges: string[]
}

function walk(node: LevelTreeNode, depth: number, s: Stats): void {
  s.nodes++
  s.maxDepth = Math.max(s.maxDepth, depth)
  if (node.kind === 'loop') s.loops++
  if (node.kind === 'truncated') s.truncated++
  if (depth > 0) s.distinct.add(node.index)
  for (const c of node.children) {
    if (c.kind === 'loop') s.loopEdges.push(`${hex(node.index)}->${hex(c.index)}`)
    walk(c, depth + 1, s)
  }
}

function statsForRom(rom: SmwRom): Stats {
  const graph = rom.buildLevelExitGraph()
  const s: Stats = {
    nodes: 0,
    loops: 0,
    truncated: 0,
    maxDepth: 0,
    maxRootNodes: 0,
    distinct: new Set(),
    loopEdges: [],
  }
  // Roots are the graph's own, not classifyLevels().overworld, which dedupes by
  // L1 pointer and drops real roots such as $016/$017.
  for (const root of [...graph.keys()].filter(isOverworldLevel)) {
    const before = s.nodes
    walk(buildLevelSubtree(root, graph), 0, s)
    s.maxRootNodes = Math.max(s.maxRootNodes, s.nodes - before)
  }
  return s
}

describe.skipIf(!hasRom(VANILLA))('buildLevelSubtree -- vanilla nesting', () => {
  let rom: SmwRom
  let graph: Map<number, number[]>
  let stats: Stats

  beforeAll(() => {
    rom = SmwRom.open(VANILLA_ROM)
    graph = rom.buildLevelExitGraph()
    stats = statsForRom(rom)
  })

  // Three separate diamonds, not one: a fix tuned to the shape of $007 alone
  // would still get $00E (diamond one tier down) or $009 (parent and child both
  // reachable from the root) wrong.
  it.each([
    { expected: '$007[$0E6[$0E7[$0E5]] $0E8[$0E7[$0E5]]]' },
    { expected: '$00E[$0DC[$0DB[$0D9]] $0DA[$0DC[$0DB[$0D9]]]]' },
    { expected: '$009[$0E9[$0FF] $0FF]' },
  ])('nests both routes of $expected, with no loop marker', ({ expected }) => {
    const root = parseInt(expected.slice(1, 4), 16)
    expect(shape(buildLevelSubtree(root, graph))).toBe(expected)
  })

  it('marks 81 loop nodes over exactly 24 distinct back edges', () => {
    // A loop node is emitted once per path that reaches the back edge, so the
    // node count exceeds the edge count; the edge set is what is pinned.
    expect(stats.loops).toBe(81)
    expect([...new Set(stats.loopEdges)].sort()).toEqual([
      '$0BE->$0D0',
      '$0D0->$0BE',
      '$0D0->$0F5',
      '$0D0->$0F6',
      '$0D1->$0BE',
      '$0D1->$0F5',
      '$0D1->$0F6',
      '$0DE->$0FE',
      '$0EC->$0ED',
      '$0EE->$0ED',
      '$0F2->$0F1',
      '$0F5->$0BE',
      '$0F5->$0D0',
      '$0F5->$0D1',
      '$0F6->$0BE',
      '$0F6->$0D0',
      '$0F6->$0D1',
      '$0FA->$0F9',
      '$1D9->$1DD',
      '$1DB->$1DD',
      '$1DC->$1DD',
      '$1E8->$1FA',
      '$1E9->$1FA',
      '$1FB->$1EA',
    ])
    expect(shape(buildLevelSubtree(0x114, graph))).toBe(
      '$114[$1DD[$1DB[$1DD!] $1D9[$1DD!] $1DA $1DC[$1DD!]]]',
    )
  })

  it('nests exactly the 132 sub-areas the exit graph names as destinations', () => {
    // Derived by a route the expansion never takes: a flat scan of every
    // adjacency list, no traversal. buildLevelExitGraph only records edges for
    // levels it reached from an overworld root, and a room's first occurrence on
    // any path can never be a back edge, so every destination is expanded at
    // least once and the two sets have to agree exactly. Not filtered for
    // overworld indices: the tree gates them out, so a graph that started
    // emitting one would turn this red instead of passing silently.
    const destinations = new Set([...graph.values()].flat())
    expect(stats.distinct).toEqual(destinations)
    expect(stats.distinct.size).toBe(132)
  })

  it('expands vanilla without ever reaching a cap', () => {
    expect(stats.truncated).toBe(0)
  })
})

describe('buildLevelSubtree -- measured expansion sizes', () => {
  // The caps in LevelTree.ts are sized against maxRootNodes; these pins are what
  // say how much headroom the six ROMs actually leave.
  for (const c of CORPUS) {
    it.skipIf(!hasRom(c.name))(
      `${c.name} peaks at ${c.maxRootNodes} nodes under one root, ${c.loops} loops, depth ${c.maxDepth}`,
      () => {
        const s = statsForRom(SmwRom.open(romPath(c.name)))
        expect({ maxRootNodes: s.maxRootNodes, loops: s.loops, maxDepth: s.maxDepth }).toEqual({
          maxRootNodes: c.maxRootNodes,
          loops: c.loops,
          maxDepth: c.maxDepth,
        })
        expect(s.truncated).toBe(0)
      },
    )
  }
})
