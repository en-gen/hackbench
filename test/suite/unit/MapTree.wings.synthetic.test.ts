/**
 * The wings link in the Maps tree (#1229): Yoshi Heaven lists under the root whose maps hold the
 * wings block, in that root's submap half. ROM-free; YoshiWings.synthetic.test.ts runs the spawn.
 */
import { describe, it, expect } from 'vitest'
import { buildMapTree } from '../../../src/rom/MapTree'
import { SmwRom } from '../../../src/rom/SmwRom'
import { applyGroups, admitGroups, staleSlots, topLevelSlots } from '../../../src/project/MapGroups'
import { WINGS_PATH } from '../../../src/rom/YoshiWings'
import { SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'
import { seamsFor, wingsRom, wingsTree, yoshiUnder } from '../support/wingsTree'

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
    expect(yoshiUnder(t)).toEqual({ 0x101: [0x1c8] })
    expect(bonusSlots(t)).toEqual([0x000, 0x0c8, 0x100])
  })

  it('serves two blocks in different submap halves, each its own destination', () => {
    const r = rom()
    const t = wingsTree(r, seamsFor(r, { 0x040: [9], 0x102: [13] }))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8], 0x102: [0x1c8] })
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

  it('refuses a holder with a secondary screen exit, names it, and still links a plain holder', () => {
    const exits = { 0x001: [0x040], 0x040: [], 0x002: [] }
    const r = wingsRom(exits, [0x001])
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(t)).toEqual({})
    expect(bonusSlots(t)).toContain(0x0c8)
    expect(t.notes.join(' ')).toMatch(
      /Yoshi wings: \$001 hold the wings block but have a secondary screen exit/,
    )
    const plain = wingsTree(r, seamsFor(r, { 0x001: [1], 0x002: [1] }))
    expect(yoshiUnder(plain)).toEqual({ 0x002: [0x0c8] })
  })

  it('does not follow Yoshi Heaven own exits: a map only it reaches stays Unassigned', () => {
    const r = wingsRom({ 0x001: [], 0x0c8: [0x050], 0x050: [] })
    const t = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(t)).toEqual({ 0x001: [0x0c8] })
    expect(t.overworld.find(n => n.index === 0x001)!.children.map(c => c.index)).toEqual([0x0c8])
    expect(t.unassigned.map(n => n.index)).toContain(0x050)
  })

  it('marks every row of a slot the wings reach, also one a screen exit reaches (same root, or another)', () => {
    const r = wingsRom({ 0x001: [0x0c8], 0x002: [] })
    const same = wingsTree(r, seamsFor(r, { 0x001: [1] }))
    expect(yoshiUnder(same)).toEqual({ 0x001: [0x0c8] })
    expect(same.wingsPlaced).toEqual([0x0c8])
    const across = wingsTree(r, seamsFor(r, { 0x002: [1] }))
    expect(yoshiUnder(across)).toEqual({ 0x001: [0x0c8], 0x002: [0x0c8] })
    expect(across.wingsPlaced).toEqual([0x0c8])
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
