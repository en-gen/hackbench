/**
 * Slots that share a data pointer are the same bytes.
 *
 * Edits are byte patches at a file offset derived from the slot's pointer, so
 * two slots sharing a pointer cannot be edited independently: writing "to $015"
 * writes to $017 as well. That is not preventable, because there is only one
 * copy of the bytes. It has to be visible instead, or the editor silently
 * changes a level the user was not looking at.
 *
 * Sharing is per data stream. A group can share Layer-1 geometry while holding
 * distinct sprite pointers, so a single "is aliased" flag would be wrong: the
 * set of slots an object move affects is not the set a sprite delete affects.
 *
 * Measured on the vanilla cart: 21 groups share an L1 pointer, covering 63 of
 * the 235 real slots.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildLevelCatalog, type LevelCatalog } from '../../../src/rom/LevelCatalog'
import { buildMapTree, type MapNode } from '../../../src/rom/MapTree'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const VANILLA_ROM = romPath(VANILLA)

describe.skipIf(!hasRom(VANILLA))('map data aliasing', () => {
  let catalog: LevelCatalog
  let at: (index: number) => LevelCatalog['entries'][number]
  let nodeAt: (index: number) => MapNode | undefined

  beforeAll(() => {
    const rom = SmwRom.open(VANILLA_ROM)
    catalog = buildLevelCatalog(rom)
    at = (index: number) => catalog.entries[index]!

    const tree = buildMapTree(rom)
    const found = new Map<number, MapNode>()
    const walk = (n: MapNode) => {
      if (!found.has(n.index)) found.set(n.index, n)
      n.children.forEach(walk)
    }
    for (const n of [...tree.overworld, ...tree.special, ...tree.bonus, ...tree.unassigned]) walk(n)
    nodeAt = (index: number) => found.get(index)
  })

  it('reports the slots an L1 edit would also change', () => {
    // $015, $016 and $017 are one level's bytes reached three ways.
    expect(at(0x015).l1Aliases).toEqual([0x016, 0x017])
    expect(at(0x017).l1Aliases).toEqual([0x015, 0x016])

    // The ghost-house exit room is shared six ways.
    expect(at(0x0eb).l1Aliases).toEqual([0x0f0, 0x0fb, 0x1da, 0x1e7, 0x1f9])
  })

  it('reports sprite sharing separately, because it differs from L1 sharing', () => {
    // $0EB's group shares L1 but splits on sprites, so deleting a sprite in
    // $0EB must not claim it changes all five others.
    expect(at(0x0eb).l1Aliases.length).toBe(5)
    expect(at(0x0eb).spriteAliases.length).toBeLessThan(5)

    // $015's group shares both, so there the two lists agree.
    expect(at(0x015).spriteAliases).toEqual([0x016, 0x017])
  })

  it('leaves the common case empty rather than self-referential', () => {
    expect(at(0x105).l1Aliases).toEqual([])
    expect(at(0x105).spriteAliases).toEqual([])
    // A slot never lists itself.
    for (const e of catalog.entries) {
      expect(e.l1Aliases).not.toContain(e.index)
      expect(e.spriteAliases).not.toContain(e.index)
    }
  })

  it('carries the aliases onto the map tree, where a view can see them', () => {
    // Deriving it in the catalog is not enough: the tree is what a view walks,
    // so an alias the tree drops is an alias the user never gets warned about.
    expect(nodeAt(0x015)?.l1Aliases).toEqual([0x016, 0x017])
    // An alias slot is not its own node: the map is labelled by its lowest slot.
    expect(nodeAt(0x017)).toBeUndefined()
    expect(nodeAt(0x105)?.l1Aliases).toEqual([])

    // Every node's aliases must agree with the catalog, including sub-area and
    // special nodes, which are built on separate code paths.
    const check = (n: MapNode) => {
      expect(n.l1Aliases, `node ${n.index}`).toEqual(at(n.index).l1Aliases)
      n.children.forEach(check)
    }
    const tree = buildMapTree(SmwRom.open(VANILLA_ROM))
    for (const n of [...tree.overworld, ...tree.special, ...tree.bonus, ...tree.unassigned])
      check(n)
  })

  it('never aliases filler slots to each other', () => {
    // 277 slots share the filler pointer. Reporting them as 276 aliases each
    // would be true and useless, and would bury the 21 real groups.
    for (const e of catalog.entries) {
      if (!e.isReal) expect(e.l1Aliases).toEqual([])
    }
  })

  it('pins the vanilla totals', () => {
    const real = catalog.entries.filter(e => e.isReal)
    expect(real.length).toBe(235)
    const aliased = real.filter(e => e.l1Aliases.length > 0)
    expect(aliased.length).toBe(63)

    const groups = new Set(
      aliased.map(e => [e.index, ...e.l1Aliases].sort((a, b) => a - b).join(',')),
    )
    expect(groups.size).toBe(21)

    // Reported as data, not as a note: `notes` is for caveats about the
    // catalog's own correctness, and aliasing is a fact about the cart.
    expect(catalog.aliasedSlotCount).toBe(63)
    expect(catalog.l1AliasGroupCount).toBe(21)
  })
})
