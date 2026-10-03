/** The vanilla Maps tree is flat under each root (#434). */
import { beforeAll, describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapTree } from '../../../src/rom/MapTree'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('buildMapTree on vanilla, flat', () => {
  // In beforeAll: a skipped describe's body still runs at collection, and CI has no ROM.
  let tree: MapTree
  beforeAll(() => {
    tree = buildMapTree(new SmwRom(freshRom(VANILLA)))
  })

  it('gives $022 exactly its five sub areas, once each, none expandable', () => {
    const a = tree.overworld.find(n => n.index === 0x022)!
    expect(a.children.map(c => c.index)).toEqual([0x0be, 0x0d0, 0x0d1, 0x0f5, 0x0f6])
    expect(a.children.every(c => c.children.length === 0)).toBe(true)
  })

  it("lists every root's children once, with nothing below depth 1", () => {
    for (const root of tree.overworld) {
      const ids = root.children.map(c => c.index)
      expect(new Set(ids).size, `$${root.index.toString(16)}`).toBe(ids.length)
      expect(ids, `$${root.index.toString(16)} ascending`).toEqual([...ids].sort((x, y) => x - y))
      for (const c of root.children) {
        expect(c.children).toEqual([])
        expect(c.kind).toBe('map')
      }
    }
  })
})
