/**
 * decodeSubTileWord / encodeSubTileWord: the bit-packing for one Map16
 * subtile attribute word. The Map16 editor's write path decodes the word
 * currently in the cartridge, replaces one field, and re-encodes - so a
 * lossy or misaligned round trip here would corrupt every field the user
 * did NOT touch, not just the one they meant to change.
 */
import { describe, it, expect } from 'vitest'
import { decodeSubTileWord, encodeSubTileWord, SubTile } from '../../../src/rom/Map16'

describe('Map16 subtile word codec', () => {
  it('decodes each field from its documented bit range', () => {
    // charNum=$3FF (bits 0-9), palette=5 (bits 10-12), priority+flipX+flipY set
    const word = 0x3ff | (5 << 10) | (1 << 13) | (1 << 14) | (1 << 15)
    const sub = decodeSubTileWord(word)
    expect(sub).toEqual({
      charNum: 0x3ff,
      palette: 5,
      priority: true,
      flipX: true,
      flipY: true,
    })
  })

  it('decodes an all-zero word to every field off', () => {
    expect(decodeSubTileWord(0)).toEqual({
      charNum: 0,
      palette: 0,
      priority: false,
      flipX: false,
      flipY: false,
    })
  })

  it('round-trips every field independently through encode -> decode', () => {
    const base: SubTile = {
      charNum: 0x145,
      palette: 3,
      priority: false,
      flipX: true,
      flipY: false,
    }
    expect(decodeSubTileWord(encodeSubTileWord(base))).toEqual(base)

    const flipped: SubTile = { ...base, flipY: true, priority: true }
    expect(decodeSubTileWord(encodeSubTileWord(flipped))).toEqual(flipped)
  })

  it('encode masks each field to its own bit width rather than bleeding into a neighbour', () => {
    // An out-of-range charNum (11 bits) must not touch the palette field.
    const sub: SubTile = { charNum: 0x7ff, palette: 0, priority: false, flipX: false, flipY: false }
    const word = encodeSubTileWord(sub)
    expect(word & 0x3ff).toBe(0x3ff) // charNum clamped to its 10 bits
    expect((word >> 10) & 0x7).toBe(0) // palette untouched
  })

  it('bit 15 (flipY) survives the round trip - the whole reason Map16 needs the full 16-bit mask', () => {
    const word = encodeSubTileWord({
      charNum: 0,
      palette: 0,
      priority: false,
      flipX: false,
      flipY: true,
    })
    expect(word & 0x8000).toBe(0x8000)
    expect(decodeSubTileWord(word).flipY).toBe(true)
  })
})
