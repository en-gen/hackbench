import { describe, it, expect } from 'vitest'
import {
  loromToOffset, hiromToOffset,
  hasCopierHeader, LOROM_BANK_SIZE, HIROM_BANK_SIZE, COPIER_HEADER_SIZE,
} from '../../../src/rom/addressing'

describe('hasCopierHeader', () => {
  it('detects 512-byte copier header', () => {
    expect(hasCopierHeader(512 * 1024 + 512)).toBe(true)
  })
  it('returns false for clean ROM', () => {
    expect(hasCopierHeader(512 * 1024)).toBe(false)
  })
  it('returns false for 1MB clean ROM', () => {
    expect(hasCopierHeader(1024 * 1024)).toBe(false)
  })
  it('returns true for headered 1MB ROM', () => {
    expect(hasCopierHeader(1024 * 1024 + 512)).toBe(true)
  })
})

describe('loromToOffset', () => {
  it('converts bank $00 addr $8000 → offset 0', () => {
    expect(loromToOffset(0x008000)).toBe(0)
  })
  it('converts bank $00 addr $FFFF → offset $7FFF', () => {
    expect(loromToOffset(0x00FFFF)).toBe(0x7FFF)
  })
  it('converts bank $01 addr $8000 → offset $8000', () => {
    expect(loromToOffset(0x018000)).toBe(LOROM_BANK_SIZE)
  })
  it('converts bank $05 addr $E000 (LEVEL_L1_LOW area)', () => {
    // $05E000 → bank $05, addr $E000 → offset = 5 * 0x8000 + (0xE000 - 0x8000) = 0x28000 + 0x6000 = 0x2E000
    expect(loromToOffset(0x05E000)).toBe(5 * 0x8000 + (0xE000 - 0x8000))
  })
  it('mirrors: bank $80 maps same as bank $00', () => {
    expect(loromToOffset(0x808000)).toBe(loromToOffset(0x008000))
  })
  it('mirrors: bank $85 maps same as bank $05', () => {
    expect(loromToOffset(0x85E000)).toBe(loromToOffset(0x05E000))
  })
  it('returns null for low-page address in bank $00 (sub-$8000)', () => {
    expect(loromToOffset(0x007FFF)).toBeNull()
  })
  it('returns null for SRAM bank $70', () => {
    expect(loromToOffset(0x700000)).toBeNull()
  })
  it('returns null for WRAM bank $7E', () => {
    expect(loromToOffset(0x7E0000)).toBeNull()
  })
  it('returns null for WRAM bank $7F', () => {
    expect(loromToOffset(0x7F0000)).toBeNull()
  })
  it('adds copier header offset when requested', () => {
    expect(loromToOffset(0x008000, true)).toBe(COPIER_HEADER_SIZE)
  })
  it('SMW YI1 L1 pointer $0689F7 resolves correctly', () => {
    // Verified empirically: Mesen2 $7E:0065-$67 = $0689F7 while on Yoshi\'s Island 1
    expect(loromToOffset(0x0689F7)).toBe(0x06 * 0x8000 + (0x89F7 - 0x8000))
  })
})

describe('hiromToOffset', () => {
  it('bank $C0 addr $0000 → offset 0', () => {
    expect(hiromToOffset(0xC00000)).toBe(0)
  })
  it('bank $C0 addr $FFFF → offset $FFFF', () => {
    expect(hiromToOffset(0xC0FFFF)).toBe(0xFFFF)
  })
  it('bank $C1 addr $0000 → offset $10000', () => {
    expect(hiromToOffset(0xC10000)).toBe(HIROM_BANK_SIZE)
  })
  it('bank $FF addr $FFFF → last byte of 4MB ROM', () => {
    expect(hiromToOffset(0xFFFFFF)).toBe(0x3F * HIROM_BANK_SIZE + 0xFFFF)
  })
  it('bank $00 addr $8000 (ROM shadow) → offset $8000', () => {
    // HiROM: banks $00-$3F upper half mirror ROM
    expect(hiromToOffset(0x008000)).toBe(0x8000)
  })
  it('bank $00 addr $7FFF → null (system space)', () => {
    expect(hiromToOffset(0x007FFF)).toBeNull()
  })
  it('bank $40 addr $0000 → offset 0 (full 64KB page)', () => {
    // HiROM banks $40-$6F: full 64KB ROM pages, same data as $C0-$FF
    expect(hiromToOffset(0x400000)).toBe(0)
  })
  it('bank $7E → null (WRAM)', () => {
    expect(hiromToOffset(0x7E0000)).toBeNull()
  })
  it('bank $70 → null (SRAM)', () => {
    expect(hiromToOffset(0x700000)).toBeNull()
  })
  it('mirrors: bank $80 maps same as bank $00 upper half', () => {
    expect(hiromToOffset(0x808000)).toBe(hiromToOffset(0x008000))
  })
  it('adds copier header offset when requested', () => {
    expect(hiromToOffset(0xC00000, true)).toBe(COPIER_HEADER_SIZE)
  })
})
