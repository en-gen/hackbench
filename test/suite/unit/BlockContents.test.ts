/**
 * BlockContents: item-block content resolver over acts-like $111-$12D.
 * Tables are built here as synthetic bytes in the ROM's layout (selector
 * byte = content id << 1 | progressive); the expectations are written out
 * per tile from the trace in docs/rom/block-contents.md, not derived from
 * the code under test. CI has no ROM; the corpus check at the bottom only
 * proves the loader reads the same layout from a real ROM.
 */

import { describe, expect, it } from 'vitest'
import {
  cycleColumn,
  FIRST_ITEM_BLOCK,
  LAST_ITEM_BLOCK,
  readBlockContentTables,
  resolveBlockContents,
  type BlockContentTables,
} from '../../../src/rom/BlockContents'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

// Selector byte per index (tile - $111), 36 entries. 0 = no item.
const SELECTOR = [
  0x80, 0x00, 0x00, 0x1e, 0x00, 0x00, 0x05, 0x09, 0x06, 0x81, 0x0e, 0x0c, 0x14, 0x00, 0x05, 0x09,
  0x06, 0x07, 0x0e, 0x0c, 0x16, 0x18, 0x1a, 0x1a, 0x00, 0x09, 0x00, 0x00, 0xff, 0x0c, 0x0a, 0x00,
  0x00, 0x00, 0x08, 0x02,
]
// Column cycles: first half period-3 [$05,$09,$06], second half [$07,$0a,$10].
const CYCLE = Array.from({ length: 32 }, (_, i) =>
  i < 16 ? [0x05, 0x09, 0x06][i % 3] : [0x07, 0x0a, 0x10][(i - 16) % 3],
)
const SPRITES = [
  0x00, 0x74, 0x75, 0x76, 0x77, 0x78, 0x00, 0x00, 0x79, 0x00, 0x3e, 0x7d, 0x2c, 0x04, 0x81, 0x45,
  0x80,
]
const STATUS = [0, 8, 8, 8, 8, 8, 0, 0, 8, 0, 9, 8, 9, 9, 8, 8, 9]

const TABLES: BlockContentTables = {
  selector: Uint8Array.from(SELECTOR),
  columnCycle: Uint8Array.from(CYCLE),
  spriteInBlock: Uint8Array.from(SPRITES),
  statusOfSprInBlk: Uint8Array.from(STATUS),
  columnOverride: Uint8Array.from([0x80, 0x7e, 0x7d, 0x09]),
  columnOverrideStatus: Uint8Array.from([0x09, 0x08, 0x08, 0xa4]),
}

const resolve = (tile: number, col = 0) => resolveBlockContents(tile, col, TABLES)!

// Expected condition string per tile, for column-independent tiles.
const FIXED: Record<number, string> = {
  0x112: 'Nothing',
  0x113: 'Nothing',
  0x114: 'Directional coins',
  0x115: 'Nothing',
  0x116: 'Nothing',
  0x117: 'Mushroom if Mario is small, otherwise Fire Flower',
  0x118: 'Mushroom if Mario is small, otherwise Feather',
  0x119: 'Star',
  0x11b: 'Multiple coins',
  0x11c: 'Coin',
  0x11d: 'P-switch',
  0x11e: 'Nothing',
  0x11f: 'Mushroom if Mario is small, otherwise Fire Flower',
  0x120: 'Mushroom if Mario is small, otherwise Feather',
  0x121: 'Star',
  0x122: 'Star if Mario is invincible, otherwise Coin',
  0x123: 'Multiple coins',
  0x124: 'Coin',
  0x126: 'Yoshi egg',
  0x127: 'Green Koopa shell',
  0x128: 'Green Koopa shell',
  0x129: 'Nothing',
  0x12a: 'Mushroom if Mario is small, otherwise Feather',
  0x12b: 'Nothing',
  0x12c: 'Nothing',
  0x12d: 'Coin if fewer than 30 coins are collected, otherwise 1-up',
}

describe('resolveBlockContents', () => {
  it('covers every tile $111-$12D and refuses the rest', () => {
    const covered = new Set<number>([0x111, 0x11a, 0x125, ...Object.keys(FIXED).map(Number)])
    for (let t = FIRST_ITEM_BLOCK; t <= LAST_ITEM_BLOCK; t++) expect(covered.has(t)).toBe(true)
    expect(covered.size).toBe(LAST_ITEM_BLOCK - FIRST_ITEM_BLOCK + 1)
    expect(resolveBlockContents(0x110, 0, TABLES)).toBeNull()
    expect(resolveBlockContents(0x12e, 0, TABLES)).toBeNull()
  })

  it.each(Object.entries(FIXED))('tile $%s reads "%s"', (tile, text) => {
    const hex = Number(tile)
    // Column-independent: every column gives the same answer.
    for (let col = 0; col < 32; col++) expect(resolve(hex, col).condition).toBe(text)
  })

  it('$117 is a progressive Fire Flower block, not a turn block', () => {
    const r = resolve(0x117)
    expect(r.progressive).toEqual({ small: 0x74, big: 0x75 })
    expect(r.spriteIds).toEqual([0x74, 0x75])
  })

  it('progressive feather and flower tiles pair the mushroom with the item', () => {
    for (const t of [0x118, 0x120, 0x12a])
      expect(resolve(t).progressive).toEqual({ small: 0x74, big: 0x77 })
    expect(resolve(0x11f).progressive).toEqual({ small: 0x74, big: 0x75 })
    expect(resolve(0x119).progressive).toBeNull()
  })

  it('content 7 is multi-coin and content 6 plain coin, with no sprite', () => {
    for (const t of [0x11b, 0x123]) {
      const r = resolve(t)
      expect(r.multiCoin).toBe(true)
      expect(r.spriteIds).toEqual([])
      expect(r.alternatives[0].content.kind).toBe('multiCoin')
    }
    for (const t of [0x11c, 0x124]) {
      const r = resolve(t)
      expect(r.multiCoin).toBe(false)
      expect(r.alternatives[0].content.kind).toBe('coin')
    }
  })

  it('$111 cycles Fire Flower, Feather, Star over every column, wrapping at 16', () => {
    const want = [
      'Mushroom if Mario is small, otherwise Fire Flower (X column 1 of 3)',
      'Mushroom if Mario is small, otherwise Feather (X column 2 of 3)',
      'Star (X column 3 of 3)',
    ]
    for (let col = 0; col < 48; col++)
      expect(resolve(0x111, col).condition).toBe(want[(col % 16) % 3])
  })

  it('$11A cycles star-or-coin, 1-up, Vine over every column', () => {
    const want = [
      'Star if Mario is invincible, otherwise Coin (X column 1 of 3)',
      '1-up (X column 2 of 3)',
      'Vine (X column 3 of 3)',
    ]
    for (let col = 0; col < 48; col++)
      expect(resolve(0x11a, col).condition).toBe(want[(col % 16) % 3])
    expect(resolve(0x11a, 1).spriteIds).toEqual([0x78])
  })

  it('$125 cycles Key, Flying red coin, Balloon, Koopa by column mod 4', () => {
    const want = [0x80, 0x7e, 0x7d, 0x09]
    for (let col = 0; col < 16; col++) {
      const r = resolve(0x125, col)
      expect(r.spriteIds).toEqual([want[col % 4]])
      expect(r.caveat).toContain('layer 2')
    }
    expect(resolve(0x125, 0).alternatives[0].content).toMatchObject({ status: 9 })
    expect(resolve(0x125, 3).caveat).toBe(
      'reads past DATA_0288D6; spawn status $A4 has no handler; on layer 2 the item depends on scroll position',
    )
    expect(resolve(0x125, 2).caveat).not.toContain('DATA_0288D6')
  })

  it('reports shell and egg spawn status from the status table', () => {
    expect(resolve(0x127).alternatives[0].content).toMatchObject({ sprite: 0x04, status: 9 })
    expect(resolve(0x126).alternatives[0].content).toMatchObject({ sprite: 0x2c, status: 9 })
  })

  it('follows the table, not a hardcoded layout (planted selector change)', () => {
    const sel = Uint8Array.from(SELECTOR)
    sel[0x11c - FIRST_ITEM_BLOCK] = 0x0e // coin -> multi-coin
    const r = resolveBlockContents(0x11c, 0, { ...TABLES, selector: sel })!
    expect(r.multiCoin).toBe(true)
  })

  it('cycleColumn only reports the three cycling tiles', () => {
    expect(cycleColumn(0x111, 17)).toEqual({ index: 1, of: 3 })
    expect(cycleColumn(0x125, 6)).toEqual({ index: 2, of: 4 })
    expect(cycleColumn(0x117, 0)).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('readBlockContentTables (corpus)', () => {
  it('reads the same layout the synthetic tables use', () => {
    const t = readBlockContentTables(freshRom())
    expect(Array.from(t.selector)).toEqual(SELECTOR)
    expect(Array.from(t.columnCycle)).toEqual(CYCLE)
    expect(Array.from(t.spriteInBlock)).toEqual(SPRITES)
    expect(Array.from(t.statusOfSprInBlk)).toEqual(STATUS)
    expect(Array.from(t.columnOverride)).toEqual(Array.from(TABLES.columnOverride))
    expect(Array.from(t.columnOverrideStatus)).toEqual(Array.from(TABLES.columnOverrideStatus))
  })
})
