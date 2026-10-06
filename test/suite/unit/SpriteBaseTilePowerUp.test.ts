/**
 * #99: sprites $7D/$7E/$7F draw through PowerUpGfxRt, which indexes
 * PowerUpTiles by (sprite - $74). Synthetic expectations, no ROM.
 * SMWDisX bank_01.asm:9528-9530 (table), 9632-9637 (index).
 */
import { describe, it, expect } from 'vitest'
import { SPRITE_BASE_TILE_OVERRIDES } from '../../../src/rom/SpriteTileLoader'

describe('PowerUpGfxRt base tiles (#99)', () => {
  it.each([
    [0x7d, 0xe4],
    [0x7e, 0xe8],
    [0x7f, 0x24],
    [0x80, 0xec],
  ])('sprite $%s uses tile $%s', (id, tile) => {
    expect(SPRITE_BASE_TILE_OVERRIDES[id]).toBe(tile)
  })
})
