import { describe, expect, it } from 'vitest'
import { levelSpriteList } from '../../support/levelSpriteList'

// Synthetic bytes: header byte 1 low 5 bits are the level mode; table entry bit 0 = vertical.
const rawL1 = (mode: number): Uint8Array => Uint8Array.from([0, mode, 0, 0, 0, 0])
// Entry 1 and 3 have bit 0 (vertical); entry 2 has only bit 1 (layer 2 vertical), which must read
// horizontal for the sprite stream; every other mode, including nonzero $0C, is 0.
const ENTRY: Record<number, number> = { 0x0a: 1, 0x0b: 3, 0x0d: 2 }
const table = Array.from({ length: 32 }, (_, i) => ENTRY[i] ?? 0)
// header, then one sprite: YYYY=3 (b0 high nibble), screen 2, XXXX=5, id 0x10, then terminator.
const sprites = Uint8Array.from([0, 0x30, 0x52, 0x10, 0xff])

describe('levelSpriteList', () => {
  it('reads a vertical map with the vertical screen/x/y', () => {
    const [s] = levelSpriteList(sprites, rawL1(0x0a), table)
    expect({ x: s.x, y: s.y }).toEqual({ x: 3, y: 2 * 16 + 5 })
  })
  it('reads a horizontal map as before', () => {
    const [s] = levelSpriteList(sprites, rawL1(0x00), table)
    expect({ x: s.x, y: s.y }).toEqual({ x: 2 * 16 + 5, y: 3 })
  })
  it('sweeps all 32 level modes against the table: only bit 0 swaps X and Y', () => {
    const horiz = { x: 2 * 16 + 5, y: 3 }
    const vert = { x: 3, y: 2 * 16 + 5 }
    for (let mode = 0; mode < 32; mode++) {
      const [s] = levelSpriteList(sprites, rawL1(mode), table)
      const want = (table[mode] & 1) !== 0 ? vert : horiz
      expect({ mode, x: s.x, y: s.y }).toEqual({ mode, ...want })
    }
  })
  it('keeps $0C (nonzero, entry 0) and $0D (entry 2) horizontal', () => {
    for (const mode of [0x0c, 0x0d]) {
      const [s] = levelSpriteList(sprites, rawL1(mode), table)
      expect({ mode, x: s.x, y: s.y }).toEqual({ mode, x: 2 * 16 + 5, y: 3 })
    }
  })
})
