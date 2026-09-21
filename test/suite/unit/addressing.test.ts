import { describe, it, expect } from 'vitest'
import {
  loromToOffset,
  hiromToOffset,
  hasCopierHeader,
  LOROM_BANK_SIZE,
  HIROM_BANK_SIZE,
  COPIER_HEADER_SIZE,
} from '../../../src/rom/addressing'
import { brokenOldHiromShaped } from './fixtures/brokenLoromConverter'

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

// Generous size for tests that only care about the bank/addr formula, not bounds.
const ROM_4MB = 0x400000

describe('loromToOffset', () => {
  it('converts bank $00 addr $8000 → offset 0', () => {
    expect(loromToOffset(0x008000, ROM_4MB)).toBe(0)
  })
  it('converts bank $00 addr $FFFF → offset $7FFF', () => {
    expect(loromToOffset(0x00ffff, ROM_4MB)).toBe(0x7fff)
  })
  it('converts bank $01 addr $8000 → offset $8000', () => {
    expect(loromToOffset(0x018000, ROM_4MB)).toBe(LOROM_BANK_SIZE)
  })
  it('converts bank $05 addr $E000 (LEVEL_L1_LOW area)', () => {
    // $05E000 → bank $05, addr $E000 → offset = 5 * 0x8000 + (0xE000 - 0x8000) = 0x28000 + 0x6000 = 0x2E000
    expect(loromToOffset(0x05e000, ROM_4MB)).toBe(5 * 0x8000 + (0xe000 - 0x8000))
  })
  it('mirrors: bank $80 maps same as bank $00', () => {
    expect(loromToOffset(0x808000, ROM_4MB)).toBe(loromToOffset(0x008000, ROM_4MB))
  })
  it('mirrors: bank $85 maps same as bank $05', () => {
    expect(loromToOffset(0x85e000, ROM_4MB)).toBe(loromToOffset(0x05e000, ROM_4MB))
  })
  it('returns null for low-page address in bank $00 (sub-$8000)', () => {
    expect(loromToOffset(0x007fff, ROM_4MB)).toBeNull()
  })
  it('returns null for low-page address in bank $0D (sub-$8000, not just bank $00)', () => {
    // A mutant that only excludes bank $00's low half (instead of every
    // $00-$3F/$80-$BF bank) would wrongly accept this.
    expect(loromToOffset(0x0d1234, ROM_4MB)).toBeNull()
  })
  it('returns null for low-page address in the $80-$BF mirror (bank $80, not just the $00-$3F raw range)', () => {
    // A mutant that checks the low-half exclusion against the RAW bank
    // (never folding $80-$FF down to $00-$7F first) would wrongly accept
    // this, since raw bank $80 is not <= $3F.
    expect(loromToOffset(0x807fff, ROM_4MB)).toBeNull()
  })
  it('returns null for WRAM bank $7E regardless of ROM size', () => {
    expect(loromToOffset(0x7e0000, ROM_4MB)).toBeNull()
    expect(loromToOffset(0x7e0000, 8 * 1024 * 1024)).toBeNull()
  })
  it('returns null for WRAM bank $7F regardless of ROM size', () => {
    expect(loromToOffset(0x7f0000, ROM_4MB)).toBeNull()
  })
  it('bank $FE is ROM (the $7E mirror), NOT WRAM: /WRAMSEL ignores A23', () => {
    // Confirmed against a real expanded ROM (Invictus 1.0.sfc): its top-of-image
    // level pointers use bank $FE, which the SNES CPU never redirects to WRAM.
    expect(loromToOffset(0xfebf17, ROM_4MB)).toBe(0x7e * 0x8000 + (0xbf17 & 0x7fff))
  })
  it('bank $FF is ROM (the $7F mirror), NOT WRAM', () => {
    expect(loromToOffset(0xff8000, ROM_4MB)).toBe(0x7f * 0x8000)
  })
  it('adds copier header offset when requested', () => {
    expect(loromToOffset(0x008000, ROM_4MB, true)).toBe(COPIER_HEADER_SIZE)
  })
  it('SMW YI1 L1 pointer $0689F7 resolves correctly', () => {
    // Verified empirically: Mesen2 $7E:0065-$67 = $0689F7 while on Yoshi\'s Island 1
    expect(loromToOffset(0x0689f7, ROM_4MB)).toBe(0x06 * 0x8000 + (0x89f7 - 0x8000))
  })

  // ── Size-aware bounds: bank $70-$7D is SRAM on a small cart, ROM on an
  // expanded one. Only romSize distinguishes them (addressing.ts header). ──
  describe('bank $40-$7D depends on actual ROM size, not a hardcoded branch', () => {
    it('bank $70 is out of range for a 512KB vanilla ROM (SRAM territory)', () => {
      expect(loromToOffset(0x700000, 512 * 1024)).toBeNull()
    })
    it('bank $70 IS real ROM on a 4MB expanded ROM', () => {
      // 0x70 * 0x8000 = 0x380000, well inside a 4MB (0x400000) file.
      expect(loromToOffset(0x700000, ROM_4MB)).toBe(0x380000)
    })
    it('bank $7D upper edge ($7DFFFF) is the last byte reachable via $00-$7F', () => {
      expect(loromToOffset(0x7dffff, ROM_4MB)).toBe(0x7d * 0x8000 + 0x7fff)
    })
    it('addr below $8000 in an expanded bank mirrors the upper half (no SRAM conflict there)', () => {
      // Unlike bank $00-$3F, banks $40-$7D have no register conflict in the
      // low half, so LoROM's ignored-A15 wiring makes it read the same data.
      expect(loromToOffset(0x580000, ROM_4MB)).toBe(loromToOffset(0x588000, ROM_4MB))
    })
    it('an offset exactly at romSize is out of bounds (boundary, not off-by-one)', () => {
      // bank $20 * 0x8000 == 0x100000 == romSize for a 1MB ROM: one past the end.
      expect(loromToOffset(0x208000, 1024 * 1024)).toBeNull()
      expect(
        loromToOffset(0x1fffff /* prior byte, bank $1F addr $FFFF-ish */, 1024 * 1024),
      ).not.toBeNull()
    })
  })

  // ── Regression: the two measurements from the expanded-ROM bug report ──
  describe('expanded ROM regressions (Grand Poo World 2, Invictus)', () => {
    it('SNES $D8EB4E on a 4MB ROM resolves to $2C6B4E, not the old HiROM-shaped $18EB4E', () => {
      expect(loromToOffset(0xd8eb4e, ROM_4MB)).toBe(0x2c6b4e)
    })
    it('SNES $8285DD on a 4MB ROM resolves via the plain $00-$3F formula', () => {
      expect(loromToOffset(0x8285dd, ROM_4MB)).toBe(0x02 * 0x8000 + (0x85dd - 0x8000))
    })
  })

  // ── Teeth: each of these deliberately-broken converters must fail the
  // regression checks above. A gate that cannot fail is worse than none
  // (CLAUDE.md "Oracles must be proven able to fail"). ──
  describe('teeth: broken converters fail the regression checks', () => {
    // Masks bank BEFORE the WRAM check, so $FE/$FF get misidentified as the
    // WRAM banks $7E/$7F. This was an intermediate draft of the real fix,
    // caught only by testing against Invictus 1.0.sfc's bank-$FE pointers.
    const brokenMasksBeforeWramCheck = (snesAddr: number, romSize: number): number | null => {
      const bank = (snesAddr >>> 16) & 0xff
      const addr = snesAddr & 0xffff
      const effectiveBank = bank & 0x7f
      if (effectiveBank === 0x7e || effectiveBank === 0x7f) return null
      if (effectiveBank <= 0x3f && addr < 0x8000) return null
      const dataOffset = effectiveBank * LOROM_BANK_SIZE + (addr & 0x7fff)
      return dataOffset >= romSize ? null : dataOffset
    }

    it('the original buggy $40-$6F/$70-$7D branch fails the $D8EB4E regression', () => {
      expect(brokenOldHiromShaped(0xd8eb4e)).not.toBe(0x2c6b4e)
      expect(brokenOldHiromShaped(0xd8eb4e)).toBe(0x18eb4e) // reproduces the reported bug exactly
    })
    it('the original buggy branch also fails the expanded-bank-$70 check', () => {
      expect(brokenOldHiromShaped(0x700000)).toBeNull() // wrongly treats it as SRAM
    })
    it('masking before the WRAM check fails the bank-$FE regression', () => {
      expect(brokenMasksBeforeWramCheck(0xfebf17, ROM_4MB)).not.toBe(
        0x7e * 0x8000 + (0xbf17 & 0x7fff),
      )
      expect(brokenMasksBeforeWramCheck(0xfebf17, ROM_4MB)).toBeNull() // wrongly treats $FE as WRAM
    })
  })

  // ── No-regression sweep: the fix must not change a single vanilla-range
  // result. Every bank where (bank & 0x7F) <= 0x3F was already handled
  // identically by the pre-fix formula, so the fixed and broken converters
  // must agree there exactly. ──
  describe('no-regression sweep: vanilla banks ($00-$3F/$80-$BF) unchanged by the fix', () => {
    it('agrees with the pre-fix converter for every address in every unaffected bank', () => {
      for (let bank = 0; bank <= 0xff; bank++) {
        if ((bank & 0x7f) > 0x3f) continue
        for (const addr of [0x8000, 0xc000, 0xffff]) {
          const snesAddr = (bank << 16) | addr
          expect(loromToOffset(snesAddr, ROM_4MB)).toBe(brokenOldHiromShaped(snesAddr))
        }
      }
    })
  })
})

describe('hiromToOffset', () => {
  it('bank $C0 addr $0000 → offset 0', () => {
    expect(hiromToOffset(0xc00000)).toBe(0)
  })
  it('bank $C0 addr $FFFF → offset $FFFF', () => {
    expect(hiromToOffset(0xc0ffff)).toBe(0xffff)
  })
  it('bank $C1 addr $0000 → offset $10000', () => {
    expect(hiromToOffset(0xc10000)).toBe(HIROM_BANK_SIZE)
  })
  it('bank $FF addr $FFFF → last byte of 4MB ROM', () => {
    expect(hiromToOffset(0xffffff)).toBe(0x3f * HIROM_BANK_SIZE + 0xffff)
  })
  it('bank $00 addr $8000 (ROM shadow) → offset $8000', () => {
    // HiROM: banks $00-$3F upper half mirror ROM
    expect(hiromToOffset(0x008000)).toBe(0x8000)
  })
  it('bank $00 addr $7FFF → null (system space)', () => {
    expect(hiromToOffset(0x007fff)).toBeNull()
  })
  it('bank $40 addr $0000 → offset 0 (full 64KB page)', () => {
    // HiROM banks $40-$6F: full 64KB ROM pages, same data as $C0-$FF
    expect(hiromToOffset(0x400000)).toBe(0)
  })
  it('bank $7E → null (WRAM)', () => {
    expect(hiromToOffset(0x7e0000)).toBeNull()
  })
  it('bank $70 → null (SRAM)', () => {
    expect(hiromToOffset(0x700000)).toBeNull()
  })
  it('mirrors: bank $80 maps same as bank $00 upper half', () => {
    expect(hiromToOffset(0x808000)).toBe(hiromToOffset(0x008000))
  })
  it('adds copier header offset when requested', () => {
    expect(hiromToOffset(0xc00000, true)).toBe(COPIER_HEADER_SIZE)
  })
})
