/**
 * Composing one bank's listing, on synthetic carts.
 *
 * What is at risk here is not the individual readers - each has its own
 * suite - but how their answers are joined: which bank gets map
 * attribution, what a shared song pointer looks like, and whether a
 * refusal says enough for someone to go and check it.
 *
 * Each assertion was proven able to fail by planting the matching defect
 * in src/rom/MusicCatalog.ts; the mutation list is in docs/testing.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { readMusicCatalog, MusicBankName } from '../../../src/rom/MusicCatalog'

/** (size % 1024) !== 512, so RomFile never reads this as copier-headered. */
const BUF_SIZE = 0x40000
const L1_TABLE_OFFSET = loromToOffset(ADDR.LEVEL_L1_PTR, BUF_SIZE)!
const off = (snes: number): number => loromToOffset(snes, BUF_SIZE)!

/** The stock call site and routine entry for each bank (bank_00.asm:145, 183). */
const SITES: Record<MusicBankName, { callSite: number; routine: number; guard?: number }> = {
  level: { callSite: 0x009702, routine: 0x008148, guard: 0x008134 },
  overworld: { callSite: 0x0096c3, routine: 0x00810e },
  credits: { callSite: 0x0094a0, routine: 0x008159 },
}

const BANK_ROM_ADDR = 0x038000
const ARAM_DEST = 0x1360

const uploadRoutine = (romAddr: number): number[] => [
  0xa9,
  romAddr & 0xff,
  0x8d,
  0x00,
  0x00,
  0xa9,
  (romAddr >> 8) & 0xff,
  0x8d,
  0x01,
  0x00,
  0xa9,
  (romAddr >> 16) & 0xff,
  0x8d,
  0x02,
  0x00,
]

const jsr = (target: number): number[] => [0x20, target & 0xff, (target >> 8) & 0xff]
const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]

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

/** A bank block: [size, aramDest] header, pointer table, then song data. */
function bankBlock(pointers: number[]): number[] {
  const data = pointers.length * 16
  return [
    ...u16(pointers.length * 2 + data),
    ...u16(ARAM_DEST),
    ...pointers.flatMap(u16),
    ...new Array(data).fill(0xaa),
  ]
}

/** Pointers for `count` songs whose table ends exactly where the data starts. */
const tidy = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => ARAM_DEST + count * 2 + i * 16)

interface Options {
  /** Song pointers for the bank's table. Defaults to four distinct songs. */
  pointers?: number[]
  /** Break the path so the bank cannot be located. */
  unreachable?: boolean
  /** Music slot per map slot; index is the map, value the 3-bit slot. */
  maps?: number[]
  /** Plant the level-header decode. */
  decode?: boolean
}

function buildRom(bank: MusicBankName, opts: Options = {}): SmwRom {
  const { pointers = tidy(4), unreachable = false, maps = [], decode = true } = opts
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20 // LoROM map mode

  const site = SITES[bank]
  if (!unreachable) {
    buf.set(jsr(site.guard ?? site.routine), off(site.callSite))
    if (site.guard) {
      // UploadLevelMusic: LDA.W abs : BNE +disp, landing on the routine
      // (bank_00.asm:166-167).
      const disp = site.routine - (site.guard + 5)
      buf.set([0xad, 0x00, 0x14, 0xd0, disp & 0xff], off(site.guard))
    }
    buf.set(uploadRoutine(BANK_ROM_ADDR), off(site.routine))
  }
  buf.set(bankBlock(pointers), off(BANK_ROM_ADDR))

  if (decode) buf.set(decodeSite(TABLE_AT), off(DECODE_AT))
  buf.set(STOCK_TABLE, off(TABLE_AT))

  const FILLER = 0x018000
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const music = maps[i]
    // Bank $04 from $8000: a real LoROM window, clear of the bank block at
    // $038000, the decode at $058549 and the pointer table at $05E000.
    const ptr = music === undefined ? FILLER : 0x048000 + i * 0x20
    const base = L1_TABLE_OFFSET + i * 3
    buf[base] = ptr & 0xff
    buf[base + 1] = (ptr >> 8) & 0xff
    buf[base + 2] = (ptr >> 16) & 0xff
    if (music !== undefined) {
      const o = loromToOffset(ptr, BUF_SIZE)
      if (o !== null) {
        buf[o + 2] = ((music & 0x07) << 4) | 0x0c
        buf[o + 5] = 0xff
      }
    }
  }
  return new SmwRom(new RomFile('fake.sfc', buf))
}

const ok = (r: ReturnType<typeof readMusicCatalog>) => {
  expect(r.status).toBe('ok')
  if (r.status !== 'ok') throw new Error('not ok')
  return r.bank
}

describe('readMusicCatalog', () => {
  it.each(['level', 'overworld', 'credits'] as MusicBankName[])(
    'lists the %s bank when its path verifies',
    bank => {
      const catalog = ok(readMusicCatalog(buildRom(bank), bank))

      expect(catalog.bank).toBe(bank)
      expect(catalog.romAddr).toBe(BANK_ROM_ADDR)
      expect(catalog.tracks.map(t => t.bgmCommand)).toEqual([1, 2, 3, 4])
    },
  )

  it.each(['level', 'overworld', 'credits'] as MusicBankName[])(
    'refuses the %s bank naming the call site that failed',
    bank => {
      const result = readMusicCatalog(buildRom(bank, { unreachable: true }), bank)

      expect(result.status).toBe('unavailable')
      if (result.status !== 'unavailable') return
      expect(result.bank).toBe(bank)
      // A refusal a reader can act on: it names the address to go and look at.
      expect(result.reason).toContain(
        bank === 'level' ? '$009702' : bank === 'overworld' ? '$0096C3' : '$0094A0',
      )
    },
  )

  it('groups commands that share one song pointer, excluding the command itself', () => {
    // The stock level bank does this twice: $0F with $10, and $04 with $16.
    const shared = ARAM_DEST + 8
    const catalog = ok(
      readMusicCatalog(
        buildRom('level', { pointers: [shared, ARAM_DEST + 24, shared, ARAM_DEST + 40] }),
        'level',
      ),
    )

    expect(catalog.tracks[0].sharedWith).toEqual([3])
    expect(catalog.tracks[2].sharedWith).toEqual([1])
    expect(catalog.tracks[1].sharedWith).toEqual([])
  })

  it('attributes maps to level-bank tracks', () => {
    // Slot 0 is BGM $02 in the stock table, so maps on slot 0 attach to
    // command 2. Four songs are listed, so command 2 exists in the bank.
    const catalog = ok(readMusicCatalog(buildRom('level', { maps: [0, 0, 1] }), 'level'))
    const track2 = catalog.tracks.find(t => t.bgmCommand === 2)!

    expect(track2.maps).toEqual([0, 1])
    expect(track2.levelSlots).toEqual([0])
    expect(catalog.attributionUnavailable).toBeUndefined()
  })

  it('leaves the overworld bank unattributed without calling that a gap', () => {
    // Level headers do not select overworld music - OverworldMusic does
    // (bank_04.asm:1214). Empty maps here is a fact, not a failure, so no
    // reason string should appear beside it.
    const catalog = ok(readMusicCatalog(buildRom('overworld', { maps: [0, 0, 1] }), 'overworld'))

    expect(catalog.tracks.every(t => t.maps.length === 0)).toBe(true)
    expect(catalog.tracks.every(t => t.levelSlots.length === 0)).toBe(true)
    expect(catalog.attributionUnavailable).toBeUndefined()
  })

  it('says why the level bank is unattributed when the decode is missing', () => {
    const catalog = ok(
      readMusicCatalog(buildRom('level', { maps: [0, 0], decode: false }), 'level'),
    )

    expect(catalog.tracks.every(t => t.maps.length === 0)).toBe(true)
    expect(catalog.attributionUnavailable).toMatch(/not found/i)
  })

  it('reports the block size from the block header', () => {
    const catalog = ok(readMusicCatalog(buildRom('level', { pointers: tidy(3) }), 'level'))

    expect(catalog.blockSize).toBe(3 * 2 + 3 * 16)
  })
})
