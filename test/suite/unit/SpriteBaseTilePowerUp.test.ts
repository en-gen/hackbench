/**
 * #99: sprites $74-$78 and $7D-$80 draw through PowerUpGfxRt, which indexes
 * PowerUpTiles by (sprite - $74). SMWDisX bank_01.asm:9528-9530 (table),
 * 9632-9637 (index). PowerUpTiles is at $01:C609 (SMW_U.sym:11159).
 *
 * The expectation is read from the ROM so a wrong index (say sprite - $73)
 * applied to the table cannot agree with itself. Vanilla only: hacks may
 * move the table. Evidence scope: one vanilla US ROM, static read.
 */
import { describe, it, expect } from 'vitest'
import { SPRITE_BASE_TILE_OVERRIDES } from '../../../src/rom/SpriteTileLoader'
import { VANILLA, freshRom, hasRom } from '../support/corpus'

const POWER_UP_TILES = 0x01c609
const IDS = [0x74, 0x75, 0x76, 0x77, 0x78, 0x7d, 0x7e, 0x7f, 0x80]
const hex = (n: number) => '$' + n.toString(16).toUpperCase()

describe.skipIf(!hasRom(VANILLA))('PowerUpGfxRt base tiles match PowerUpTiles (#99)', () => {
  it.each(IDS.map(id => [hex(id), id] as const))(
    'sprite %s is the PowerUpTiles entry at its id minus 0x74',
    (_n, id) => {
      const rom = freshRom(VANILLA)
      expect(SPRITE_BASE_TILE_OVERRIDES[id]).toBe(rom.readByte(POWER_UP_TILES + (id - 0x74)))
    },
  )
})

// Synthetic, no ROM: all nine ids pinned to the values the corpus block
// reads from the table, so a corpus-less run still goes red on a bad value.
describe('PowerUpGfxRt base tiles (#99), no ROM', () => {
  it.each(
    (
      [
        [0x74, 0x24],
        [0x75, 0x26],
        [0x76, 0x48],
        [0x77, 0x0e],
        [0x78, 0x24],
        [0x7d, 0xe4],
        [0x7e, 0xe8],
        [0x7f, 0x24],
        [0x80, 0xec],
      ] as const
    ).map(([id, tile]) => [hex(id), id, tile] as const),
  )('sprite %s has the PowerUpTiles tile', (_n, id, tile) => {
    expect(SPRITE_BASE_TILE_OVERRIDES[id]).toBe(tile)
  })
})
