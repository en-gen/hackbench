/**
 * The wings link in the Maps tree (#1229, #1295): Yoshi Heaven lists under the map that holds the
 * wings block (an entry map directly, a sub area as its child), in that root's submap half. ROM-free; YoshiWings.synthetic.test.ts runs the spawn.
 */
import { describe, it, expect } from 'vitest'
import { buildMapTree } from '../../../src/rom/MapTree'
import { SmwRom } from '../../../src/rom/SmwRom'
import { applyGroups, admitGroups, staleSlots, topLevelSlots } from '../../../src/project/MapGroups'
import { WINGS_PATH } from '../../../src/rom/YoshiWings'
import { SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'
import { seamsFor, wingsRom, wingsTree, yoshiNested, yoshiUnder } from '../support/wingsTree'

const EXITS = { 0x001: [0x040], 0x040: [], 0x002: [], 0x101: [0x140], 0x140: [], 0x102: [] }
const rom = () => wingsRom(EXITS)
const bonusSlots = (t: ReturnType<typeof wingsTree>) =>
  t.bonus.map(b => b.index).sort((a, b) => a - b)

describe('the wings link in buildMapTree', () => {
  it('files Yoshi Heaven under the root that holds the block, in the root half, and drops it from bonus', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8] })
    expect(t.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([
      0x040, 0x0c8,
    ])
    expect(bonusSlots(t)).toEqual([0x000, 0x100, 0x1c8]) // the other half is unreached, so it stays
    expect(t.wingsPlaced).toEqual([0x0c8])
    expect(t.unassigned.map(n => n.index)).not.toContain(0x0c8)
  })

  it('links from a sub area too, and the submap half comes from the root', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x140: [1] }))
    // #1295: the row nests under the map that holds the block, not the root that reaches it.
    expect(yoshiUnder(t)).toEqual({})
    expect(yoshiNested(t)).toEqual({ 0x101: { 0x140: [0x1c8] } })
    const root = t.overworld.find(n => n.index === 0x101)!
    expect(root.children.map(c => c.index)).toEqual([0x140])
    expect(t.wingsPlaced).toEqual([0x1c8])
    expect(bonusSlots(t)).toEqual([0x000, 0x0c8, 0x100])
  })

  it('lists it directly under an entry map that holds the block (acceptance 2)', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x101: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x101: [0x1c8] })
    expect(yoshiNested(t)).toEqual({})
  })

  describe('two sub areas of one root (acceptance 3)', () => {
    const two = { 0x001: [0x040, 0x041], 0x040: [], 0x041: [] }
    it('lists it under each holder and nowhere else', () => {
      const r = wingsRom(two)
      const t = wingsTree(r, seamsFor(r, { 0x040: [1], 0x041: [5] }))
      expect(yoshiNested(t)).toEqual({ 0x001: { 0x040: [0x0c8], 0x041: [0x0c8] } })
      expect(yoshiUnder(t)).toEqual({})
    })
    it('lists it directly and under a sub area when both the root and the sub area hold a block', () => {
      const r = wingsRom(two)
      const t = wingsTree(r, seamsFor(r, { 0x001: [1], 0x041: [1] }))
      expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8] })
      expect(yoshiNested(t)).toEqual({ 0x001: { 0x041: [0x0c8] } })
    })
    it('keeps an exit-reached destination flat, unmarked, and nests it under the holder', () => {
      const r = wingsRom({ 0x001: [0x040, 0x0c8], 0x040: [], 0x0c8: [] })
      const t = wingsTree(r, seamsFor(r, { 0x040: [1] }))
      const kids = t.overworld.find(n => n.index === 0x001)!.children
      expect(kids.map(c => [c.index, c.reachedBy])).toEqual([[0x040, undefined], [0x0c8, undefined]]) // prettier-ignore
      expect(yoshiNested(t)).toEqual({ 0x001: { 0x040: [0x0c8] } })
    })
    it('keeps the mark on a flat destination that holds a block itself, nesting nothing', () => {
      const r = wingsRom({ 0x001: [0x0c8], 0x0c8: [] })
      const t = wingsTree(r, seamsFor(r, { 0x0c8: [1] }))
      const kids = t.overworld.find(n => n.index === 0x001)!.children
      expect(kids.map(c => [c.index, c.reachedBy])).toEqual([[0x0c8, 'yoshi-heaven']])
      expect(t.wingsPlaced).toEqual([0x0c8])
    })
    it('sorts the direct row among the sub areas when the destination is below one', () => {
      const r = wingsRom({ 0x001: [0x0d0], 0x0d0: [] })
      const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
      expect(t.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([0x0c8, 0x0d0]) // prettier-ignore
    })
    it('refuses an unread sub area holder and nests only under the sibling that reads', () => {
      const r = wingsRom(two)
      const end = new SmwRom(r).getLevelL1Pointer(0x041)! + 5 + 3
      r.writeAt(end, new Array(0x2100).fill(0x01)) // no $FF in reach, as the root case above
      const t = wingsTree(r, seamsFor(r, { 0x040: [1], 0x041: [1] }))
      expect(yoshiNested(t)).toEqual({ 0x001: { 0x040: [0x0c8] } })
      expect(yoshiUnder(t)).toEqual({})
    })
    it.each(Array.from({ length: 12 }, (_, x) => x))(
      'a sub area block at column %i nests only at mod 4 = 1',
      x => {
        const r = wingsRom(two)
        const t = wingsTree(r, seamsFor(r, { 0x041: [x] }))
        expect(Object.keys(yoshiNested(t)).length).toBe(x % 4 === 1 ? 1 : 0)
      },
    )
    it('never nests the destination under itself', () => {
      const r = wingsRom({ 0x001: [0x0c8], 0x0c8: [] })
      const t = wingsTree(r, seamsFor(r, { 0x0c8: [1] }))
      expect(yoshiNested(t)).toEqual({})
    })
  })

  it('serves two blocks in different submap halves, each its own destination', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x040: [9], 0x102: [13] }))
    expect(yoshiUnder(t)).toEqual({ 0x102: [0x1c8] })
    expect(yoshiNested(t)).toEqual({ 0x001: { 0x040: [0x0c8] } })
    expect(bonusSlots(t)).toEqual([0x000, 0x100])
  })

  it('lists it under both roots when two roots reach it', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x001: [5], 0x002: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8], 0x002: [0x0c8] })
  })

  // Every column of three periods, not one: only column 1 of 4 gives wings.
  it.each(Array.from({ length: 12 }, (_, x) => x))(
    'a block at column %i links only at mod 4 = 1',
    x => {
      const r = rom()
      const t = wingsTree(r, seamsFor(r, { 0x001: [x] }))
      expect(Object.keys(yoshiUnder(t)).length).toBe(x % 4 === 1 ? 1 : 0)
      expect(bonusSlots(t)).toEqual(
        x % 4 === 1 ? [0x000, 0x100, 0x1c8] : [0x000, 0x0c8, 0x100, 0x1c8],
      )
    },
  )

  it('takes the wings column from the spawn, so another column links when the ROM says so', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x001: [2] }, 2))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8] })
  })

  it('leaves Yoshi Heaven in bonus when no map holds the block', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, {}))
    expect(yoshiUnder(t)).toEqual({})
    expect(bonusSlots(t)).toEqual([0x000, 0x0c8, 0x100, 0x1c8])
    expect(t.wingsPlaced).toEqual([])
  })

  it('refuses with a note when the touch or animation code is not stock, and the tree is as before', () => {
    const r = rom()
    const seams = seamsFor(r, { 0x001: [1] })
    const at = WINGS_PATH[2]![0] + 3
    r.writeAt(at, [r.readByte(at)! ^ 0xff])
    const t = wingsTree(r, seams)
    expect(yoshiUnder(t)).toEqual({})
    expect(bonusSlots(t)).toEqual([0x000, 0x0c8, 0x100, 0x1c8])
    expect(t.notes.join(' ')).toMatch(/Yoshi wings: .*not stock/)
  })

  it('refuses with a note when the spawn is refused', () => {
    const r = rom()
    const t = wingsTree(r, { ...seamsFor(r, { 0x001: [1] }), spawn: () => 'no free slot' })
    expect(yoshiUnder(t)).toEqual({})
    expect(t.notes.join(' ')).toMatch(/Yoshi wings: the item block spawn was refused: no free slot/)
  })

  it('turns a failing grid read into a note with the reason, never a silent no-block', () => {
    const r = rom()
    const grid = (): never => {
      throw new Error('vertical table gone')
    }
    const t = wingsTree(r, { ...seamsFor(r, { 0x001: [1] }), grid })
    expect(yoshiUnder(t)).toEqual({})
    expect(bonusSlots(t)).toEqual([0x000, 0x0c8, 0x100, 0x1c8])
    expect(t.notes.join(' ')).toMatch(/Yoshi wings: could not be read \(vertical table gone\)/)
  })

  it('keeps the root flag, not the screen-exit operand, as the half: operand 0 files $0C8 for a submap root', () => {
    const r = wingsRom({ 0x101: [] })
    r.writeAt(0x05d7d1, [0x00]) // the screen exit's high byte immediate (bank_05.asm:7109)
    const t = wingsTree(r, seamsFor(r, { 0x101: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x101: [0x0c8] })
  })

  const noteOf = (t: ReturnType<typeof wingsTree>) =>
    t.notes.filter(n => n.startsWith('Yoshi wings:')).join(' | ')
  const SECONDARY = 'a secondary screen exit, which the game sends through a table that is not read'

  it('refuses a lone holder with a secondary screen exit, in plain words, and says Yoshi Heaven stays', () => {
    const r = wingsRom({ 0x001: [0x040], 0x040: [], 0x002: [] }, [0x001])
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(t)).toEqual({})
    expect(bonusSlots(t)).toContain(0x0c8)
    expect(noteOf(t)).toBe(
      `Yoshi wings: $001 holds the wings block but has ${SECONDARY}, so it is not linked. Yoshi Heaven stays listed as a bonus map.`,
    )
  })

  it('does not say Yoshi Heaven stays when another root links it, and uses the plural for two holders', () => {
    const r = wingsRom({ 0x001: [0x040], 0x040: [0x041], 0x041: [], 0x002: [] }, [0x001, 0x040])
    const t = wingsTree(r, seamsFor(r, { 0x001: [1], 0x002: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x002: [0x0c8] })
    expect(bonusSlots(t)).not.toContain(0x0c8)
    expect(noteOf(t)).toBe(
      `Yoshi wings: $001 holds the wings block but has ${SECONDARY}, so it is not linked.`,
    )
    const two = wingsRom({ 0x001: [0x040], 0x040: [], 0x002: [0x041], 0x041: [] }, [0x001, 0x002])
    const both = wingsTree(two, seamsFor(two, { 0x001: [1], 0x002: [1] }))
    expect(noteOf(both)).toContain('$001, $002 hold the wings block but have')
  })

  it('links a plain holder under the same root as a secondary one, without the stays tail', () => {
    const r = wingsRom({ 0x001: [0x040, 0x041], 0x040: [0x042], 0x041: [], 0x042: [] }, [0x040])
    const t = wingsTree(r, seamsFor(r, { 0x040: [1], 0x041: [1] }))
    expect(yoshiNested(t)).toEqual({ 0x001: { 0x041: [0x0c8] } })
    expect(noteOf(t)).toBe(
      `Yoshi wings: $040 holds the wings block but has ${SECONDARY}, so it is not linked.`,
    )
  })

  it.each([
    ['a plain exit', [] as number[]],
    ['a secondary exit', [0x002]],
  ])('refuses a holder whose stream has no terminator (%s), with a note', (_what, secondary) => {
    const r = wingsRom(secondary.length ? { 0x002: [0x040], 0x040: [] } : { 0x002: [] }, secondary)
    // The $FF that ends the stream: after the 3-byte leaf or the 4-byte exit, past the 5-byte header.
    const end = new SmwRom(r).getLevelL1Pointer(0x002)! + 5 + (secondary.length ? 4 : 3)
    expect(r.readByte(end)).toBe(0xff)
    // Not a bare zero: zeros parse as further exits and the next room's $FF would end the walk. Filler objects that are no exit, past the read window.
    r.writeAt(end, new Array(0x2100).fill(0x01))
    const t = wingsTree(r, seamsFor(r, { 0x002: [1] }))
    expect(yoshiUnder(t)).toEqual({})
    expect(noteOf(t)).toBe(
      'Yoshi wings: $002 holds the wings block but has object data that could not be read to its end, so its exits are unknown, so it is not linked. Yoshi Heaven stays listed as a bonus map.',
    )
  })

  it('drops a link already made when a later root fails to read', () => {
    const r = rom()
    const grid = seamsFor(r, { 0x001: [1] }).grid!
    const later = (slot: number): number[][] | null => {
      if (slot === 0x002) throw new Error('second root failed')
      return grid(slot)
    }
    const t = wingsTree(r, { ...seamsFor(r, {}), grid: later })
    expect(yoshiUnder(t)).toEqual({})
    expect(t.wingsPlaced).toEqual([])
    expect(bonusSlots(t)).toContain(0x0c8)
    expect(noteOf(t)).toMatch(/could not be read \(second root failed\)/)
  })

  it('does not follow Yoshi Heaven own exits: a map only it reaches stays Unassigned', () => {
    const r = wingsRom({ 0x001: [], 0x0c8: [0x050], 0x050: [] })
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8] })
    expect(t.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([0x0c8])
    expect(t.unassigned.map(n => n.index)).toContain(0x050)
  })

  it('marks a row only under the root whose own wings link placed it', () => {
    // $001 reaches $0C8 by a plain exit; $002 holds the block, so only $002's wings link places it.
    const r = wingsRom({ 0x001: [0x0c8], 0x002: [] })
    const across = wingsTree(r, seamsFor(r, { 0x002: [1] }))
    expect(yoshiUnder(across)).toEqual({ 0x002: [0x0c8] })
    expect(across.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([
      0x0c8,
    ])
    // staleSlots is meant to span roots: the slot is placed by some root's link.
    expect(across.wingsPlaced).toEqual([0x0c8])
  })

  it('keeps the mark when the same root reaches the slot by an exit and by the wings', () => {
    // The wings are one of the ways into $0C8 from this root, so the row says so; the exit does not undo it.
    const r = wingsRom({ 0x001: [0x0c8], 0x002: [] })
    const same = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(same)).toEqual({ 0x001: [0x0c8] })
    expect(same.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([0x0c8])
    expect(same.wingsPlaced).toEqual([0x0c8])
  })

  it('does not link when the exit graph is unavailable', () => {
    const r = rom()
    r.writeAt(0x05d7cb, [0xea]) // the screen exit high byte code is not stock: the graph declines
    expect(yoshiUnder(wingsTree(r, seamsFor(r, { 0x001: [1] })))).toEqual({})
  })

  it('with the stock path digest, a synthetic ROM is refused with a note', () => {
    const t = buildMapTree(new SmwRom(rom()), SYNTHETIC_FINGERPRINTS)
    expect(t.notes.join(' ')).toMatch(/Yoshi wings: .*not stock/)
    expect(t.wingsPlaced).toEqual([])
  })
})

describe('groups keep the nested Yoshi Heaven row (#1295)', () => {
  const groups = [{ name: 'G', slots: [0x101] }]
  const r = wingsRom({ 0x101: [0x140], 0x140: [] })
  const t = wingsTree(r, seamsFor(r, { 0x140: [1] }))

  it('carries the sub area, and the row under it, into the group whole', () => {
    const g = applyGroups(t, groups).groups[0]!.maps[0]!
    expect(g.children.map(c => [c.index, c.children.map(k => k.index)])).toEqual([[0x140, [0x1c8]]])
    expect(staleSlots(t, [...groups, { name: 'H', slots: [0x1c8] }])).toEqual([])
  })

  it('lists every map once per place it belongs, and the row is not a top-level entry', () => {
    const { unassigned } = applyGroups(t, groups)
    expect(unassigned.map(n => n.index)).not.toContain(0x101)
    expect(unassigned.map(n => n.index)).not.toContain(0x1c8)
    expect(topLevelSlots(t).has(0x1c8)).toBe(false)
  })
})

describe('an older groups.json that still names Yoshi Heaven', () => {
  const groups = [{ name: 'Yoshi Heaven', slots: [0x0c8, 0x1c8] }]

  it('reports no stale slot for what the link placed, keeps the entry, and shows an empty folder', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x001: [1], 0x102: [1] }))
    expect(t.wingsPlaced).toEqual([0x0c8, 0x1c8])
    expect(staleSlots(t, groups)).toEqual([])
    expect(applyGroups(t, groups).groups).toEqual([{ name: 'Yoshi Heaven', maps: [] }])
    // Saving groups keeps the old entry: it was on disk already.
    const topLevel = topLevelSlots(t)
    expect(admitGroups(groups, { status: 'ok', groups }, topLevel)).toEqual({ status: 'ok' })
  })

  it('is narrow: a slot the link did not place stays stale', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(staleSlots(t, [{ name: 'x', slots: [0x0c8, 0x299] }])).toEqual([0x299])
    expect(staleSlots(wingsTree(r, seamsFor(r, {})), groups)).toEqual([]) // both halves are bonus maps then
  })
})
