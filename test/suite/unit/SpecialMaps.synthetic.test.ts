/**
 * Characterisation tests for findSpecialMaps, built entirely from synthetic
 * carts so they run where CI actually runs: with test/roms/ absent.
 *
 * These were written BEFORE the byte-pattern scanner was extracted into
 * src/rom/BytePattern.ts, to pin the behaviour the extraction must not
 * change. The three things most at risk in that move are each asserted
 * directly rather than inferred:
 *
 *   - the copier header is SKIPPED, not scanned (the two scanners reached
 *     that by different routes, a subarray here and an index offset there)
 *   - the reported offset is CART-RELATIVE, so the SNES citation is the same
 *     string with and without a header
 *   - uniqueness is the verdict, and the match count is capped at 4
 *
 * Every assertion below was proven able to fail by planting a defect in
 * SpecialMaps.ts and re-running; see docs/testing.md for the mutation list.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { findSpecialMaps } from '../../../src/rom/SpecialMaps'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'

/** 512 KB, the vanilla cart size, so `hasCopierHeader` reads false. */
const CART_SIZE = 0x80000

/** LDA #imm : LDY #$00 : STA $0109   (bank_00.asm:2626) */
const titleSite = (imm: number): number[] => [0xa9, imm, 0xa0, 0x00, 0x8d, 0x09, 0x01]

/** LDA #imm : STA $0109              (bank_00.asm:3389) */
const newGameSite = (imm: number): number[] => [0xa9, imm, 0x8d, 0x09, 0x01]

/** The vanilla load sites, as file offsets: $00:96CB and $00:9CB0. */
const TITLE_AT = 0x16cb
const NEW_GAME_AT = 0x1cb0

/** `!MainMapLvls` offsets the stored value, so these name $0C7 and $0C5. */
const TITLE_IMM = 0xeb
const NEW_GAME_IMM = 0xe9

interface Plant {
  at: number
  bytes: number[]
}

/**
 * A zero-filled cart with the given byte runs planted at file offsets.
 * Zeros never match either pattern (both open with $A9), so nothing is
 * found except what the test puts there.
 */
function cart(...plants: Plant[]): Buffer {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode, so this reads as a real cart
  for (const { at, bytes } of plants) buf.set(bytes, at)
  return buf
}

const unheadered = (...plants: Plant[]): RomFile => new RomFile('synthetic.sfc', cart(...plants))

/** The same cart behind a 512-byte copier header, filled with $FF junk. */
function headered(headerBytes: number[] | null, ...plants: Plant[]): RomFile {
  const header = Buffer.alloc(COPIER_HEADER_SIZE, 0xff)
  if (headerBytes) header.set(headerBytes, 0x20)
  return new RomFile('synthetic.smc', Buffer.concat([header, cart(...plants)]))
}

const vanillaPlants = (): Plant[] => [
  { at: TITLE_AT, bytes: titleSite(TITLE_IMM) },
  { at: NEW_GAME_AT, bytes: newGameSite(NEW_GAME_IMM) },
]

describe('findSpecialMaps: reading the slot from the load site', () => {
  it('reads both immediates and cites where each was read', () => {
    const found = findSpecialMaps(unheadered(...vanillaPlants()))

    expect(found.maps).toEqual([
      { index: 0x0c7, role: 'title-screen', foundAt: '$00:96CB' },
      { index: 0x0c5, role: 'new-game', foundAt: '$00:9CB0' },
    ])
    expect(found.notes).toEqual([])
  })

  it('subtracts !MainMapLvls from the immediate rather than reporting it raw', () => {
    const found = findSpecialMaps(unheadered({ at: TITLE_AT, bytes: titleSite(0x30) }))

    expect(found.maps[0]!.index).toBe(0x30 - 0x24)
  })

  it('finds a load site in the final bytes of the cart', () => {
    const at = CART_SIZE - 5
    const found = findSpecialMaps(unheadered({ at, bytes: newGameSite(0x30) }))

    expect(found.maps).toEqual([{ index: 0x0c, role: 'new-game', foundAt: '$0F:FFFB' }])
  })
})

describe('findSpecialMaps: refusing rather than guessing', () => {
  it('reports the title screen unavailable when its loader is absent, and still reads the new game', () => {
    const found = findSpecialMaps(unheadered({ at: NEW_GAME_AT, bytes: newGameSite(NEW_GAME_IMM) }))

    expect(found.maps).toEqual([{ index: 0x0c5, role: 'new-game', foundAt: '$00:9CB0' }])
    expect(found.notes).toHaveLength(1)
    expect(found.notes[0]).toContain('Title screen')
    expect(found.notes[0]).toContain('not present in this ROM')
  })

  it('refuses a role whose pattern matches twice, naming the candidate count', () => {
    const found = findSpecialMaps(
      unheadered(
        { at: TITLE_AT, bytes: titleSite(TITLE_IMM) },
        { at: 0x2000, bytes: titleSite(TITLE_IMM) },
        { at: NEW_GAME_AT, bytes: newGameSite(NEW_GAME_IMM) },
      ),
    )

    expect(found.maps.map(m => m.role)).toEqual(['new-game'])
    expect(found.notes).toHaveLength(1)
    expect(found.notes[0]).toContain('Title screen: 2 candidate load sites')
  })

  it('stops counting candidates at 4, because uniqueness is the whole test', () => {
    const plants = [0, 1, 2, 3, 4, 5, 6].map(n => ({
      at: 0x2000 + n * 0x10,
      bytes: newGameSite(NEW_GAME_IMM),
    }))

    const found = findSpecialMaps(unheadered(...plants))

    expect(found.notes.join('\n')).toContain('New game: 4 candidate load sites')
  })

  it('refuses an immediate below !MainMapLvls instead of reporting a negative slot', () => {
    const found = findSpecialMaps(unheadered({ at: TITLE_AT, bytes: titleSite(0x10) }))

    expect(found.maps).toEqual([])
    expect(found.notes.join('\n')).toContain('out-of-range slot (16 - 36)')
  })

  it('reports both roles unavailable on a cart with neither load site', () => {
    const found = findSpecialMaps(unheadered())

    expect(found.maps).toEqual([])
    expect(found.notes).toHaveLength(2)
  })
})

describe('findSpecialMaps: the copier header', () => {
  it('reads a headered cart to the same slots and the same citations', () => {
    const found = findSpecialMaps(headered(null, ...vanillaPlants()))

    expect(found.maps).toEqual([
      { index: 0x0c7, role: 'title-screen', foundAt: '$00:96CB' },
      { index: 0x0c5, role: 'new-game', foundAt: '$00:9CB0' },
    ])
    expect(found.notes).toEqual([])
  })

  it('does not scan the header, so a pattern hidden there is neither found nor counted', () => {
    // A second apparent load site inside the header would, if scanned, make
    // the real one non-unique and lose the slot entirely.
    const found = findSpecialMaps(headered(newGameSite(0x77), ...vanillaPlants()))

    expect(found.maps).toEqual([
      { index: 0x0c7, role: 'title-screen', foundAt: '$00:96CB' },
      { index: 0x0c5, role: 'new-game', foundAt: '$00:9CB0' },
    ])
    expect(found.notes).toEqual([])
  })
})
