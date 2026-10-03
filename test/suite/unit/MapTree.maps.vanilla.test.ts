/** The Maps tree on vanilla shows maps, not slots (#434). */
import { beforeAll, describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapNode, type MapTree } from '../../../src/rom/MapTree'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

const indices = (nodes: MapNode[]): number[] => nodes.map(n => n.index)

function everyNode(tree: MapTree): MapNode[] {
  const out: MapNode[] = []
  const walk = (n: MapNode): void => {
    out.push(n)
    n.children.forEach(walk)
  }
  ;[...tree.overworld, ...tree.unassigned].forEach(walk)
  return out
}

describe.skipIf(!hasRom(VANILLA))('buildMapTree on vanilla, by map', () => {
  // In beforeAll: a skipped describe's body still runs at collection, and CI has no ROM.
  let tree: MapTree
  beforeAll(() => {
    tree = buildMapTree(new SmwRom(freshRom(VANILLA)))
  })

  it('reads $022 as map A -> {B, $0BE}, with B leading back to A as a loop', () => {
    // A = $022/$0D0/$0D1 (L1 $06E444), B = $0F5/$0F6 ($06E5D0), room $0BE.
    const a = tree.overworld.find(n => n.index === 0x022)!
    expect(indices(a.children)).toEqual([0x0f5, 0x0be])
    const [b, room] = a.children as [MapNode, MapNode]
    expect(b.children.find(c => c.index === 0x022)?.kind).toBe('loop')
    expect(room.children.map(c => [c.index, c.kind])).toEqual([[0x022, 'loop']])
    // Each map appears once per level: no alias slot is its own node.
    for (const alias of [0x0d0, 0x0d1, 0x0f6]) {
      expect(
        everyNode(tree).some(n => n.index === alias),
        `$${alias.toString(16)}`,
      ).toBe(false)
    }
    expect(a.l1Aliases).toEqual([0x0d0, 0x0d1])
  })

  it('counts distinct maps, not slots', () => {
    expect(tree.mapCount).toBe(193)
  })

  // Groups that sit on both sides of $100. $0CC's reaches the tree through the
  // exit graph; $096's is no overworld root's, so it is listed unassigned.
  it.each([
    {
      what: 'a reached split map',
      label: 0xcc,
      group: [0xcc, 0xd5, 0xd9, 0xdf, 0xe2, 0xe5, 0x1de],
    },
    { what: 'an unreached split map', label: 0x96, group: [0x96, 0x97, 0x196, 0x197] },
  ])('shows $what as one node', ({ label, group }) => {
    const shown = everyNode(tree)
      .filter(n => group.includes(n.index))
      .map(n => n.index)
    expect(new Set(shown)).toEqual(new Set([label]))
  })
})
