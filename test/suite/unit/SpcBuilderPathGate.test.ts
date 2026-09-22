import { describe, it, expect } from 'vitest'
import { getLevelMusicBankAddrIfReadable, readBankSongPointers } from '../../../src/rom/SpcBuilder'

/**
 * Synthetic, no-cartridge coverage for the level-music path trace and
 * opcode gate (issue #417). CI never has test/roms/ (copyright), so every
 * corpus-based assertion of this behaviour registers zero test cases there;
 * this file is what actually runs in CI for these safeguards.
 */

const CALL_SITE = 0x009702
const OPCODE_JSR = 0x20
const OPCODE_LDA_W = 0xad
const OPCODE_BNE = 0xd0
const OPCODE_LDA_IMM = 0xa9
const OPCODE_STA_W = 0x8d

interface Layout {
  uploadLevelMusic: number
  routine: number
  bankAddr: number
}

/**
 * A synthetic bank at `bankAddr`: a valid 4-byte header plus a 2-entry song
 * pointer table (enough to prove the traced address is actually used, not
 * just resolved).
 */
function writeBank(bytes: Uint8Array, bankAddr: number): void {
  const aramDest = 0x1000
  const song0 = aramDest + 4 // right after a 2-entry table
  const song1 = song0 + 10
  const size = 0x20
  bytes[bankAddr + 0] = size & 0xff
  bytes[bankAddr + 1] = (size >> 8) & 0xff
  bytes[bankAddr + 2] = aramDest & 0xff
  bytes[bankAddr + 3] = (aramDest >> 8) & 0xff
  bytes[bankAddr + 4] = song0 & 0xff
  bytes[bankAddr + 5] = (song0 >> 8) & 0xff
  bytes[bankAddr + 6] = song1 & 0xff
  bytes[bankAddr + 7] = (song1 >> 8) & 0xff
}

/** LDA.B #imm / STA.W component of the upload pattern, matching bank_00.asm:175-180. */
function writeLdaSta(bytes: Uint8Array, at: number, immediate: number, target: number): void {
  bytes[at] = OPCODE_LDA_IMM
  bytes[at + 1] = immediate
  bytes[at + 2] = OPCODE_STA_W
  bytes[at + 3] = target & 0xff
  bytes[at + 4] = (target >> 8) & 0xff
}

/** A full, valid call path from CALL_SITE through to a real bank at layout.bankAddr. */
function buildValidRom(layout: Layout): Uint8Array {
  const bytes = new Uint8Array(0xa000)

  bytes[CALL_SITE] = OPCODE_JSR
  bytes[CALL_SITE + 1] = layout.uploadLevelMusic & 0xff
  bytes[CALL_SITE + 2] = (layout.uploadLevelMusic >> 8) & 0xff

  bytes[layout.uploadLevelMusic] = OPCODE_LDA_W
  bytes[layout.uploadLevelMusic + 1] = 0x25
  bytes[layout.uploadLevelMusic + 2] = 0x14
  bytes[layout.uploadLevelMusic + 3] = OPCODE_BNE
  const branchFrom = layout.uploadLevelMusic + 5
  const displacement = layout.routine - branchFrom
  bytes[layout.uploadLevelMusic + 4] = displacement & 0xff // small positive: fits unsigned

  writeLdaSta(bytes, layout.routine, layout.bankAddr & 0xff, 0x0000)
  writeLdaSta(bytes, layout.routine + 5, (layout.bankAddr >> 8) & 0xff, 0x0001)
  writeLdaSta(bytes, layout.routine + 10, (layout.bankAddr >> 16) & 0xff, 0x0002)

  writeBank(bytes, layout.bankAddr)
  return bytes
}

function romFromBytes(bytes: Uint8Array) {
  return {
    readAt: (addr: number, len: number) => {
      if (addr < 0 || addr + len > bytes.length) return null
      return bytes.slice(addr, addr + len)
    },
    readByte: (addr: number) => {
      if (addr < 0 || addr >= bytes.length) return null
      return bytes[addr]
    },
    fileOffsetOf: (addr: number) => addr,
    buffer: { length: bytes.length },
  } as any
}

const BASE_LAYOUT: Layout = { uploadLevelMusic: 0x008700, routine: 0x008720, bankAddr: 0x008740 }

describe('SpcBuilder level-music path gate (no cartridge required)', () => {
  it('resolves and reads a fully valid path', () => {
    const rom = romFromBytes(buildValidRom(BASE_LAYOUT))
    const addr = getLevelMusicBankAddrIfReadable(rom)
    expect(addr).toBe(BASE_LAYOUT.bankAddr)
    expect(readBankSongPointers(rom, addr!)).toHaveLength(2)
  })

  it('a routine relocated but otherwise intact is still found (N2)', () => {
    const layout: Layout = { uploadLevelMusic: 0x008900, routine: 0x008950, bankAddr: 0x008980 }
    const rom = romFromBytes(buildValidRom(layout))
    expect(getLevelMusicBankAddrIfReadable(rom)).toBe(layout.bankAddr)
  })

  it('refuses when the call site opcode is not JSR', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    bytes[CALL_SITE] = 0xea // NOP
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })

  it('refuses when UploadLevelMusic does not open with LDA.W', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    bytes[BASE_LAYOUT.uploadLevelMusic] = 0xea
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })

  it('refuses when the branch to the upload routine is not BNE', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    bytes[BASE_LAYOUT.uploadLevelMusic + 3] = 0xea
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })

  it('refuses when an STA.W operand no longer targets the shared staging addresses (N3)', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    // Repoint the first STA.W from $0000 to $2140: opcodes are untouched.
    bytes[BASE_LAYOUT.routine + 3] = 0x40
    bytes[BASE_LAYOUT.routine + 4] = 0x21
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })

  it('refuses when an LDA in the pattern is replaced, opcodes elsewhere unchanged', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    bytes[BASE_LAYOUT.routine + 5] = 0x60 // RTS in place of the second LDA.B #imm
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })

  it('reproduces the real AddmusicK shape: JSR/RTS stub in place of the routine, filler at the derived address', () => {
    const bytes = buildValidRom(BASE_LAYOUT)
    // SEP #$20 / RTS in place of the first LDA.B #imm / STA.W pair, the
    // exact bytes measured on Grand Poo World 2 and Invictus at $008148.
    bytes[BASE_LAYOUT.routine] = 0xe2
    bytes[BASE_LAYOUT.routine + 1] = 0x20
    bytes[BASE_LAYOUT.routine + 2] = 0x60
    expect(getLevelMusicBankAddrIfReadable(romFromBytes(bytes))).toBeNull()
  })
})
