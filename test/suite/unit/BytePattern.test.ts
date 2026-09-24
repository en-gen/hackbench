/**
 * The wildcard byte-pattern scanner shared by the ROM readers that locate a
 * routine by its instruction sequence rather than at a fixed address.
 *
 * Synthetic carts only: this needs no cartridge and so runs in CI, where
 * the corpus is absent by design.
 *
 * The contract worth stating twice is the offset convention. `findPattern`
 * returns CART-RELATIVE file offsets, the same thing `RomFile.readAtFileOffset`
 * takes, so a headered and an unheadered copy of the same cart report the same
 * offsets and the copier header is skipped rather than scanned. The two
 * scanners this replaces disagreed on exactly that, one stripping the header
 * with a subarray and the other indexing past it.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { WILD, BytePattern, findPattern } from '../../../src/rom/BytePattern'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'

const CART_SIZE = 0x10000

interface Plant {
  at: number
  bytes: number[]
}

function cart(...plants: Plant[]): Buffer {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  for (const { at, bytes } of plants) buf.set(bytes, at)
  return buf
}

const unheadered = (...plants: Plant[]): RomFile => new RomFile('synthetic.sfc', cart(...plants))

/** The same cart behind a copier header, optionally with bytes planted in it. */
function headered(headerBytes: number[] | null, ...plants: Plant[]): RomFile {
  const header = Buffer.alloc(COPIER_HEADER_SIZE, 0xff)
  if (headerBytes) header.set(headerBytes, 0x40)
  return new RomFile('synthetic.smc', Buffer.concat([header, cart(...plants)]))
}

/** LDA #imm : STA $2100 - an opcode, a wildcard operand, and a fixed tail. */
const PATTERN: BytePattern = [0xa9, WILD, 0x8d, 0x00, 0x21]
const site = (imm: number): number[] => [0xa9, imm, 0x8d, 0x00, 0x21]

describe('findPattern', () => {
  it('returns the cart-relative offset of each match, in ascending order', () => {
    const rom = unheadered({ at: 0x1234, bytes: site(0x10) }, { at: 0x0400, bytes: site(0x20) })

    expect(findPattern(rom, PATTERN)).toEqual([0x0400, 0x1234])
  })

  it('returns nothing when the pattern is absent', () => {
    expect(findPattern(unheadered(), PATTERN)).toEqual([])
  })

  it('lets WILD match any byte in that position', () => {
    const rom = unheadered({ at: 0x100, bytes: site(0x00) }, { at: 0x200, bytes: site(0xff) })

    expect(findPattern(rom, PATTERN)).toEqual([0x100, 0x200])
  })

  it('rejects a candidate that differs in a non-wild position', () => {
    // Same shape, but STA $2101 rather than $2100.
    const rom = unheadered({ at: 0x100, bytes: [0xa9, 0x10, 0x8d, 0x01, 0x21] })

    expect(findPattern(rom, PATTERN)).toEqual([])
  })

  it('finds a match that ends on the final byte of the cart', () => {
    const at = CART_SIZE - PATTERN.length
    expect(findPattern(unheadered({ at, bytes: site(0x10) }), PATTERN)).toEqual([at])
  })

  it('does not match a run that would extend past the end of the cart', () => {
    const rom = unheadered({ at: CART_SIZE - 2, bytes: [0xa9, 0x10] })

    expect(findPattern(rom, PATTERN)).toEqual([])
  })

  it('reports a headered cart at the same offsets as an unheadered one', () => {
    const plants: Plant[] = [{ at: 0x1234, bytes: site(0x10) }]

    expect(findPattern(headered(null, ...plants), PATTERN)).toEqual(
      findPattern(unheadered(...plants), PATTERN),
    )
  })

  it('does not scan the copier header', () => {
    const rom = headered(site(0x77), { at: 0x1234, bytes: site(0x10) })

    expect(findPattern(rom, PATTERN)).toEqual([0x1234])
  })

  it('returns every match when no limit is given', () => {
    const plants = [0, 1, 2, 3, 4, 5, 6].map(n => ({ at: 0x100 + n * 0x10, bytes: site(0x10) }))

    expect(findPattern(unheadered(...plants), PATTERN)).toHaveLength(7)
  })

  it('stops at the limit, keeping the earliest matches', () => {
    const plants = [0, 1, 2, 3, 4, 5, 6].map(n => ({ at: 0x100 + n * 0x10, bytes: site(0x10) }))

    expect(findPattern(unheadered(...plants), PATTERN, 4)).toEqual([0x100, 0x110, 0x120, 0x130])
  })

  it('returns an offset that reads back the planted bytes through readAtFileOffset', () => {
    // The convention, asserted rather than described: what findPattern hands
    // back is what RomFile.readAtFileOffset takes, on a headered cart too.
    const rom = headered(null, { at: 0x1234, bytes: site(0x5a) })
    const at = findPattern(rom, PATTERN)[0]!

    expect([...rom.readAtFileOffset(at, PATTERN.length)!]).toEqual(site(0x5a))
  })
})
