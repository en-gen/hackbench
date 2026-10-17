import { describe, expect, it } from 'vitest'
import { levelSpriteList } from '../../support/levelSpriteList'

// Synthetic bytes: header byte 1 low 5 bits are the level mode; table entry bit 0 = vertical.
const rawL1 = (mode: number): Uint8Array => Uint8Array.from([0, mode, 0, 0, 0, 0])
const table = Array.from({ length: 32 }, (_, i) => (i === 0x0a ? 1 : 0))
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
})
