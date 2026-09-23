/**
 * Which maps play which track, on synthetic carts.
 *
 * This is the attribution the panel shows next to each track, and it is the
 * part that works on every cartridge: the level-header decode survives
 * AddmusicK on all six carts in the corpus, even where the bank the track
 * data lives in does not.
 *
 * Filler slots are excluded. Vanilla's pointer table has 512 entries and
 * 277 of them share the filler pointer, so counting all 512 would report
 * the filler slot's music index 277 times and bury every real answer.
 *
 * Each assertion was proven able to fail by planting the matching defect in
 * src/rom/MusicData.ts; the mutation list is in docs/testing.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { readLevelMusicUsage } from '../../../src/rom/MusicData'

/** (size % 1024) !== 512, so RomFile never reads this as copier-headered. */
const BUF_SIZE = 0x40000
const L1_TABLE_OFFSET = loromToOffset(ADDR.LEVEL_L1_PTR, BUF_SIZE)!

/** TXA : LSR A x4 : AND #$07 : TAX : LDA.L table,X  (bank_05.asm:576-582) */
const decodeSite = (table: number): number[] => [
  0x8a,
  0x4a,
  0x4a,
  0x4a,
  0x4a,
  0x29,
  0x07,
  0xaa,
  0xbf,
  table & 0xff,
  (table >> 8) & 0xff,
  (table >> 16) & 0xff,
]

const DECODE_AT = 0x058549
const TABLE_AT = 0x0584db
const STOCK_TABLE = [0x02, 0x06, 0x01, 0x08, 0x07, 0x03, 0x05, 0x12]

const FILLER = 0x018000

interface Slot {
  /** 3-bit music index this map's header selects, or undefined for filler. */
  music?: number
}

/**
 * A cart whose slot 0..n-1 are real maps with the given music indices, and
 * whose remaining slots are filler.
 *
 * Each real map gets its own L1 pointer so none of them alias, and a header
 * whose byte 2 carries the music index in bits 6:4 and a sprite set in bits
 * 3:0 - the low nibble is set deliberately, because a decode that forgot to
 * shift would read it.
 */
function buildRom(slots: Slot[], table: number[] = STOCK_TABLE, decode = true): SmwRom {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20 // LoROM map mode

  if (decode) buf.set(decodeSite(TABLE_AT), loromToOffset(DECODE_AT, BUF_SIZE)!)
  buf.set(table, loromToOffset(TABLE_AT, BUF_SIZE)!)

  for (let i = 0; i < LEVEL_COUNT; i++) {
    const slot = slots[i]
    const ptr = slot?.music === undefined ? FILLER : 0x038000 + i * 0x20
    const base = L1_TABLE_OFFSET + i * 3
    buf[base] = ptr & 0xff
    buf[base + 1] = (ptr >> 8) & 0xff
    buf[base + 2] = (ptr >> 16) & 0xff

    if (slot?.music !== undefined) {
      const off = loromToOffset(ptr, BUF_SIZE)!
      // Byte 2: music in bits 6:4, sprite set $0C in bits 3:0.
      buf[off + 2] = ((slot.music & 0x07) << 4) | 0x0c
      buf[off + 5] = 0xff
    }
  }
  return new SmwRom(new RomFile('fake.sfc', buf))
}

/** n maps on music slot `music`, laid out from slot 0. */
const maps = (...music: number[]): Slot[] => music.map(m => ({ music: m }))

describe('readLevelMusicUsage', () => {
  it('counts real maps per music slot and ignores filler', () => {
    const usage = readLevelMusicUsage(buildRom(maps(0, 0, 3, 7)))

    expect(usage.realMapCount).toBe(4)
    expect(usage.mapsBySlot[0]).toEqual([0, 1])
    expect(usage.mapsBySlot[3]).toEqual([2])
    expect(usage.mapsBySlot[7]).toEqual([3])
    expect(usage.mapsBySlot[1]).toEqual([])
  })

  it('has one bucket per 3-bit slot, always', () => {
    const usage = readLevelMusicUsage(buildRom(maps(0)))

    expect(usage.mapsBySlot).toHaveLength(8)
  })

  it('maps slots onto BGM commands through the level music table', () => {
    // Slot 0 is BGM $02 and slot 3 is BGM $08 in the stock table.
    const usage = readLevelMusicUsage(buildRom(maps(0, 0, 3)))

    expect(usage.mapsByCommand.get(0x02)).toEqual([0, 1])
    expect(usage.mapsByCommand.get(0x08)).toEqual([2])
  })

  it('omits a command no map selects, rather than listing it with nothing', () => {
    // Slots 1-7 are unused here. An entry with an empty array would make
    // the panel show seven tracks that no map plays as though they were
    // attributed, and `mapsByCommand.size` would stop meaning anything.
    const usage = readLevelMusicUsage(buildRom(maps(0)))

    expect(usage.mapsByCommand.size).toBe(1)
    expect(usage.mapsByCommand.has(0x06)).toBe(false)
    expect([...usage.mapsByCommand.values()].every(m => m.length > 0)).toBe(true)
  })

  it('merges two slots that name the same command', () => {
    // A hack is free to point two of the eight slots at one track. Keeping
    // them separate would report the track as playing in half its maps.
    const table = [0x05, 0x05, 0x01, 0x08, 0x07, 0x03, 0x05, 0x12]
    const usage = readLevelMusicUsage(buildRom(maps(0, 1, 2), table))

    expect(usage.mapsByCommand.get(0x05)).toEqual([0, 1])
    expect(usage.mapsByCommand.get(0x01)).toEqual([2])
  })

  it('reads the music index from bits 6:4, not from the whole byte', () => {
    // The low nibble of header byte 2 is the sprite set (bank_05.asm:573).
    // A decode that skipped the shift would bucket by sprite set instead.
    const usage = readLevelMusicUsage(buildRom(maps(5)))

    expect(usage.mapsBySlot[5]).toEqual([0])
    expect(usage.mapsBySlot[0x0c & 0x07]).toEqual([])
  })

  it('reports no command attribution when the decode cannot be found', () => {
    // Without the decode, a slot names no command. The per-slot counts are
    // still real - they come from the headers - so they survive; only the
    // slot-to-command step is lost, and it says so rather than guessing.
    const usage = readLevelMusicUsage(buildRom(maps(0, 3), STOCK_TABLE, false))

    expect(usage.realMapCount).toBe(2)
    expect(usage.mapsBySlot[0]).toEqual([0])
    expect(usage.mapsByCommand.size).toBe(0)
    expect(usage.tableUnavailable).toMatch(/not found/i)
  })

  it('is silent about the table when it was read', () => {
    expect(readLevelMusicUsage(buildRom(maps(0))).tableUnavailable).toBeUndefined()
  })

  it('returns map slots ascending, so the panel can list them in order', () => {
    const slots: Slot[] = []
    slots[9] = { music: 2 }
    slots[3] = { music: 2 }
    slots[40] = { music: 2 }
    const usage = readLevelMusicUsage(buildRom(slots))

    expect(usage.mapsBySlot[2]).toEqual([3, 9, 40])
  })

  it('counts a cart with no real maps as none, not as filler', () => {
    const usage = readLevelMusicUsage(buildRom([]))

    expect(usage.realMapCount).toBe(0)
    expect(usage.mapsBySlot.every(s => s.length === 0)).toBe(true)
  })
})
