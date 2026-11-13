/**
 * Where Objects can be found (#1237 review, blocker 1): the per-map Map16 refusal on synthetic carts,
 * so it is proven with no ROM. A stock loader is the 512-tile fill loop and an unhooked level-load
 * compare at $05803B; anything else is refused in plain words.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { objectsRefusal, PER_LEVEL_MAP16 } from '../../../src/rom/objects/ObjectInputs'

const COMPARE_SITE = 0x2803b // $05803B on LoROM: bank 5, offset $003B

/** A cart with the Map16 fill loop tail (CPX.W #bytes) and a chosen byte at the level-load compare. */
function cart(opts: { bytes?: number; opcode: number }): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  buf[COMPARE_SITE] = opts.opcode
  if (opts.bytes !== undefined) {
    const o = 0x1000
    buf.set([0x69, 0x08, 0x00, 0x85, 0x65, 0xe8, 0xe8, 0xe0, opts.bytes & 0xff, opts.bytes >> 8, 0xd0, 0xf3], o) // prettier-ignore
  }
  return new RomFile('synthetic.sfc', buf)
}

describe('objectsRefusal on synthetic carts', () => {
  it('a stock loader (512 tiles, the compare unhooked) is not refused', () => {
    expect(objectsRefusal(cart({ bytes: 1024, opcode: 0xc9 }))).toBeNull()
  })

  it('a hijacked level-load compare is refused in plain words', () => {
    expect(objectsRefusal(cart({ bytes: 1024, opcode: 0x5c }))).toBe(PER_LEVEL_MAP16)
  })

  it('an expanded Map16 is refused even with the compare unhooked', () => {
    expect(objectsRefusal(cart({ bytes: 2048, opcode: 0xc9 }))).toBe(PER_LEVEL_MAP16)
  })

  it('a table of another size under 512 is refused too: Objects are matched on the stock 512 only', () => {
    expect(objectsRefusal(cart({ bytes: 1022, opcode: 0xc9 }))).toBe(PER_LEVEL_MAP16)
  })

  it('a cart whose fill loop cannot be found is refused', () => {
    expect(objectsRefusal(cart({ opcode: 0xc9 }))).toBe(PER_LEVEL_MAP16)
  })

  it('the refusal says it in words a person reads', () => {
    expect(PER_LEVEL_MAP16).toBe(
      "Objects can't be found on this map: it uses custom per-map tiles.",
    )
  })
})
