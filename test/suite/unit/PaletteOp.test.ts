/**
 * The op reducer, tested with no WorkingRom, no project and no cartridge on
 * disk: pure byte-array math, addressed by a SNES address.
 */
import { describe, it, expect } from 'vitest'
import {
  applyOp,
  FULL_WORD_MASK,
  opFileOffset,
  parseBgr555Word,
  parseHexAddr,
  readBgr555Word,
} from '../../../src/rom/PaletteOp'

const MARIO_RED_ADDR = 0x00b2ce // SMWDisX/bank_00.asm:11257, :11324-11332

describe('PaletteOp', () => {
  it('parseHexAddr accepts a leading "$" or none, case-insensitively', () => {
    expect(parseHexAddr('$00B2CE')).toBe(MARIO_RED_ADDR)
    expect(parseHexAddr('00b2ce')).toBe(MARIO_RED_ADDR)
  })

  it('parseHexAddr throws on non-hex input', () => {
    expect(() => parseHexAddr('not-hex')).toThrow()
  })

  /**
   * The op format (docs/glossary.md, "Op") is `$XXXXXX` or bare hex - never
   * `0x`-prefixed. Nothing else in this file pins that: "not-hex" (above)
   * fails on its very first character, so a regression that widened the
   * character class to also accept an `x` (making "0x1234" parse as if it
   * were "01234") would still pass every other test here, only reachable in
   * practice through a hand-edited ops file.
   */
  it('parseHexAddr rejects a 0x-prefixed address; only "$" or bare hex are the grammar', () => {
    expect(() => parseHexAddr('0x00B2CE')).toThrow()
    expect(() => parseHexAddr('0X00B2CE')).toThrow()
  })

  it('parseBgr555Word accepts the full 0..0xFFFF range', () => {
    expect(parseBgr555Word('$0000')).toBe(0)
    expect(parseBgr555Word('$FFFF')).toBe(0xffff)
  })

  it('parseBgr555Word rejects out-of-range and non-integer input rather than truncating', () => {
    expect(() => parseBgr555Word('$1FFFF')).toThrow()
    expect(() => parseBgr555Word('nope')).toThrow()
  })

  it('opFileOffset resolves a LoROM bank-0 address to the expected file offset', () => {
    // bank 0, addr $B2CE -> (addr & 0x7FFF) with no bank contribution.
    expect(opFileOffset({ address: '$00B2CE', old: '$0000', new: '$0000' }, 0x80000, false)).toBe(
      0x32ce,
    )
  })

  it('opFileOffset returns null for an address outside the given ROM size', () => {
    expect(opFileOffset({ address: '$00B2CE', old: '$0000', new: '$0000' }, 0x1000, false)).toBe(
      null,
    )
  })

  it('applyOp writes little-endian and masks bit 15 off', () => {
    const bytes = new Uint8Array(0x80000)
    applyOp(bytes, { address: '$00B2CE', old: '$0000', new: '$83E0' }, bytes.length, false)
    const offset = opFileOffset(
      { address: '$00B2CE', old: '', new: '' },
      bytes.length,
      false,
    ) as number
    expect(bytes[offset]).toBe(0xe0)
    expect(bytes[offset + 1]).toBe(0x03) // 0x83E0 & 0x7FFF = 0x03E0
    expect(readBgr555Word(bytes, offset)).toBe(0x03e0)
  })

  it('applyOp throws (and leaves `out` unwritten) for an address outside the cart', () => {
    const bytes = new Uint8Array(0x1000)
    const before = new Uint8Array(bytes)
    expect(() =>
      applyOp(bytes, { address: '$00B2CE', old: '$0000', new: '$03E0' }, bytes.length, false),
    ).toThrow()
    expect(bytes).toEqual(before)
  })

  /**
   * Map16 subtile words use bit 15 for vertical flip, so applyOp must be
   * able to keep it - the default (no `mask`) is right for a CGRAM colour
   * only, not for every 16-bit word this reducer now writes.
   */
  it('applyOp with mask: FULL_WORD_MASK keeps bit 15 instead of dropping it', () => {
    const bytes = new Uint8Array(0x80000)
    applyOp(
      bytes,
      { address: '$00B2CE', old: '$0000', new: '$83E0', mask: FULL_WORD_MASK },
      bytes.length,
      false,
    )
    const offset = opFileOffset(
      { address: '$00B2CE', old: '', new: '' },
      bytes.length,
      false,
    ) as number
    expect(bytes[offset]).toBe(0xe0)
    expect(bytes[offset + 1]).toBe(0x83) // bit 15 preserved, unlike the default-mask case above
  })

  it('applyOp is deterministic: the same bytes and op always produce the same result', () => {
    const a = new Uint8Array(0x8000)
    const b = new Uint8Array(0x8000)
    const op = { address: '$00B2CE', old: '$0000', new: '$7C00' }
    applyOp(a, op, a.length, false)
    applyOp(b, op, b.length, false)
    expect(a).toEqual(b)
  })
})
