import { describe, it, expect } from 'vitest'
import {
  buildLevelSubtree,
  LevelTreeNode,
  MAX_SUBTREE_NODES,
  MAX_SUBTREE_DEPTH,
} from '../../../src/rom/LevelTree'

// Overworld ranges are $000-$024 and $101-$13B, so $0C0-$0FF and $1C0-$1FF are
// safely outside them and stand in for sub-areas here.

/** Compact `index[children]`, with `!` marking a loop and `~` a truncation marker. */
function shape(node: LevelTreeNode): string {
  const hex = node.index.toString(16).toUpperCase().padStart(3, '0')
  const mark = node.kind === 'loop' ? '!' : node.kind === 'truncated' ? '~' : ''
  const self = `$${hex}${mark}`
  return node.children.length === 0 ? self : `${self}[${node.children.map(shape).join(' ')}]`
}

function countKind(node: LevelTreeNode, kind: LevelTreeNode['kind']): number {
  return (node.kind === kind ? 1 : 0) + node.children.reduce((n, c) => n + countKind(c, kind), 0)
}

function countNodes(node: LevelTreeNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0)
}

function maxDepth(node: LevelTreeNode, depth = 0): number {
  return node.children.reduce((d, c) => Math.max(d, maxDepth(c, depth + 1)), depth)
}

/** k chained branch-and-rejoin rooms: 2^k distinct root-to-leaf paths. */
function diamondChain(k: number): Map<number, number[]> {
  const graph = new Map<number, number[]>()
  for (let i = 0; i < k; i++) {
    const hub = 0x0c0 + i * 3
    graph.set(hub, [hub + 1, hub + 2])
    graph.set(hub + 1, [hub + 3])
    graph.set(hub + 2, [hub + 3])
  }
  return graph
}

/** A linear chain of `n` rooms, long enough to outrun the depth cap. */
function chain(n: number): Map<number, number[]> {
  const graph = new Map<number, number[]>()
  for (let i = 0; i < n; i++) graph.set(0x0c0 + i, [0x0c0 + i + 1])
  return graph
}

describe('buildLevelSubtree', () => {
  it('nests a 3-deep chain instead of flattening it', () => {
    const tree = buildLevelSubtree(
      0x001,
      new Map([
        [0x001, [0x0c0]],
        [0x0c0, [0x0c1]],
        [0x0c1, [0x0c2]],
      ]),
    )
    expect(shape(tree)).toBe('$001[$0C0[$0C1[$0C2]]]')
  })

  it('expands a shared sub-area in full under each parent (diamond, not a cycle)', () => {
    // Vanilla shape: $007 -> $0E6 -> $0E7 and $007 -> $0E8 -> $0E7, with $0E7
    // itself leading on to $0C0. Both routes must expand the whole tail: $0E7 is
    // on the path only while $0E6 is being expanded, so if the path set were
    // never unwound it would come back as a loop node under $0E8.
    const tree = buildLevelSubtree(
      0x007,
      new Map([
        [0x007, [0x0e6, 0x0e8]],
        [0x0e6, [0x0e7]],
        [0x0e8, [0x0e7]],
        [0x0e7, [0x0c0]],
      ]),
    )
    expect(shape(tree)).toBe('$007[$0E6[$0E7[$0C0]] $0E8[$0E7[$0C0]]]')
    expect(countKind(tree, 'loop')).toBe(0)
  })

  it('renders a back edge as exactly one non-expandable loop node and stops', () => {
    const tree = buildLevelSubtree(
      0x001,
      new Map([
        [0x001, [0x0c0]],
        [0x0c0, [0x0c1]],
        [0x0c1, [0x0c0]],
      ]),
    )
    expect(shape(tree)).toBe('$001[$0C0[$0C1[$0C0!]]]')
    expect(countKind(tree, 'loop')).toBe(1)
    const loop = tree.children[0]!.children[0]!.children[0]!
    expect(loop).toEqual({ index: 0x0c0, children: [], kind: 'loop' })
  })

  it('marks a back edge onto the root itself', () => {
    const tree = buildLevelSubtree(
      0x0c0,
      new Map([
        [0x0c0, [0x0c1]],
        [0x0c1, [0x0c0]],
      ]),
    )
    expect(shape(tree)).toBe('$0C0[$0C1[$0C0!]]')
  })

  it('renders a self-edge as a loop node without recursing', () => {
    const tree = buildLevelSubtree(
      0x001,
      new Map([
        [0x001, [0x0c0]],
        [0x0c0, [0x0c0]],
      ]),
    )
    expect(shape(tree)).toBe('$001[$0C0[$0C0!]]')
    expect(countKind(tree, 'loop')).toBe(1)
  })

  it('does not descend into overworld-classified children', () => {
    // $002 is main-map range, $101 is submap range; each roots its own folder.
    const tree = buildLevelSubtree(
      0x001,
      new Map([
        [0x001, [0x0c0, 0x002]],
        [0x0c0, [0x101, 0x0c1]],
      ]),
    )
    expect(shape(tree)).toBe('$001[$0C0[$0C1]]')
  })

  it('leaves a sibling pair unnested when neither leads to the other', () => {
    const tree = buildLevelSubtree(0x002, new Map([[0x002, [0x0d0, 0x0d1]]]))
    expect(shape(tree)).toBe('$002[$0D0 $0D1]')
  })

  it('returns a childless root when the graph has no exits for it', () => {
    const tree = buildLevelSubtree(0x001, new Map())
    expect(tree).toEqual({ index: 0x001, children: [], kind: 'room' })
  })
})

describe('buildLevelSubtree -- expansion caps', () => {
  it('caps a 20-diamond chain that would otherwise expand to 4.19M nodes', () => {
    // 2^20 root-to-leaf paths from 61 graph nodes, all of them legal sub-area
    // indices. Uncapped this expands to 4,194,301 nodes (measured once, this
    // machine, by removing the node cap; see the commit message).
    const tree = buildLevelSubtree(0x0c0, diamondChain(20))
    expect(countNodes(tree)).toBe(1004)
    expect(countNodes(tree)).toBeLessThanOrEqual(MAX_SUBTREE_NODES + 2 * MAX_SUBTREE_DEPTH)
    expect(countKind(tree, 'truncated')).toBeGreaterThan(0)
    expect(maxDepth(tree)).toBeLessThanOrEqual(MAX_SUBTREE_DEPTH)
  })

  it('stops a long chain at the depth cap and marks where it stopped', () => {
    const tree = buildLevelSubtree(0x0c0, chain(40))
    expect(maxDepth(tree)).toBe(MAX_SUBTREE_DEPTH)
    expect(countNodes(tree)).toBe(MAX_SUBTREE_DEPTH + 1)
    expect(countKind(tree, 'truncated')).toBe(1)
    let deepest = tree
    while (deepest.children.length > 0) deepest = deepest.children[0]!
    expect(deepest.kind).toBe('truncated')
  })

  it('leaves a graph well under the caps untouched', () => {
    const tree = buildLevelSubtree(0x0c0, diamondChain(3))
    expect(countKind(tree, 'truncated')).toBe(0)
    expect(countNodes(tree)).toBe(29)
  })
})
