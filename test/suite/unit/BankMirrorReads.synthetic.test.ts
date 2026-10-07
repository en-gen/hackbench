// #513: an address used to READ keeps its bank; only a lookup KEY folds the
// FastROM bit. Folding $FE/$FF onto $7E/$7F (WRAM, unreadable) breaks 4 MB
// ROMs. Synthetic bytes only; one machine, vitest.
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { jslTarget } from '../../../src/rom/GfxDecompressor'
import { long } from '../../../src/rom/GfxArena'
import { mirror } from '../../../src/rom/addressing'

const romWith = (at: number, bytes: number[]): RomFile => {
  const buf = new Uint8Array(0x8000 * 4)
  buf.set(bytes, at)
  return new RomFile('mirror.sfc', buf)
}

describe('read addresses keep bank $FE/$FF', () => {
  it.each([0xfe, 0xff])('jslTarget returns bank %i unfolded', bank => {
    const rom = romWith(0, [0x22, 0x34, 0x92, bank])
    expect(jslTarget(rom, 0x008000)).toBe((bank << 16) | 0x9234)
  })

  it.each([0xfe, 0xff])('GfxArena long() returns bank %i unfolded', bank => {
    expect(long(Uint8Array.of(0x34, 0x92, bank), 0)).toBe((bank << 16) | 0x9234)
  })

  it('a FastROM mirror still matches its canonical key through mirror()', () => {
    expect(mirror(0x85bb39)).toBe(mirror(0x05bb39))
    expect(mirror(0xfe8000)).toBe(0x7e8000) // key only: never read through
  })
})
