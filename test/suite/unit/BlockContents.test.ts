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
const SPRITE_COPY = [
  0x00, 0x74, 0x75, 0x76, 0x77, 0x78, 0x00, 0x00, 0x79, 0x00, 0x3e, 0x7d, 0x2c, 0x04, 0x81, 0x45,
  0x80,
]
// The ROM keeps two identical copies back to back; the second is read when Yoshi is loose.
const SPRITES = [...SPRITE_COPY, ...SPRITE_COPY]
const STATUS = [0, 8, 8, 8, 8, 8, 0, 0, 8, 0, 9, 8, 9, 9, 8, 8, 9]

const TABLES: BlockContentTables = {
  selector: Uint8Array.from(SELECTOR),
  columnCycle: Uint8Array.from(CYCLE),
  spriteInBlock: Uint8Array.from(SPRITES),
  statusOfSprInBlk: Uint8Array.from(STATUS),
  columnOverride: Uint8Array.from([0x80, 0x7e, 0x7d, 0x09]),
  columnOverrideStatus: Uint8Array.from([0x09, 0x08, 0x08, 0xa4]),
  pSwitchAttribute: Uint8Array.from([0x06, 0x02]),
  eggContents: Uint8Array.from([0x35, 0x78]),
  greenStarCoins: 30,
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
  0x11e: 'Nothing',
  0x11f: 'Mushroom if Mario is small, otherwise Fire Flower',
  0x120: 'Mushroom if Mario is small, otherwise Feather',
  0x121: 'Star',
  0x122: 'Star if Mario is invincible, otherwise Coin',
  0x123: 'Multiple coins',
  0x124: 'Coin',
  0x126: 'Yoshi egg (Yoshi, or 1-up if a baby Yoshi exists or Yoshi is loose)',
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
    const covered = new Set<number>([0x111, 0x11a, 0x11d, 0x125, ...Object.keys(FIXED).map(Number)])
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

  it('$11D P-switch is blue on even columns and silver on odd, with the layer 2 caveat', () => {
    for (let col = 0; col < 16; col++) {
      const r = resolve(0x11d, col)
      expect(r.condition).toBe(col % 2 === 0 ? 'P-switch (blue)' : 'P-switch (silver)')
      expect(r.alternatives[0].content).toMatchObject({ attribute: col % 2 === 0 ? 0x06 : 0x02 })
      expect(r.caveat).toBe('on layer 2 the item depends on scroll position')
    }
  })

  it('green star threshold comes from the table; a missing one is worded without a number', () => {
    expect(resolve(0x12d).condition).toContain('fewer than 30 coins')
    const twelve = resolveBlockContents(0x12d, 0, { ...TABLES, greenStarCoins: 12 })!
    expect(twelve.condition).toContain('fewer than 12 coins')
    const none = resolveBlockContents(0x12d, 0, { ...TABLES, greenStarCoins: null })!
    expect(none.condition).toContain('counter is above zero')
  })

  it('a hack table with a zero sprite degrades to Nothing, never throws', () => {
    const sprites = Uint8Array.from(SPRITES)
    sprites[1] = sprites[18] = 0 // mushroom slot: a progressive block keeps only its item
    const noMushroom = { ...TABLES, spriteInBlock: sprites }
    expect(resolveBlockContents(0x117, 0, noMushroom)!.condition).toBe('Fire Flower')
    sprites[3] = sprites[20] = 0 // star slot
    expect(resolveBlockContents(0x119, 0, noMushroom)!.condition).toBe('Nothing')
    const zero = { ...TABLES, columnOverride: Uint8Array.from([0, 0, 0, 0]) }
    for (let col = 0; col < 4; col++)
      expect(resolveBlockContents(0x125, col, zero)!.condition.startsWith('Nothing')).toBe(true)
    const empty = { ...TABLES, columnCycle: new Uint8Array(0) }
    expect(resolveBlockContents(0x111, 0, empty)!.condition).toBe('Nothing')
  })

  it('a content id of $11 or more reads the contiguous bytes, as the ROM does', () => {
    const sel = Uint8Array.from(SELECTOR)
    sel[0x113 - FIRST_ITEM_BLOCK] = 0x13 << 1 // content $13 = second-copy index 2 = Fire Flower
    sel[0x112 - FIRST_ITEM_BLOCK] = 0x3f << 1 // far past both copies
    const t = { ...TABLES, selector: sel }
    expect(resolveBlockContents(0x113, 0, t)!.spriteIds).toEqual([0x75])
    expect(resolveBlockContents(0x112, 0, t)!.condition).toBe('Nothing')
  })

  it('a differing second SpriteInBlock copy adds a Yoshi is loose alternative; identical adds none', () => {
    expect(resolve(0x119).alternatives).toHaveLength(1)
    const sprites = Uint8Array.from(SPRITES)
    sprites[17 + 3] = 0x77 // loose: star slot gives a feather
    const r = resolveBlockContents(0x119, 0, { ...TABLES, spriteInBlock: sprites })!
    expect(r.condition).toBe('Feather if Yoshi is loose, otherwise Star')
    expect(r.spriteIds).toEqual([0x77, 0x76])
  })

  it('the egg condition reads its contents from DATA_0288A1', () => {
    const eggs = Uint8Array.from([0x75, 0x76])
    const r = resolveBlockContents(0x126, 0, { ...TABLES, eggContents: eggs })!
    expect(r.condition).toBe(
      'Yoshi egg (Fire Flower, or Star if a baby Yoshi exists or Yoshi is loose)',
    )
  })

  describe('plants in every table are followed (kills hardcoded tables)', () => {
    it('DATA_00F100: a period-5 cycle changes items, the column text and the period', () => {
      const cycle = Uint8Array.from(CYCLE)
      for (let i = 0; i < 16; i++) cycle[i] = [0x05, 0x09, 0x06, 0x0a, 0x10][i % 5]
      const t = { ...TABLES, columnCycle: cycle }
      const want = [
        'Mushroom if Mario is small, otherwise Fire Flower (X column 1 of 5)',
        'Mushroom if Mario is small, otherwise Feather (X column 2 of 5)',
        'Star (X column 3 of 5)',
        '1-up (X column 4 of 5)',
        'Vine (X column 5 of 5)',
      ]
      for (let col = 0; col < 16; col++)
        expect(resolveBlockContents(0x111, col, t)!.condition).toBe(want[col % 5])
    })

    it('DATA_00F100: a half with no period drops the "n of p" text', () => {
      const cycle = Uint8Array.from(CYCLE)
      cycle.set([5, 9, 6, 10, 16, 5, 9, 9, 6, 10, 16, 5, 6, 9, 10, 16])
      const r = resolveBlockContents(0x111, 7, { ...TABLES, columnCycle: cycle })!
      expect(r.condition).toBe('Mushroom if Mario is small, otherwise Feather')
    })

    it('DATA_00F100: the second half is read for $11A, not the first', () => {
      const cycle = Uint8Array.from(CYCLE)
      cycle.fill(0x0a, 16)
      const r = resolveBlockContents(0x11a, 5, { ...TABLES, columnCycle: cycle })!
      expect(r.condition).toBe('1-up')
    })

    it('SpriteInBlock: a changed sprite id reaches every user of that slot', () => {
      const sprites = Uint8Array.from(SPRITES)
      sprites[0x0f] = 0x76 // directional-coin slot now spawns a star
      sprites[0x0f + 17] = 0x76
      const r = resolveBlockContents(0x114, 0, { ...TABLES, spriteInBlock: sprites })!
      expect(r.spriteIds).toEqual([0x76])
    })

    it('StatusOfSprInBlk: a changed status is reported', () => {
      const status = Uint8Array.from(STATUS)
      status[0x0d] = 0x0b
      const r = resolveBlockContents(0x127, 0, { ...TABLES, statusOfSprInBlk: status })!
      expect(r.alternatives[0].content).toMatchObject({ sprite: 0x04, status: 0x0b })
    })

    it('DATA_0288D6 and DATA_0288D9: changed bytes change the $125 sprite and status per column', () => {
      const t = {
        ...TABLES,
        columnOverride: Uint8Array.from([0x76, 0x77, 0x78, 0x79]),
        columnOverrideStatus: Uint8Array.from([0x0a, 0x0b, 0x0c, 0x0d]),
      }
      for (let col = 0; col < 4; col++) {
        const c = resolveBlockContents(0x125, col, t)!.alternatives[0].content
        expect(c).toMatchObject({ sprite: 0x76 + col, status: 0x0a + col })
      }
      expect(resolveBlockContents(0x125, 3, t)!.caveat).toContain('$D has no handler')
    })

    it('the balloon rewrite follows the spawned sprite, not the tile', () => {
      const sel = Uint8Array.from(SELECTOR)
      sel[0x119 - FIRST_ITEM_BLOCK] = 0x16 // content $B (sprite $7D) on a different tile
      const r = resolveBlockContents(0x119, 1, { ...TABLES, selector: sel })!
      expect(r.spriteIds).toEqual([0x7e])
    })
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
    expect(Array.from(t.spriteInBlock.subarray(0, SPRITES.length))).toEqual(SPRITES)
    expect(Array.from(t.statusOfSprInBlk.subarray(0, STATUS.length))).toEqual(STATUS)
    expect(Array.from(t.pSwitchAttribute)).toEqual([0x06, 0x02])
    expect(Array.from(t.eggContents)).toEqual([0x35, 0x78])
    expect(t.greenStarCoins).toBe(30)
    expect(Array.from(t.columnOverride)).toEqual(Array.from(TABLES.columnOverride))
    expect(Array.from(t.columnOverrideStatus)).toEqual(Array.from(TABLES.columnOverrideStatus))
  })
})
