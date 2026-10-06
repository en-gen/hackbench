/**
 * BlockContents: item-block content resolver over acts-like $111-$12D.
 *
 * The unit tests run on MADE-UP tables (no vanilla bytes are committed; see
 * docs/testing.md). They use the ROM's layout (selector = content id << 1 |
 * progressive, bit 7 = column lookup) and the sprite ids the code treats
 * specially ($3E, $2C, $7D), but every other id, status, cycle and tile
 * assignment differs from vanilla, so a resolver that hardcodes vanilla fails.
 * Vanilla's decoded answers are asserted only in the corpus-gated block.
 */

import { describe, expect, it } from 'vitest'
import {
  cycleColumn,
  FIRST_ITEM_BLOCK,
  isUnavailable,
  LAST_ITEM_BLOCK,
  PSWITCH_COLOURS,
  readBlockContentTables,
  resolveBlockContents,
  type BlockContentTables,
} from '../../../src/rom/BlockContents'
import { RomFile } from '../../../src/rom/RomFile'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

// Made-up tile assignment (not vanilla's). Tiles not listed hold nothing.
const ASSIGN: Record<number, number> = {
  0x111: 0x80, // column lookup, first half (period 4)
  0x112: 0x05, // progressive, content 2
  0x113: 0x09, // progressive, content 4
  0x114: 0x06, // plain content 3
  0x115: 0x0e, // content 7: multi-coin
  0x116: 0x0c, // content 6: coin
  0x117: 0x1c, // content 14: the P-switch sprite
  0x118: 0x20, // content 16: the balloon sprite, rewritten by column
  0x119: 0x12, // content 9: the egg sprite
  0x11a: 0x1a, // content 13
  0x11b: 0x1e, // content 15
  0x11c: 0x07, // progressive content 3
  0x11d: 0xff, // counter block
  0x11e: 0x81, // column lookup, second half (period 2)
  0x11f: 0x0a, // content 5
  0x120: 0x10, // content 8
}
const SELECTOR = Array.from({ length: 36 }, (_, i) => ASSIGN[FIRST_ITEM_BLOCK + i] ?? 0)
// First half: period 4; second half: period 2.
const CYCLE = Array.from({ length: 32 }, (_, i) =>
  i < 16 ? [0x05, 0x0a, 0x07, 0x0c][i % 4] : [0x09, 0x10][i % 2],
)
// Content id -> sprite; the second copy is read when Yoshi is loose.
const SPRITE_COPY = [
  0x00, 0x41, 0x42, 0x43, 0x46, 0x47, 0x00, 0x00, 0x48, 0x2c, 0x57, 0x58, 0x59, 0x51, 0x3e, 0x52,
  0x7d,
]
// Padded to the span the loader reads, so every id the ROM could index is present.
const SPRITES = [...SPRITE_COPY, ...SPRITE_COPY, ...new Array(0xa0 - 34).fill(0)]
const STATUS = [...SPRITE_COPY.map((_, i) => 0x20 + i), ...new Array(0x80 - 17).fill(0)]

const TABLES: BlockContentTables = {
  selector: Uint8Array.from(SELECTOR),
  columnCycle: Uint8Array.from(CYCLE),
  spriteInBlock: Uint8Array.from(SPRITES),
  statusOfSprInBlk: Uint8Array.from(STATUS),
  columnOverride: Uint8Array.from([0x61, 0x62, 0x63, 0x64]),
  columnOverrideStatus: Uint8Array.from([0x0a, 0x0b, 0x0c, 0x0d]),
  pSwitchAttribute: Uint8Array.from([0x04, 0x0c]),
  eggContents: Uint8Array.from([0x53, 0x54]),
  greenStarCoins: 7,
}

const resolve = (tile: number, col = 0) => resolveBlockContents(tile, col, TABLES)!
const SMALL = 'Sprite $41 if Mario is small, otherwise'

// Column-independent expectations; tiles with columns or colours follow below.
const FIXED: Record<number, string> = {
  0x112: `${SMALL} Sprite $42`,
  0x113: `${SMALL} Sprite $46`,
  0x114: 'Sprite $43',
  0x115: 'Multiple coins',
  0x116: 'Coin',
  0x119: 'Yoshi egg (Sprite $53, or Sprite $54 if a baby Yoshi exists or Yoshi is loose)',
  0x11a: 'Sprite $51',
  0x11b: 'Sprite $52',
  0x11c: 'Sprite $43 if Mario is invincible, otherwise Coin',
  0x11d: 'Coin if fewer than 7 coins are collected, otherwise Sprite $47',
  0x11f: 'Sprite $47',
  0x120: 'Sprite $48',
}
const NOTHING = Array.from({ length: 13 }, (_, i) => 0x121 + i)
const COLUMNED = [0x111, 0x117, 0x118, 0x11e]

describe('resolveBlockContents', () => {
  it('covers every tile $111-$12D and refuses the rest', () => {
    const covered = new Set<number>([...COLUMNED, ...NOTHING, ...Object.keys(FIXED).map(Number)])
    for (let t = FIRST_ITEM_BLOCK; t <= LAST_ITEM_BLOCK; t++) expect(covered.has(t)).toBe(true)
    expect(covered.size).toBe(LAST_ITEM_BLOCK - FIRST_ITEM_BLOCK + 1)
    expect(resolveBlockContents(0x110, 0, TABLES)).toBeNull()
    expect(resolveBlockContents(0x12e, 0, TABLES)).toBeNull()
  })

  it.each(Object.entries(FIXED))('tile $%s reads "%s" in every column', (tile, text) => {
    for (let col = 0; col < 32; col++) expect(resolve(Number(tile), col).condition).toBe(text)
  })

  it('tiles with no content read Nothing and carry no sprite', () => {
    for (const t of NOTHING) {
      expect(resolve(t).condition).toBe('Nothing')
      expect(resolve(t).alternatives).toEqual([])
    }
  })

  it('a progressive block pairs the small item with the big item; others do not', () => {
    expect(resolve(0x112).progressive).toEqual({ small: 0x41, big: 0x42 })
    expect(resolve(0x112).spriteIds).toEqual([0x41, 0x42])
    expect(resolve(0x113).progressive).toEqual({ small: 0x41, big: 0x46 })
    expect(resolve(0x114).progressive).toBeNull()
    expect(resolve(0x11c).progressive).toBeNull() // star-or-coin is not a size pair
  })

  it('content 7 is multi-coin and content 6 plain coin, with no sprite', () => {
    expect(resolve(0x115).multiCoin).toBe(true)
    expect(resolve(0x115).spriteIds).toEqual([])
    expect(resolve(0x115).alternatives[0].content.kind).toBe('multiCoin')
    expect(resolve(0x116).multiCoin).toBe(false)
    expect(resolve(0x116).alternatives[0].content.kind).toBe('coin')
  })

  it('a column-lookup tile follows a period-4 cycle over every column, wrapping at 16', () => {
    const want = [
      `${SMALL} Sprite $42 (X column 1 of 4)`,
      'Sprite $47 (X column 2 of 4)',
      'Sprite $43 if Mario is invincible, otherwise Coin (X column 3 of 4)',
      'Coin (X column 4 of 4)',
    ]
    for (let col = 0; col < 48; col++)
      expect(resolve(0x111, col).condition).toBe(want[(col % 16) % 4])
  })

  it('the second half is a different table: a period-2 cycle', () => {
    for (let col = 0; col < 48; col++) {
      const r = resolve(0x11e, col)
      expect(r.condition).toBe(
        (col & 15) % 2 === 0
          ? `${SMALL} Sprite $46 (X column 1 of 2)`
          : 'Sprite $48 (X column 2 of 2)',
      )
    }
  })

  it('the balloon sprite is rewritten per column mod 4, with status and caveats', () => {
    const want = [0x61, 0x62, 0x63, 0x64]
    for (let col = 0; col < 16; col++) {
      const r = resolve(0x118, col)
      expect(r.spriteIds).toEqual([want[col % 4]])
      expect(r.condition).toBe(
        `Sprite $${want[col % 4].toString(16)} (X column ${(col % 4) + 1} of 4)`,
      )
      expect(r.alternatives[0].content).toMatchObject({ status: 0x0a + (col % 4) })
      expect(r.caveat).toContain('layer 2')
    }
    expect(resolve(0x118, 3).caveat).toBe(
      'reads past DATA_0288D6; spawn status $D has no handler; on layer 2 the item depends on scroll position',
    )
    expect(resolve(0x118, 2).caveat).not.toContain('DATA_0288D6')
  })

  it('the P-switch sprite exposes its column-parity attribute and the layer 2 caveat', () => {
    for (let col = 0; col < 16; col++) {
      const r = resolve(0x117, col)
      expect(r.condition).toBe('P-switch')
      expect(r.alternatives[0].content).toMatchObject({ attribute: col % 2 === 0 ? 0x04 : 0x0c })
      expect(r.caveat).toBe('on layer 2 the item depends on scroll position')
    }
  })

  it('reports spawn status from the status table', () => {
    expect(resolve(0x11a).alternatives[0].content).toMatchObject({ sprite: 0x51, status: 0x2d })
    expect(resolve(0x119).alternatives[0].content).toMatchObject({ sprite: 0x2c, status: 0x29 })
  })

  it('green star threshold comes from the table; a missing one is worded without a number', () => {
    const twelve = resolveBlockContents(0x11d, 0, { ...TABLES, greenStarCoins: 12 })!
    expect(twelve.condition).toContain('fewer than 12 coins')
    expect(twelve.caveat).toBeUndefined()
    expect(resolve(0x11d).caveat).toBeUndefined()
    const none = resolveBlockContents(0x11d, 0, { ...TABLES, greenStarCoins: null })!
    expect(none.condition).toContain("this block's coin countdown")
    expect(none.caveat).toBe('the green star counter was not read')
    const own = { ...TABLES, greenStarCoins: null, greenStarCoinsReason: 'why not' }
    expect(resolveBlockContents(0x11d, 0, own)!.caveat).toBe('why not')
  })

  it('a hack table with a zero sprite degrades to Nothing, never throws', () => {
    const sprites = Uint8Array.from(SPRITES)
    sprites[1] = sprites[18] = 0 // first-item slot: a progressive block keeps only its item
    const noFirst = { ...TABLES, spriteInBlock: sprites }
    expect(resolveBlockContents(0x112, 0, noFirst)!.condition).toBe(
      'Nothing if Mario is small, otherwise Sprite $42',
    )
    sprites[3] = sprites[20] = 0
    expect(resolveBlockContents(0x114, 0, noFirst)!.condition).toBe('Nothing')
    const zero = { ...TABLES, columnOverride: Uint8Array.from([0, 0, 0, 0]) }
    for (let col = 0; col < 4; col++)
      expect(resolveBlockContents(0x118, col, zero)!.condition.startsWith('Nothing')).toBe(true)
  })

  it('an empty branch of a progressive outcome keeps its condition', () => {
    const sprites = Uint8Array.from(SPRITES)
    sprites[2] = sprites[19] = 0 // the big item of tile $112
    const noItem = { ...TABLES, spriteInBlock: sprites }
    const r = resolveBlockContents(0x112, 0, noItem)!
    expect(r.condition).toBe(`${SMALL} nothing`)
    expect(r.spriteIds).toEqual([0x41])
    expect(r.progressive).toBeNull()
    // The star-or-coin tile: the star branch is empty, the coin branch stays.
    sprites[3] = sprites[20] = 0
    expect(resolveBlockContents(0x11c, 0, noItem)!.condition).toBe(
      'Nothing if Mario is invincible, otherwise Coin',
    )
    // Both branches empty is a block with nothing.
    sprites[1] = sprites[18] = 0
    expect(resolveBlockContents(0x112, 0, noItem)!.condition).toBe('Nothing')
  })

  it('a content id of $11 or more reads the contiguous bytes, as the ROM does', () => {
    const sel = Uint8Array.from(SELECTOR)
    sel[0x113 - FIRST_ITEM_BLOCK] = 0x13 << 1 // second-copy index 2
    sel[0x112 - FIRST_ITEM_BLOCK] = 0x3f << 1 // far past both copies
    const t = { ...TABLES, selector: sel }
    expect(resolveBlockContents(0x113, 0, t)!.spriteIds).toEqual([0x42])
    expect(resolveBlockContents(0x112, 0, t)!.condition).toBe('Nothing')
  })

  it('a differing second SpriteInBlock copy adds a Yoshi is loose alternative; identical adds none', () => {
    expect(resolve(0x114).alternatives).toHaveLength(1)
    const sprites = Uint8Array.from(SPRITES)
    sprites[17 + 3] = 0x46
    const r = resolveBlockContents(0x114, 0, { ...TABLES, spriteInBlock: sprites })!
    expect(r.condition).toBe('Sprite $46 if Yoshi is loose, otherwise Sprite $43')
    expect(r.spriteIds).toEqual([0x46, 0x43])
  })

  it('the egg condition reads its contents from the egg table', () => {
    const eggs = Uint8Array.from([0x42, 0x43])
    const r = resolveBlockContents(0x119, 0, { ...TABLES, eggContents: eggs })!
    expect(r.condition).toBe(
      'Yoshi egg (Sprite $42, or Sprite $43 if a baby Yoshi exists or Yoshi is loose)',
    )
  })

  it('a counter that starts at 0 gives the 1-up at once', () => {
    const r = resolveBlockContents(0x11d, 0, { ...TABLES, greenStarCoins: 0 })!
    expect(r.condition).toBe('Sprite $47')
  })

  it('an empty 1-up keeps the coin under its condition; a start of 0 with no 1-up is Nothing', () => {
    const sprites = Uint8Array.from(SPRITES)
    sprites[5] = sprites[22] = 0 // the 1-up slot, both copies
    const t = { ...TABLES, spriteInBlock: sprites }
    const r = resolveBlockContents(0x11d, 0, t)!
    expect(r.condition).toBe('Coin if fewer than 7 coins are collected, otherwise nothing')
    expect(r.alternatives).toHaveLength(2)
    expect(r.alternatives[0].when).toBe('fewer than 7 coins are collected')
    expect(resolveBlockContents(0x11d, 0, { ...t, greenStarCoins: 0 })!.condition).toBe('Nothing')
  })

  it('a cycle period between 8 and 15 is reported', () => {
    const vals = [0x05, 0x0a, 0x07, 0x0c, 0x09, 0x10, 0x06, 0x0a, 0x0c] // period 9
    const cycle = Uint8Array.from(CYCLE)
    for (let i = 0; i < 16; i++) cycle[i] = vals[i % 9]
    const text: Record<number, string> = {
      0x05: `${SMALL} Sprite $42`,
      0x0a: 'Sprite $47',
      0x07: 'Sprite $43 if Mario is invincible, otherwise Coin',
      0x0c: 'Coin',
      0x09: `${SMALL} Sprite $46`,
      0x10: 'Sprite $48',
      0x06: 'Sprite $43',
    }
    for (let col = 0; col < 48; col++) {
      const r = resolveBlockContents(0x111, col, { ...TABLES, columnCycle: cycle })!
      expect(r.condition).toBe(
        `${text[vals[(col & 15) % 9]]} (X column ${((col & 15) % 9) + 1} of 9)`,
      )
    }
  })

  it('special sprites are keyed on the sprite, so ordinary ids in the vanilla slots stay ordinary', () => {
    const sel = Uint8Array.from(SELECTOR)
    for (const [tile, content] of [
      [0x121, 10],
      [0x122, 11],
      [0x123, 12],
    ]) {
      sel[tile - FIRST_ITEM_BLOCK] = content << 1
    }
    const t = { ...TABLES, selector: sel }
    for (const [tile, id] of [
      [0x121, 0x57],
      [0x122, 0x58],
      [0x123, 0x59],
    ]) {
      for (let col = 0; col < 4; col++) {
        const r = resolveBlockContents(tile, col, t)!
        expect(r.condition).toBe(`Sprite $${id.toString(16)}`)
        expect(r.caveat).toBeUndefined()
      }
    }
  })

  it('P-switch colour names follow the exported attribute table, even blue and odd silver', () => {
    expect(PSWITCH_COLOURS).toEqual({ 0x06: 'blue', 0x02: 'silver' })
    const key = (name: string): number =>
      Number(Object.entries(PSWITCH_COLOURS).find(([, v]) => v === name)![0])
    const t = { ...TABLES, pSwitchAttribute: Uint8Array.from([key('blue'), key('silver')]) }
    for (let col = 0; col < 8; col++)
      expect(resolveBlockContents(0x117, col, t)!.condition).toBe(
        col % 2 === 0 ? 'P-switch (blue)' : 'P-switch (silver)',
      )
  })

  describe('a short hand-built table is refused, never defaulted', () => {
    const refused = (tile: number, col: number, t: Partial<BlockContentTables>) => {
      const r = resolveBlockContents(tile, col, { ...TABLES, ...t } as BlockContentTables)
      expect(isUnavailable(r)).toBe(true)
      if (!isUnavailable(r)) throw new Error('expected a refusal')
      return r
    }

    it('selector, cycle and sprite tables', () => {
      expect(refused(0x116, 0, { selector: new Uint8Array(3) }).unavailable).toMatch(/DATA_00F080/)
      expect(refused(0x111, 0, { columnCycle: new Uint8Array(0) }).unavailable).toMatch(
        /DATA_00F100/,
      )
      expect(refused(0x112, 0, { spriteInBlock: new Uint8Array(2) }).unavailable).toMatch(
        /SpriteInBlock/,
      )
      expect(refused(0x112, 0, { statusOfSprInBlk: new Uint8Array(2) }).unavailable).toMatch(
        /StatusOfSprInBlk/,
      )
    })

    it('rewrite, attribute and egg tables, only when the sprite needs them', () => {
      expect(refused(0x118, 2, { columnOverride: new Uint8Array(2) }).unavailable).toMatch(
        /DATA_0288D6/,
      )
      expect(refused(0x118, 3, { columnOverrideStatus: new Uint8Array(3) }).unavailable).toMatch(
        /DATA_0288D9/,
      )
      expect(refused(0x117, 1, { pSwitchAttribute: new Uint8Array(1) }).unavailable).toMatch(
        /DATA_028A42/,
      )
      expect(refused(0x119, 0, { eggContents: new Uint8Array(1) }).unavailable).toMatch(
        /DATA_0288A1/,
      )
      // Reads are lazy: a table a tile never touches, or an index it never reaches, may be short.
      const lazy = (tile: number, col: number, t: Partial<BlockContentTables>): void => {
        const r = resolveBlockContents(tile, col, { ...TABLES, ...t } as BlockContentTables)
        expect(isUnavailable(r)).toBe(false)
        expect(r).not.toBeNull()
      }
      lazy(0x117, 0, { pSwitchAttribute: Uint8Array.from([0x04]) }) // reads [0] only
      lazy(0x112, 0, { pSwitchAttribute: new Uint8Array(0) })
      lazy(0x112, 0, { columnOverride: new Uint8Array(0), columnOverrideStatus: new Uint8Array(0) })
      lazy(0x118, 0, {
        columnOverride: Uint8Array.from([0x61]),
        columnOverrideStatus: Uint8Array.from([0x0a]),
      }) // column 0 reads index 0 of each
      // A tile that never touches the egg table does not care that it is short.
      const ok = resolveBlockContents(0x112, 0, { ...TABLES, eggContents: new Uint8Array(0) })
      expect(isUnavailable(ok)).toBe(false)
    })

    it('a half of DATA_00F100 cut short refuses even in a column inside the table', () => {
      const eight = new Uint8Array(CYCLE.slice(0, 8))
      expect(refused(0x111, 3, { columnCycle: eight }).unavailable).toMatch(/DATA_00F100/)
      const short = new Uint8Array(CYCLE.slice(0, 24)) // first half whole, second cut
      expect(refused(0x11e, 0, { columnCycle: short }).unavailable).toMatch(/DATA_00F100/)
      // 20 bytes: column 0..3 of the second half are inside the table, the rest of the half is not.
      const twenty = new Uint8Array(CYCLE.slice(0, 20))
      for (let col = 0; col < 4; col++)
        expect(refused(0x11e, col, { columnCycle: twenty }).unavailable).toMatch(/DATA_00F100/)
      expect(isUnavailable(resolveBlockContents(0x111, 3, { ...TABLES, columnCycle: short }))).toBe(
        false,
      )
    })

    it('isUnavailable accepts resolver results, including null', () => {
      expect(isUnavailable(null)).toBe(false)
      expect(isUnavailable(resolve(0x112))).toBe(false)
    })
  })

  describe('plants in every table are followed (kills hardcoded tables)', () => {
    it('the selector: a changed byte changes the tile', () => {
      const sel = Uint8Array.from(SELECTOR)
      sel[0x116 - FIRST_ITEM_BLOCK] = 0x0e // coin -> multi-coin
      expect(resolveBlockContents(0x116, 0, { ...TABLES, selector: sel })!.multiCoin).toBe(true)
    })

    it('the cycle: a period-5 first half changes items, the column text and the period', () => {
      const cycle = Uint8Array.from(CYCLE)
      for (let i = 0; i < 16; i++) cycle[i] = [0x05, 0x09, 0x06, 0x0a, 0x10][i % 5]
      const t = { ...TABLES, columnCycle: cycle }
      const want = [
        `${SMALL} Sprite $42 (X column 1 of 5)`,
        `${SMALL} Sprite $46 (X column 2 of 5)`,
        'Sprite $43 (X column 3 of 5)',
        'Sprite $47 (X column 4 of 5)',
        'Sprite $48 (X column 5 of 5)',
      ]
      for (let col = 0; col < 48; col++)
        expect(resolveBlockContents(0x111, col, t)!.condition).toBe(want[(col & 15) % 5])
    })

    it('the cycle: a half with no period drops the "n of p" text', () => {
      const cycle = Uint8Array.from(CYCLE)
      cycle.set([5, 9, 6, 10, 16, 5, 9, 9, 6, 10, 16, 5, 6, 9, 10, 16])
      const r = resolveBlockContents(0x111, 7, { ...TABLES, columnCycle: cycle })!
      expect(r.condition).toBe(`${SMALL} Sprite $46`)
    })

    it('the cycle: the second half is read when the selector bit says so', () => {
      const cycle = Uint8Array.from(CYCLE)
      cycle.fill(0x0a, 16)
      const r = resolveBlockContents(0x11e, 5, { ...TABLES, columnCycle: cycle })!
      expect(r.condition).toBe('Sprite $47')
    })

    it('SpriteInBlock: a changed sprite id reaches every user of that slot', () => {
      const sprites = Uint8Array.from(SPRITES)
      sprites[0x0f] = sprites[0x0f + 17] = 0x76
      const r = resolveBlockContents(0x11b, 0, { ...TABLES, spriteInBlock: sprites })!
      expect(r.spriteIds).toEqual([0x76])
    })

    it('StatusOfSprInBlk: a changed status is reported', () => {
      const status = Uint8Array.from(STATUS)
      status[0x0d] = 0x0b
      const r = resolveBlockContents(0x11a, 0, { ...TABLES, statusOfSprInBlk: status })!
      expect(r.alternatives[0].content).toMatchObject({ sprite: 0x51, status: 0x0b })
    })

    it('the column rewrite tables: changed sprite and status bytes are followed per column', () => {
      const t = {
        ...TABLES,
        columnOverride: Uint8Array.from([0x76, 0x77, 0x78, 0x79]),
        columnOverrideStatus: Uint8Array.from([0x1a, 0x1b, 0x1c, 0x1d]),
      }
      for (let col = 0; col < 4; col++) {
        const c = resolveBlockContents(0x118, col, t)!.alternatives[0].content
        expect(c).toMatchObject({ sprite: 0x76 + col, status: 0x1a + col })
      }
      expect(resolveBlockContents(0x118, 3, t)!.caveat).toContain('$1D has no handler')
    })

    it('the balloon rewrite follows the spawned sprite, not the tile', () => {
      const sel = Uint8Array.from(SELECTOR)
      sel[0x114 - FIRST_ITEM_BLOCK] = 0x20 // the balloon's content on a different tile
      const r = resolveBlockContents(0x114, 1, { ...TABLES, selector: sel })!
      expect(r.spriteIds).toEqual([0x62])
    })

    it('the P-switch attribute table is followed', () => {
      const t = { ...TABLES, pSwitchAttribute: Uint8Array.from([0x30, 0x31]) }
      expect(resolveBlockContents(0x117, 0, t)!.alternatives[0].content).toMatchObject({
        attribute: 0x30,
      })
      expect(resolveBlockContents(0x117, 1, t)!.alternatives[0].content).toMatchObject({
        attribute: 0x31,
      })
    })
  })

  it('cycleColumn only reports the three cycling tiles', () => {
    expect(cycleColumn(0x111, 17)).toEqual({ index: 1, of: 3 })
    expect(cycleColumn(0x125, 6)).toEqual({ index: 2, of: 4 })
    expect(cycleColumn(0x117, 0)).toBeNull()
  })
})

function tablesOf(rom: RomFile): BlockContentTables {
  const t = readBlockContentTables(rom)
  if (isUnavailable(t)) throw new Error(t.unavailable)
  return t
}

// Loader tests on a synthetic LoROM image: bank b, address a lives at b * $8000 + (a & $7FFF).
describe('readBlockContentTables on a synthetic ROM', () => {
  const at = (bank: number, addr: number): number => bank * 0x8000 + (addr & 0x7fff)
  const mark = (bank: number, addr: number): number =>
    ((bank * 0x1f + addr) * 7 + (addr >> 4)) & 0xff
  const COUNTER = [0xd0, 0x05, 0xa9, 0x2a, 0x8d, 0xc0, 0x0d]
  function image(...counterAt: number[]): RomFile {
    const bytes = new Uint8Array(0x20000)
    bytes[0x7fd5] = 0x20 // LoROM map mode
    for (let a = 0xf000; a < 0xf200; a++) bytes[at(0, a)] = mark(0, a)
    for (let a = 0x8800; a < 0x8b00; a++) bytes[at(2, a)] = mark(2, a)
    for (const off of counterAt) bytes.set(COUNTER, off)
    return RomFile.fromBytes('synthetic.sfc', bytes)
  }

  it('reads every table from its own address and length', () => {
    const t = tablesOf(image())
    const expectFrom = (got: Uint8Array, bank: number, addr: number, len: number): void => {
      expect(got.length).toBe(len)
      expect(Array.from(got)).toEqual(Array.from({ length: len }, (_, i) => mark(bank, addr + i)))
    }
    expectFrom(t.selector, 0, 0xf080, 36)
    expectFrom(t.columnCycle, 0, 0xf100, 32)
    expectFrom(t.spriteInBlock, 2, 0x88a3, 0xa0)
    expectFrom(t.statusOfSprInBlk, 2, 0x88c5, 0x80)
    expectFrom(t.columnOverride, 2, 0x88d6, 4)
    expectFrom(t.columnOverrideStatus, 2, 0x88d9, 4)
    expectFrom(t.pSwitchAttribute, 2, 0x8a42, 2)
    expectFrom(t.eggContents, 2, 0x88a1, 2)
  })

  it('a ROM that ends before a table refuses with a reason instead of reading zeros', () => {
    const bytes = new Uint8Array(0x10800) // bank 2 starts at $10000; $0288A3 is past the end
    bytes[0x7fd5] = 0x20
    const t = readBlockContentTables(RomFile.fromBytes('short.sfc', bytes))
    expect(isUnavailable(t)).toBe(true)
    if (!isUnavailable(t)) return
    expect(t.kind).toBe('unavailable')
    expect(t.unavailable).toMatch(/SpriteInBlock.*\$0288A3.*past the end/)
    const r = resolveBlockContents(0x112, 0, t)
    expect(r).toEqual(t)
  })

  it('a table cut short partway through is refused too', () => {
    const bytes = new Uint8Array(0x108f3) // $0288A3 is present; the 0xA0-byte table ends 0x50 bytes later
    bytes[0x7fd5] = 0x20
    const t = readBlockContentTables(RomFile.fromBytes('cut.sfc', bytes))
    expect(isUnavailable(t)).toBe(true)
    if (isUnavailable(t)) expect(t.unavailable).toMatch(/SpriteInBlock.*past the end/)
  })

  it('one counter site gives its operand', () => {
    expect(tablesOf(image(0x100)).greenStarCoins).toBe(0x2a)
  })

  it('two counter sites are ambiguous and give null with the reason', () => {
    const t = tablesOf(image(0x100, 0x300))
    expect(t.greenStarCoins).toBeNull()
    expect(t.greenStarCoinsReason).toMatch(/more than once/)
  })

  it('no counter site gives null', () => {
    const t = tablesOf(image())
    expect(t.greenStarCoins).toBeNull()
    expect(t.greenStarCoinsReason).toMatch(/not present/)
  })

  it('a bare store of the counter elsewhere does not make the site ambiguous', () => {
    const bytes = new Uint8Array(0x20000)
    bytes[0x7fd5] = 0x20
    bytes.set(COUNTER, 0x100)
    bytes.set([0xa9, 0x11, 0x8d, 0xc0, 0x0d], 0x400) // same load and store, no branch before it
    expect(tablesOf(RomFile.fromBytes('s.sfc', bytes)).greenStarCoins).toBe(0x2a)
  })
})

// Vanilla answers, decoded: item names, sprite ids, conditions. No raw bytes.
const OF_THREE = (a: string, b: string, c: string): string[] => [
  `${a} (X column 1 of 3)`,
  `${b} (X column 2 of 3)`,
  `${c} (X column 3 of 3)`,
]
const FLOWER = 'Mushroom if Mario is small, otherwise Fire Flower'
const FEATHER = 'Mushroom if Mario is small, otherwise Feather'
const VANILLA_FIXED: Record<number, [string, number[]]> = {
  0x112: ['Nothing', []],
  0x113: ['Nothing', []],
  0x114: ['Directional coins', [0x45]],
  0x115: ['Nothing', []],
  0x116: ['Nothing', []],
  0x117: [FLOWER, [0x74, 0x75]],
  0x118: [FEATHER, [0x74, 0x77]],
  0x119: ['Star', [0x76]],
  0x11b: ['Multiple coins', []],
  0x11c: ['Coin', []],
  0x11e: ['Nothing', []],
  0x11f: [FLOWER, [0x74, 0x75]],
  0x120: [FEATHER, [0x74, 0x77]],
  0x121: ['Star', [0x76]],
  0x122: ['Star if Mario is invincible, otherwise Coin', [0x76]],
  0x123: ['Multiple coins', []],
  0x124: ['Coin', []],
  0x126: ['Yoshi egg (Yoshi, or 1-up if a baby Yoshi exists or Yoshi is loose)', [0x2c]],
  0x127: ['Green Koopa shell', [0x04]],
  0x128: ['Green Koopa shell', [0x04]],
  0x129: ['Nothing', []],
  0x12a: [FEATHER, [0x74, 0x77]],
  0x12b: ['Nothing', []],
  0x12c: ['Nothing', []],
  0x12d: ['Coin if fewer than 30 coins are collected, otherwise 1-up', [0x78]],
}

describe.skipIf(!hasRom(VANILLA))('vanilla ROM: decoded contents of $111-$12D (corpus)', () => {
  // Lazy: a skipped suite's body still runs at collection time, with no ROM to load.
  let tables: BlockContentTables | undefined
  const at = (tile: number, col = 0) =>
    resolveBlockContents(tile, col, (tables ??= tablesOf(freshRom())))!

  it.each(Object.entries(VANILLA_FIXED))('tile $%s', (tile, [text, sprites]) => {
    for (let col = 0; col < 16; col++) {
      expect(at(Number(tile), col).condition).toBe(text)
      expect(at(Number(tile), col).spriteIds).toEqual(sprites)
    }
  })

  it('every vanilla tile is covered and the Yoshi-loose copy adds nothing', () => {
    const covered = new Set([...Object.keys(VANILLA_FIXED).map(Number), 0x111, 0x11a, 0x11d, 0x125])
    for (let tile = FIRST_ITEM_BLOCK; tile <= LAST_ITEM_BLOCK; tile++) {
      expect(covered.has(tile)).toBe(true)
      for (let col = 0; col < 16; col++)
        expect(at(tile, col).condition).not.toContain('Yoshi is loose and')
    }
  })

  it('$111 cycles Fire Flower, Feather, Star; $11A cycles star-or-coin, 1-up, Vine', () => {
    const a = OF_THREE(FLOWER, FEATHER, 'Star')
    const b = OF_THREE('Star if Mario is invincible, otherwise Coin', '1-up', 'Vine')
    for (let col = 0; col < 48; col++) {
      expect(at(0x111, col).condition).toBe(a[(col % 16) % 3])
      expect(at(0x11a, col).condition).toBe(b[(col % 16) % 3])
    }
    expect(at(0x117).progressive).toEqual({ small: 0x74, big: 0x75 })
    expect(at(0x11b).multiCoin).toBe(true)
    expect(at(0x11c).multiCoin).toBe(false)
  })

  it('$11D is a blue P-switch on even columns and silver on odd', () => {
    for (let col = 0; col < 16; col++) {
      expect(at(0x11d, col).condition).toBe(col % 2 === 0 ? 'P-switch (blue)' : 'P-switch (silver)')
      expect(at(0x11d, col).spriteIds).toEqual([0x3e])
    }
  })

  it('$125 gives Key, Flying red coin, Balloon, Green bouncing Koopa by column mod 4', () => {
    const want = [0x80, 0x7e, 0x7d, 0x09]
    for (let col = 0; col < 16; col++) expect(at(0x125, col).spriteIds).toEqual([want[col % 4]])
    expect(at(0x125, 0).alternatives[0].content).toMatchObject({ status: 9 })
    expect(at(0x125, 3).caveat).toContain('spawn status $A4 has no handler')
  })

  it('the shell and egg spawn as stationary (status 9)', () => {
    expect(at(0x127).alternatives[0].content).toMatchObject({ sprite: 0x04, status: 9 })
    expect(at(0x126).alternatives[0].content).toMatchObject({ sprite: 0x2c, status: 9 })
  })
})
