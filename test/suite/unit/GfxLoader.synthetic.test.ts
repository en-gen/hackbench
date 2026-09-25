/**
 * GfxLoader - synthetic-ROM tests for pointer-table reads, BPP inference,
 * the FilterSomeRAM upload variant, char lookup, and Layer 3 GFX loading.
 *
 * The ROM-dependent integration test is skipped when the vanilla SMW ROM
 * isn't present; this file pins down the boundary behavior.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  GFX_FILE_COUNT,
  GFX_FGBG_TABLE,
  GFX_SPRITE_TABLE,
  VRAM_CHAR_BASE,
  readGfxFile,
  loadGfxFile,
  readGfxAssignment,
  loadVram,
  getCharPixels,
  isFilterSomeRamFile,
  applyFilterSomeRamTransform,
  findCreditsGfxFile,
  inferGfxBpp,
  loadL3Chars,
  gfxBinPath,
} from '../../../src/rom/GfxLoader'
import {
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
  layer3Routine,
  L3_ROUTINE,
  plantGfxReadPath,
} from '../support/syntheticGfxCart'

function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  // L3 range $28..$2B, so file 0 in BPP-inference tests is not an L3 file.
  plantGfxReadPath(rom)
  return rom
}

function makeTinyRom(): RomFile {
  return new RomFile('tiny.smc', Buffer.alloc(0x100))
}

const writeAddr = (rom: RomFile, fileIndex: number, snesAddr: number): void => {
  rom.writeAt(TABLE_LO + fileIndex, [snesAddr & 0xff])
  rom.writeAt(TABLE_HI + fileIndex, [(snesAddr >> 8) & 0xff])
  rom.writeAt(TABLE_BANK + fileIndex, [(snesAddr >> 16) & 0xff])
}

/**
 * LZ2 stream that decompresses to `len` bytes of `fillByte`. Uses the
 * extended byte-fill command so we can request lengths > 32.
 */
function lz2ByteFill(len: number, fillByte: number): number[] {
  if (len <= 32) {
    // Standard cmd 1 (byte fill): header (1<<5) | (len-1)
    return [(1 << 5) | (len - 1), fillByte, 0xff]
  }
  // Extended: H = 0xE0 | (cmd<<2) | ((len-1)>>8 & 3); E = (len-1) & 0xFF
  const h = 0xe0 | (1 << 2) | (((len - 1) >> 8) & 3)
  const e = (len - 1) & 0xff
  return [h, e, fillByte, 0xff]
}

// ── readGfxFile ───────────────────────────────────────────────────────────────

describe('readGfxFile', () => {
  it('refuses fileIndex >= GFX_FILE_COUNT', () => {
    expect(readGfxFile(make4MbRom(), GFX_FILE_COUNT).ok).toBe(false)
  })

  it('refuses a ROM too small to hold PrepareGraphicsFile', () => {
    expect(readGfxFile(makeTinyRom(), 0).ok).toBe(false)
  })

  it('returns empty when the resolved address points to unmapped memory', () => {
    const rom = make4MbRom()
    // Pointer to bank $7E (WRAM) → loromToOffset returns null → readAt fails.
    writeAddr(rom, 0, 0x7e0000)
    expect(readGfxFile(rom, 0).ok).toBe(false)
  })

  it('decompresses a hand-built LZ2 stream', () => {
    const rom = make4MbRom()
    writeAddr(rom, 0, 0x108000)
    rom.writeAt(0x108000, lz2ByteFill(48, 0x33))
    const read = readGfxFile(rom, 0)
    expect(read.ok && Array.from(read.bytes)).toEqual(new Array(48).fill(0x33))
  })

  it('refuses a stream that never terminates, rather than crashing or returning ok', () => {
    const rom = make4MbRom()
    writeAddr(rom, 0, 0x108000)
    // cmd1 len32, one fill byte, no $FF: runs off the read window instead.
    rom.writeAt(0x108000, [(1 << 5) | 0x1f, 0x33])
    const read = readGfxFile(rom, 0)
    expect(read.ok).toBe(false)
    if (!read.ok) expect(read.reason).toMatch(/did not terminate/i)
  })
})

/**
 * The bytes of a LoadCredits-shaped routine (bank_00.asm:2463-2479):
 *
 *   LDY #fileIndex / JSL PrepareGraphicsFile
 *   LDA #$80 / STA $2115 / REP #$30
 *   LDA #vramDest / STA $2116 / LDX #words
 * - LDA [_0] / STA $2118 / INC _0 / INC _0 / DEX / BNE -
 *
 * Every operand is a parameter so the tests can prove the loader reads them
 * instead of hardcoding the vanilla values.
 */
function creditsBytes(
  opts: { fileIndex?: number; vramDest?: number; words?: number } = {},
): number[] {
  const { fileIndex = 0x2f, vramDest = 0x4600, words = 0x200 } = opts
  const lo = (w: number): number => w & 0xff
  const hi = (w: number): number => (w >> 8) & 0xff
  return [
    0xa0,
    fileIndex,
    0x22,
    0x28,
    0xba,
    0x00,
    0xa9,
    0x80,
    0x8d,
    0x15,
    0x21,
    0xc2,
    0x30,
    0xa9,
    lo(vramDest),
    hi(vramDest),
    0x8d,
    0x16,
    0x21,
    0xa2,
    lo(words),
    hi(words),
    0xa7,
    0x00,
    0x8d,
    0x18,
    0x21,
    0xe6,
    0x00,
    0xe6,
    0x00,
    0xca,
    0xd0,
    0xf4,
  ]
}

function writeLoadCredits(
  rom: RomFile,
  snesAddr: number,
  opts: { fileIndex?: number; vramDest?: number; words?: number } = {},
): void {
  rom.writeAt(snesAddr, creditsBytes(opts))
}

/** LDA #imm / STA HW_BG34NBA ($210C) - bank_00.asm:1276-1277. */
function writeBg34Nba(rom: RomFile, snesAddr: number, imm = 0x04): void {
  rom.writeAt(snesAddr, [0xa9, imm, 0x8d, 0x0c, 0x21])
}

/** A 4MB ROM carrying the vanilla credits-load shape at its vanilla address. */
function makeCreditsRom(): RomFile {
  const rom = make4MbRom()
  writeBg34Nba(rom, 0x008a93)
  writeLoadCredits(rom, 0x00955e)
  return rom
}

// ── findCreditsGfxFile ────────────────────────────────────────────────────

describe('findCreditsGfxFile', () => {
  it('reads the file index, byte length and BG3 char from the operands', () => {
    expect(findCreditsGfxFile(makeCreditsRom())).toEqual({
      fileIndex: 0x2f,
      byteLength: 0x400, // $4600 is BG3 char $C0; $400 bytes is 64 of them
    })
  })

  it('reads a file index other than the vanilla $2F', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e, { fileIndex: 0x1a })
    expect(findCreditsGfxFile(rom)?.fileIndex).toBe(0x1a)
  })

  it('returns null when the file index is past the pointer table', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e, { fileIndex: GFX_FILE_COUNT })
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('finds the routine after it has been relocated', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x1f8000, { fileIndex: 0x30, words: 0x100 })
    expect(findCreditsGfxFile(rom)).toEqual({ fileIndex: 0x30, byteLength: 0x200 })
  })

  it('returns null when the routine is absent', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when two copies match - which one runs is unknowable', () => {
    const rom = makeCreditsRom()
    writeLoadCredits(rom, 0x1f8000, { fileIndex: 0x31 })
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when no BG34NBA write is found', () => {
    const rom = make4MbRom()
    writeLoadCredits(rom, 0x00955e)
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('accepts several BG34NBA writes that agree on the BG3 base', () => {
    const rom = makeCreditsRom()
    writeBg34Nba(rom, 0x1fa464, 0x04) // patch bank rewrites the same value
    expect(findCreditsGfxFile(rom)?.fileIndex).toBe(0x2f)
  })

  it('ignores the BG4 nibble in the BG34NBA immediate', () => {
    const rom = makeCreditsRom()
    rom.writeAt(0x008a93, [0xa9, 0x44, 0x8d, 0x0c, 0x21]) // BG4=$4, BG3=$4
    expect(findCreditsGfxFile(rom)?.fileIndex).toBe(0x2f)
  })

  it('returns null when BG34NBA writes disagree on the BG3 base', () => {
    const rom = makeCreditsRom()
    writeBg34Nba(rom, 0x1fa464, 0x06)
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when the copy lands outside BG3 char space', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93) // BG3 chars at word $4000-$5FFF
    writeLoadCredits(rom, 0x00955e, { vramDest: 0x1000 })
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when the copy lands past the end of BG3 char space', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93) // BG3 chars span words $4000-$5FFF
    writeLoadCredits(rom, 0x00955e, { vramDest: 0x7000 })
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when the copy lands mid-char', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e, { vramDest: 0x4604 }) // not 8-word aligned
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when the copy length is zero', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e, { words: 0 })
    expect(findCreditsGfxFile(rom)).toBeNull()
  })

  it('returns null when the byte length is not a whole number of 2BPP chars', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e, { words: 0x201 }) // 1026 bytes
    expect(findCreditsGfxFile(rom)).toBeNull()
  })
})

describe('findCreditsGfxFile - scan bounds', () => {
  it('does not scan the copier header', () => {
    const data = Buffer.alloc(0x400000, 0x00)
    data[0x7fd5] = 0x20
    const rom = new RomFile('headered.smc', Buffer.concat([Buffer.alloc(512, 0xff), data]))
    expect(rom.hasHeader).toBe(true)
    writeBg34Nba(rom, 0x008a93)
    writeLoadCredits(rom, 0x00955e)
    // The 512-byte header is copier metadata, not code. A matching run of
    // bytes inside it would look like a second copy of the routine and turn
    // the resolver off, so the scan has to start past it.
    rom.buffer.set(creditsBytes({ fileIndex: 0x10 }), 0x40)
    expect(findCreditsGfxFile(rom)).toEqual({ fileIndex: 0x2f, byteLength: 0x400 })
  })

  it('matches a pattern that ends on the very last ROM byte', () => {
    const rom = make4MbRom()
    writeBg34Nba(rom, 0x008a93)
    // File offset $3FFFDE is the last start that still fits the 34-byte
    // pattern, reached through the $80-$FF mirror because bank $7F is WRAM.
    // An off-by-one scan bound misses it silently.
    writeLoadCredits(rom, 0xffffde)
    expect(findCreditsGfxFile(rom)?.fileIndex).toBe(0x2f)
  })
})

// ── inferGfxBpp ───────────────────────────────────────────────────────────

describe('inferGfxBpp', () => {
  it('reports 2BPP for the credits file instead of 4BPP', () => {
    // 1024 bytes is divisible by 32, so size alone infers 4BPP (32 tiles).
    expect(inferGfxBpp(makeCreditsRom(), 0x2f, 0x400)).toBe(2)
    expect(inferGfxBpp(make4MbRom(), 0x2f, 0x400)).toBe(4)
  })
})

// ── loadGfxFile BPP inference ────────────────────────────────────────────────

describe('loadGfxFile - BPP inference', () => {
  function setupGfx(rom: RomFile, fileIndex: number, bytes: number[]): void {
    writeAddr(rom, fileIndex, 0x108000 + fileIndex * 0x100)
    rom.writeAt(0x108000 + fileIndex * 0x100, bytes)
  }

  it('returns empty sheet (128 zero tiles) when fileIndex is out of range', () => {
    const sheet = loadGfxFile(make4MbRom(), GFX_FILE_COUNT)
    expect(sheet.length).toBe(128)
    expect(sheet[0].every(b => b === 0)).toBe(true)
  })

  it('returns empty sheet when decompressed data is empty', () => {
    const rom = make4MbRom()
    writeAddr(rom, 0, 0x108000)
    rom.writeAt(0x108000, [0xff]) // immediate terminator → empty data
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(128)
  })

  it('decodes 2BPP for files in the Layer 3 range (16 bytes/tile)', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0x28, lz2ByteFill(16 * 4, 0x42))
    const sheet = loadGfxFile(rom, 0x28)
    expect(sheet.length).toBe(4)
    expect(sheet[0].length).toBe(64) // 8x8 tile
  })

  it('decodes 3BPP when total length is a multiple of 24 but not 32', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(24 * 5, 0x55)) // 120 bytes
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(5)
  })

  it('prefers 3BPP when length is divisible by both 24 and 32 (vanilla ROM convention)', () => {
    const rom = make4MbRom()
    // 96 bytes is divisible by 24 (4 tiles 3bpp) AND by 32 (3 tiles 4bpp).
    // Code prefers 3bpp.
    setupGfx(rom, 0, lz2ByteFill(96, 0x77))
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(4)
  })

  it('decodes 4BPP when length is divisible by 32 but not 24', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(32 * 3, 0xaa)) // 96 → divisible by both, but
    // we want NOT divisible by 24: 32*1 = 32 satisfies (not /24)
    setupGfx(rom, 1, lz2ByteFill(32, 0x33))
    const sheet = loadGfxFile(rom, 1)
    expect(sheet.length).toBe(1)
  })

  it('decodes the credits GFX file as 2BPP (64 tiles), not 4BPP (32 tiles)', () => {
    const rom = makeCreditsRom()
    setupGfx(rom, 0x2f, lz2ByteFill(0x400, 0x5a))
    expect(loadGfxFile(rom, 0x2f).length).toBe(64)
  })

  it('returns empty sheet when length is divisible by neither 24 nor 32', () => {
    const rom = make4MbRom()
    setupGfx(rom, 0, lz2ByteFill(33, 0x99)) // odd-ish length, divisible by neither
    const sheet = loadGfxFile(rom, 0)
    expect(sheet.length).toBe(128) // _emptySheet fallback
  })
})

// ── readGfxAssignment ────────────────────────────────────────────────────────

describe('readGfxAssignment', () => {
  it('returns the 4 bytes per slot from each table forward (no inversion)', () => {
    const rom = make4MbRom()
    rom.writeAt(GFX_FGBG_TABLE + 0 * 4, [0x10, 0x11, 0x12, 0x13])
    rom.writeAt(GFX_SPRITE_TABLE + 0 * 4, [0x20, 0x21, 0x22, 0x23])
    const a = readGfxAssignment(rom, 0, 0)
    expect(a.fg1).toBe(0x10)
    expect(a.fg2).toBe(0x11)
    expect(a.fg3).toBe(0x12)
    expect(a.an1).toBe(0x13)
    expect(a.sp1).toBe(0x20)
    expect(a.sp2).toBe(0x21)
    expect(a.sp3).toBe(0x22)
    expect(a.sp4).toBe(0x23)
  })

  it('falls back to 0 when buffers are unreadable (tiny ROM)', () => {
    const rom = makeTinyRom()
    const a = readGfxAssignment(rom, 0, 0)
    expect(a).toEqual({ fg1: 0, fg2: 0, fg3: 0, an1: 0, sp1: 0, sp2: 0, sp3: 0, sp4: 0 })
  })
})

// ── loadVram ─────────────────────────────────────────────────────────────────

describe('loadVram', () => {
  it('skips slots whose assigned fileIndex is >= GFX_FILE_COUNT', () => {
    const rom = make4MbRom()
    // Force one slot's file index out of range; others stay 0.
    rom.writeAt(GFX_FGBG_TABLE, [0xff, 0x00, 0x00, 0x00])
    writeAddr(rom, 0, 0x108000)
    rom.writeAt(0x108000, lz2ByteFill(24, 0x11))
    const vram = loadVram(rom, 0, 0)
    expect(vram.fg1).toBeUndefined()
    expect(vram.fg2).toBeDefined() // file 0 is valid
  })

  it('leaves a slot empty when its file points outside the ROM', () => {
    const vram = loadVram(make4MbRom(), 0, 0) // every pointer is $000000, WRAM
    expect(vram).toEqual({})
  })

  it('applies the FilterSomeRAM transform for file $1E', () => {
    const rom = make4MbRom()
    // Place file $1E into the AN1 slot via the OBJECTGFXLIST.
    rom.writeAt(GFX_FGBG_TABLE, [0x00, 0x00, 0x00, 0x1e])
    // Set up file $1E to be empty (fast path returns 128 zero tiles).
    writeAddr(rom, 0x1e, 0x108000)
    rom.writeAt(0x108000, [0xff]) // empty after decompress
    const vram = loadVram(rom, 0, 0)
    // FilterSomeRAM was applied; even on empty sheet it doesn't error.
    expect(vram.an1).toBeDefined()
    expect(vram.an1!.length).toBe(128)
  })
})

// ── getCharPixels ────────────────────────────────────────────────────────────

describe('getCharPixels', () => {
  it('returns null when no slot covers the requested charNum', () => {
    expect(getCharPixels({}, 0x10)).toBeNull()
  })

  it('returns the indexed tile when in range of fg1 slot', () => {
    const sheet = Array.from({ length: 4 }, (_, i) => new Uint8Array(64).fill(i))
    expect(getCharPixels({ fg1: sheet }, 2)).toBe(sheet[2])
  })

  it('returns null when charNum is past the end of every loaded slot', () => {
    const sheet = [new Uint8Array(64)]
    expect(getCharPixels({ fg1: sheet }, 0x600)).toBeNull()
  })

  it('selects the correct slot for sp1 char range $400+', () => {
    const sheet = [new Uint8Array(64).fill(7)]
    const result = getCharPixels({ sp1: sheet }, VRAM_CHAR_BASE.sp1)
    expect(result?.[0]).toBe(7)
  })
})

// ── isFilterSomeRamFile ──────────────────────────────────────────────────────

describe('isFilterSomeRamFile', () => {
  it('file $1E is always FilterSomeRAM regardless of tileset', () => {
    expect(isFilterSomeRamFile(0x1e, 0)).toBe(true)
    expect(isFilterSomeRamFile(0x1e, 0x15)).toBe(true)
  })

  it('file $08 takes the path only when tileset >= $11 (overworld)', () => {
    expect(isFilterSomeRamFile(0x08, 0x10)).toBe(false)
    expect(isFilterSomeRamFile(0x08, 0x11)).toBe(true)
    expect(isFilterSomeRamFile(0x08, 0x17)).toBe(true)
  })

  it('other files never trigger FilterSomeRAM', () => {
    expect(isFilterSomeRamFile(0x00, 0)).toBe(false)
    expect(isFilterSomeRamFile(0x10, 0x15)).toBe(false)
  })
})

// ── applyFilterSomeRamTransform ──────────────────────────────────────────────

describe('applyFilterSomeRamTransform', () => {
  it('OR-bits 0x08 onto every non-zero pixel; leaves zeros alone', () => {
    const tile = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
    const transformed = applyFilterSomeRamTransform([tile])
    expect(Array.from(transformed[0])).toEqual([0, 9, 10, 11, 12, 13, 14, 15])
  })

  it('returns a fresh sheet (does not mutate input)', () => {
    const tile = new Uint8Array([0, 5])
    const sheet = [tile]
    applyFilterSomeRamTransform(sheet)
    expect(Array.from(tile)).toEqual([0, 5]) // unchanged
  })
})

// ── loadL3Chars ──────────────────────────────────────────────────────────────

describe('loadL3Chars', () => {
  it('returns one sheet per file in the L3 range', () => {
    const rom = make4MbRom()
    rom.writeAt(L3_ROUTINE, layer3Routine(2, 0x28)) // 3 files
    const sheets = loadL3Chars(rom)
    expect(sheets.length).toBe(3)
  })

  it('returns no sheets when the range is unavailable', () => {
    const rom = make4MbRom()
    rom.writeAt(L3_ROUTINE, [0x60])
    expect(loadL3Chars(rom)).toEqual([])
  })
})

// ── gfxBinPath ──────────────────────────────────────────────────────────────

describe('gfxBinPath', () => {
  it('zero-pads the hex file index to 2 digits', () => {
    expect(gfxBinPath('/dir', 0x05)).toMatch(/GFX05\.bin$/)
    expect(gfxBinPath('/dir', 0x1a)).toMatch(/GFX1A\.bin$/)
  })
})
