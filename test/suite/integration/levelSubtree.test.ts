/**
 * buildLevelSubtree -- nesting shapes measured against the real ROM corpus.
 *
 * The synthetic tests in test/suite/unit/LevelSubtree.test.ts prove the
 * diamond/back-edge distinction and the expansion caps on hand-built graphs.
 * These prove the distinction survives contact with real pointer tables, where
 * the single vanilla back edge ($1DB -> $1DD) is the only thing standing between
 * path expansion and an infinite one.
 *
 * Every number below was measured on the ROM it names, not derived from an
 * independent expectation. A diff that moves one is not automatically wrong,
 * but it must be explained.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'fs'
import * as path from 'path'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildLevelSubtree, LevelTreeNode } from '../../../src/rom/LevelTree'

const ROM_DIR = path.resolve(__dirname, '../../roms')
const VANILLA = path.join(ROM_DIR, 'Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(VANILLA)

// test/roms/ is gitignored and absent in CI, so every block guards itself.
// An it.each over an empty array fails its suite rather than skipping.
//
// maxRootNodes is the largest expansion under any single root, which is the
// figure the caps in LevelTree.ts are sized against. The whole-ROM totals that
// used to be pinned here moved with any change to classifyLevels or
// _findFillerL1Pointer, so all six numbers had to be re-pasted at once.
const CORPUS = [
  { name: 'Super Mario World (USA).vanilla.sfc', maxRootNodes: 41, loops: 1, maxDepth: 4 },
  { name: 'Super Mario World (USA).magic.sfc', maxRootNodes: 41, loops: 1, maxDepth: 4 },
  { name: 'Grand Poo World 2 1.1.sfc', maxRootNodes: 12, loops: 6, maxDepth: 4 },
  { name: 'GrandPooWorld_V1.2.sfc', maxRootNodes: 6, loops: 4, maxDepth: 3 },
  { name: 'Invictus 1.0.sfc', maxRootNodes: 31, loops: 6, maxDepth: 4 },
  { name: 'Seven_Vanilla_Levels.sfc', maxRootNodes: 41, loops: 1, maxDepth: 4 },
].filter(c => existsSync(path.join(ROM_DIR, c.name)))
const corpusPresent = CORPUS.length > 0

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
  for (const root of rom.classifyLevels().overworld) {
    const before = s.nodes
    walk(buildLevelSubtree(root, graph), 0, s)
    s.maxRootNodes = Math.max(s.maxRootNodes, s.nodes - before)
  }
  return s
}

describe.skipIf(!romPresent)('buildLevelSubtree -- vanilla nesting', () => {
  let rom: SmwRom
  let graph: Map<number, number[]>
  let stats: Stats

  beforeAll(() => {
    rom = SmwRom.open(VANILLA)
    graph = rom.buildLevelExitGraph()
    stats = statsForRom(rom)
  })

  // Three separate diamonds, not one: a fix tuned to the shape of $007 alone
  // would still get $00E (diamond one tier down) or $009 (parent and child both
  // reachable from the root) wrong.
  it.each([
    { expected: '$007[$0E6[$0E7] $0E8[$0E7]]' },
    { expected: '$00E[$0DC[$0DB] $0DA[$0DC[$0DB]]]' },
    { expected: '$009[$0E9[$0FF] $0FF]' },
  ])('nests both routes of $expected, with no loop marker', ({ expected }) => {
    const root = parseInt(expected.slice(1, 4), 16)
    expect(shape(buildLevelSubtree(root, graph))).toBe(expected)
  })

  it('has exactly one loop node in the whole tree, $1DB -> $1DD under $114', () => {
    expect(stats.loops).toBe(1)
    expect(stats.loopEdges).toEqual(['$1DB->$1DD'])
    expect(shape(buildLevelSubtree(0x114, graph))).toBe('$114[$1DD[$1DB[$1DD!]]]')
  })

  it('nests exactly the 99 sub-areas the exit graph names as destinations', () => {
    // Derived by a route the expansion never takes: a flat scan of every
    // adjacency list, no traversal. buildLevelExitGraph only records edges for
    // levels it reached from an overworld root, and a room's first occurrence on
    // any path can never be a back edge, so every destination is expanded at
    // least once and the two sets have to agree exactly. Not filtered for
    // overworld indices: the tree gates them out, so a graph that started
    // emitting one would turn this red instead of passing silently.
    const destinations = new Set([...graph.values()].flat())
    expect(stats.distinct).toEqual(destinations)
    expect(stats.distinct.size).toBe(99)
  })

  it('expands vanilla without ever reaching a cap', () => {
    expect(stats.truncated).toBe(0)
  })
})

describe.skipIf(!corpusPresent)('buildLevelSubtree -- measured expansion sizes', () => {
  // The caps in LevelTree.ts are sized against maxRootNodes; these pins are what
  // say how much headroom the six ROMs actually leave.
  it.each(CORPUS)(
    '$name peaks at $maxRootNodes nodes under one root, $loops loops, depth $maxDepth',
    c => {
      const s = statsForRom(SmwRom.open(path.join(ROM_DIR, c.name)))
      expect({ maxRootNodes: s.maxRootNodes, loops: s.loops, maxDepth: s.maxDepth }).toEqual({
        maxRootNodes: c.maxRootNodes,
        loops: c.loops,
        maxDepth: c.maxDepth,
      })
      expect(s.truncated).toBe(0)
    },
  )
})
