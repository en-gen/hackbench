// #513: an address used to READ keeps its bank; only a lookup KEY folds the
// FastROM bit. Folding $FE/$FF onto $7E/$7F (WRAM, unreadable) breaks 4 MB
// ROMs. Synthetic bytes only; one machine, vitest.
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { jslTarget } from '../../../src/rom/GfxDecompressor'
import { long } from '../../../src/rom/GfxArena'
import { loromToOffset, mirror } from '../../../src/rom/addressing'
import { resolveTables } from '../../../src/rom/sprites/interp/SpriteDispatch'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'

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

// #704. AnimationLoader and SpriteDispatch, synthetic 4 MB fixtures, one machine.
describe('#704 inline bank masks', () => {
  const fourMeg = (target: (n: 0 | 1 | 2) => number): RomFile => {
    const src = buildSyntheticRom().buffer
    const buf = Buffer.alloc(0x400000, 0)
    buf.set(src, 0)
    const at = (snes: number): number => loromToOffset(snes, 0x400000)!
    const execBytes = src.subarray(at(0x0086fa), at(0x0086fa) + 27)
    const putJsl = (operand: number, t: number): void => {
      buf.set([t & 0xff, (t >> 8) & 0xff, t >>> 16], at(operand))
    }
    // HandleSprite +13, CallSpriteInit +8, CallSpriteMain +6 (the fixture's JSL operands).
    putJsl(0x018127 + 13, target(0))
    putJsl(0x018170 + 8, target(1))
    putJsl(0x018320 + 6, target(2))
    for (const n of [0, 1, 2] as const) {
      const t = target(n)
      if (t >>> 16 >= 0xfe) buf.set(execBytes, at(t))
    }
    return new RomFile('dispatch.sfc', buf)
  }

  it.each([
    [0xfe, 'FE'],
    [0xff, 'FF'],
  ])('checkExecutePtr reads ExecutePtr through bank $%s', (bank, _label) => {
    const rom = fourMeg(() => (bank << 16) | 0x86fa)
    expect(resolveTables(rom).ok).toBe(true)
  })

  it('checkExecutePtr still equates a FastROM twin with its $00+ target', () => {
    const rom = fourMeg(n => (n === 1 ? 0x8086fa : 0x0086fa))
    expect(resolveTables(rom).ok).toBe(true)
  })

  it('checkExecutePtr refuses a WRAM call that mirror() would key as the ROM one', () => {
    const rom = fourMeg(n => (n === 1 ? 0x7e86fa : 0xfe86fa))
    expect(resolveTables(rom).ok).toBe(false)
  })

  it('checkExecutePtr still refuses calls that reach different routines', () => {
    const rom = fourMeg(n => (n === 1 ? 0x0186fa : 0x0086fa))
    expect(resolveTables(rom).ok).toBe(false)
  })
})
