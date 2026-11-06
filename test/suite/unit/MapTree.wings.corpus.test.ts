/**
 * The wings link on the vanilla ROM (#1229). Needs the corpus; MapTree.wings.synthetic.test.ts
 * and YoshiWings.synthetic.test.ts carry the same rules without one.
 *
 * Evidence scope: the vanilla US ROM and its Lunar Magic resave, one machine. Static read plus
 * the game's own spawn run on the core; not played (see the PR).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { SmwRom, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapTree } from '../../../src/rom/MapTree'
import { holdsWings, wingsColumns } from '../../../src/rom/YoshiWings'
import {
  applyGroups,
  resolveGroups,
  staleSlots,
  type MapGroup,
} from '../../../src/project/MapGroups'
import { MAGIC, VANILLA, freshRom, hasRom } from '../support/corpus'
import { yoshiUnder } from '../support/wingsTree'

const YOSHI = [0x0c8, 0x1c8]

for (const name of [VANILLA, MAGIC]) {
  describe.skipIf(!hasRom(name))(`Yoshi wings on ${name}`, () => {
    let rom: SmwRom
    let tree: MapTree
    beforeAll(() => {
      rom = new SmwRom(freshRom(name))
      tree = buildMapTree(rom)
    })

    it('the spawn run gives the wings in column 1 of 4 and no other', () => {
      const c = wingsColumns(rom.rom)
      expect('columns' in c ? [...c.columns!] : c.note).toEqual([1])
    })

    it('exactly $00F, $12C and $1E3 hold the block, at the columns the issue names', () => {
      const cols = (wingsColumns(rom.rom) as { columns: ReadonlySet<number> }).columns
      const holders = Array.from({ length: LEVEL_COUNT }, (_, i) => i).filter(i =>
        holdsWings(rom, i, cols),
      )
      expect(holders).toEqual([0x00f, 0x12c, 0x1e3])
    })

    it('files Yoshi Heaven under $00F ($0C8) and under $115 and $12C ($1C8), not in bonus or Unassigned', () => {
      expect(yoshiUnder(tree)).toEqual({ 0x00f: [0x0c8], 0x115: [0x1c8], 0x12c: [0x1c8] })
      expect(tree.bonus.map(b => b.index)).toEqual([0x000, 0x100])
      expect(tree.unassigned.map(n => n.index)).not.toContain(0x0c8)
      expect(tree.unassigned.map(n => n.index)).not.toContain(0x1c8)
      expect(tree.notes.filter(n => /wings/i.test(n))).toEqual([])
    })

    // A new vanilla project is seeded on load (resolveGroups); the other two read an existing file.
    const seeded = (groups: MapGroup[] | 'seed'): { unassigned: number[]; stale: number[] } => {
      const decision = resolveGroups(
        { status: 'ok', groups: groups === 'seed' ? undefined : groups },
        true,
      )
      const list = decision.action === 'error' ? [] : decision.groups
      return {
        unassigned: applyGroups(tree, list).unassigned.map(n => n.index),
        stale: staleSlots(tree, list),
      }
    }

    it.each([
      ['a new project (the seed)', 'seed'],
      ['a groups.json that predates the seed (empty)', []],
      ['one that still names Yoshi Heaven', [{ name: 'Yoshi Heaven', slots: YOSHI }]],
    ] as const)(
      'neither Yoshi Heaven slot is Unassigned, and none is stale: %s',
      (_what, groups) => {
        const r = seeded(groups as MapGroup[] | 'seed')
        for (const s of YOSHI) expect(r.unassigned).not.toContain(s)
        expect(r.stale).toEqual([])
      },
    )
  })
}

// One change each to the vanilla path or the spawn's column rule: the link must refuse, with the note, never fall back to a stale answer.
const PLANTS: [string, number, number[]][] = [
  ['ProcessPlayerAnimation entry to RTS', 0x00c593, [0x60]],
  ['its JSL ExecutePtr operand', 0x00c596, [0x00]],
  ['the call site NOPed', 0x00c569, [0xea, 0xea, 0xea]],
  ['CODE_00D273 to RTS', 0x00d273, [0x60]],
  ['CODE_01F668 to RTS', 0x01f668, [0x60]],
  ['the rewrite mask AND #$30 changed to #$70', 0x0289ad, [0x70]],
]
describe.skipIf(!hasRom(VANILLA))('a changed wings path or column rule refuses', () => {
  it.each(PLANTS)('%s', (_what, at, bytes) => {
    const rom = freshRom(VANILLA)
    rom.writeAt(at, bytes)
    const tree = buildMapTree(new SmwRom(rom))
    expect(yoshiUnder(tree)).toEqual({})
    expect(tree.bonus.map(b => b.index).sort((a, b) => a - b)).toEqual([0x000, 0x0c8, 0x100, 0x1c8])
    expect(tree.notes.join(' ')).toMatch(/Yoshi wings: .*not stock/)
  })
})
