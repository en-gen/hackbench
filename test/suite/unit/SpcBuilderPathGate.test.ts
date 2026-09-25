import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'
import { getLevelMusicBankAddrIfReadable, readBankSongPointers } from '../../../src/rom/SpcBuilder'

/**
 * Synthetic, no-ROM coverage for the level-music path trace and opcode gate
 * (issues #417, #493). CI never has the corpus (copyright), so every
 * corpus-based assertion of this behaviour registers zero test cases there;
 * this file is what actually runs in CI for these safeguards.
 */

const CALL_SITE = 0x009702
const OPCODE_JSR = 0x20
const OPCODE_LDA_IMM = 0xa9
const OPCODE_STA_W = 0x8d
const OPCODE_BRA = 0x80
const OPCODE_RTS = 0x60
const CART_SIZE = 0xa000

interface Layout {
  uploadLevelMusic: number
  routine: number
  bankAddr: number
}

/**
 * UploadLevelMusic's conditional header through the early-return BNE
 * (bank_00.asm:165-173), matching src/rom/SpcBuilder.ts's
 * UPLOAD_LEVEL_MUSIC_HEADER: LDA.W / BNE +$0F (to the routine, 20 bytes on)
 * / LDA.W / CMP.B / BEQ +$08 (same target) / ORA.W / ORA.W / BNE -$15 (to
 * SPCUploadReturn, one byte before the header - see buildValidRom). The
 * fixed opcodes and displacements are the independent oracle a defect in
 * the production pattern should not be able to slip past; every wildcarded
 * operand is left 0.
 */
// prettier-ignore
const LEVEL_MUSIC_HEADER = [
  0xad, 0x00, 0x00,  0xd0, 0x0f,  0xad, 0x00, 0x00,  0xc9, 0x00,  0xf0, 0x08,
  0x0d, 0x00, 0x00,  0x0d, 0x00, 0x00,  0xd0, 0xeb,
]

/** StartMusicUpload's own body (bank_00.asm:152-154): LDA #$FF / STA $2141 / JSR (wildcarded). */
const START_MUSIC_UPLOAD_BODY = [0xa9, 0xff, 0x8d, 0x41, 0x21, 0x20, 0x00, 0x00]

/** How far past `routine` the BRA's target body sits, comfortably inside BRA range of it. */
const BODY_OFFSET = 20

function writeBank(rom: RomFile, bankAddr: number): void {
  const aramDest = 0x1000
  const song0 = aramDest + 4 // right after a 2-entry table
  const song1 = song0 + 10
  const size = 0x20
  rom.writeAt(bankAddr, [
    size & 0xff,
    (size >> 8) & 0xff,
    aramDest & 0xff,
    (aramDest >> 8) & 0xff,
    song0 & 0xff,
    (song0 >> 8) & 0xff,
    song1 & 0xff,
    (song1 >> 8) & 0xff,
  ])
}

/** LDA.B #imm / STA.W component of the upload pattern, matching bank_00.asm:175-180. */
function writeLdaSta(rom: RomFile, at: number, immediate: number, target: number): void {
  rom.writeAt(at, [OPCODE_LDA_IMM, immediate, OPCODE_STA_W, target & 0xff, (target >> 8) & 0xff])
}

/** BRA at `at` reaching `target` (bank_00.asm:181). */
function writeBra(rom: RomFile, at: number, target: number): void {
  rom.writeAt(at, [OPCODE_BRA, (target - (at + 2)) & 0xff])
}

/** A full, valid call path from CALL_SITE through to a real bank at layout.bankAddr. */
function buildValidRom(layout: Layout): RomFile {
  const buf = Buffer.alloc(CART_SIZE, 0)
  buf[0x7fd5] = 0x20 // LoROM map mode, so RomFile detects this as a real ROM
  const rom = new RomFile('synthetic.sfc', buf)

  rom.writeAt(CALL_SITE, [
    OPCODE_JSR,
    layout.uploadLevelMusic & 0xff,
    (layout.uploadLevelMusic >> 8) & 0xff,
  ])
  rom.writeAt(layout.uploadLevelMusic - 1, [OPCODE_RTS]) // SPCUploadReturn, the early-return target
  rom.writeAt(layout.uploadLevelMusic, LEVEL_MUSIC_HEADER)

  writeLdaSta(rom, layout.routine, layout.bankAddr & 0xff, 0x0000)
  writeLdaSta(rom, layout.routine + 5, (layout.bankAddr >> 8) & 0xff, 0x0001)
  writeLdaSta(rom, layout.routine + 10, (layout.bankAddr >> 16) & 0xff, 0x0002)
  const bodyAddr = layout.routine + BODY_OFFSET
  writeBra(rom, layout.routine + 15, bodyAddr)
  rom.writeAt(bodyAddr, START_MUSIC_UPLOAD_BODY)

  writeBank(rom, layout.bankAddr)
  return rom
}

/** Fixed opcode offsets in LEVEL_MUSIC_HEADER, for the per-byte sweep below. */
const FIXED_OPCODE_OFFSETS = [0, 3, 5, 8, 10, 12, 15, 18]

// Real vanilla addresses (SMW_U.sym), so a reader following this fixture
// sees the same shape a real ROM has.
const BASE_LAYOUT: Layout = { uploadLevelMusic: 0x008134, routine: 0x008148, bankAddr: 0x008740 }

describe('SpcBuilder level-music path gate (no ROM required)', () => {
  it('resolves and reads a fully valid path', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    const addr = getLevelMusicBankAddrIfReadable(rom)
    expect(addr).toBe(BASE_LAYOUT.bankAddr)
    expect(readBankSongPointers(rom, addr!)).toHaveLength(2)
  })

  it('a routine relocated but otherwise intact is still found (N2)', () => {
    // Every check below is defined relative to uploadLevelMusic/routine, not
    // to a fixed address, so an arbitrary relocation is still accepted.
    const layout: Layout = { uploadLevelMusic: 0x008900, routine: 0x008914, bankAddr: 0x008980 }
    expect(getLevelMusicBankAddrIfReadable(buildValidRom(layout))).toBe(layout.bankAddr)
  })

  it('resolves the same path through a copier header', () => {
    const base = buildValidRom(BASE_LAYOUT)
    const headered = new RomFile(
      'synthetic.smc',
      Buffer.concat([Buffer.alloc(COPIER_HEADER_SIZE, 0), base.buffer]),
    )
    expect(getLevelMusicBankAddrIfReadable(headered)).toBe(BASE_LAYOUT.bankAddr)
  })

  it('refuses when the call site opcode is not JSR', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(CALL_SITE, [0xea]) // NOP
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it.each(FIXED_OPCODE_OFFSETS)(
    'refuses when the header opcode at offset %i is corrupted',
    offset => {
      const rom = buildValidRom(BASE_LAYOUT)
      rom.writeAt(BASE_LAYOUT.uploadLevelMusic + offset, [0xea]) // NOP: not any fixed opcode here
      expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
    },
  )

  it('refuses when the head BNE lands anywhere but the routine', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.uploadLevelMusic + 4, [0x00]) // +0: targets itself, not +$0F
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when the BEQ lands anywhere but the routine', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.uploadLevelMusic + 11, [0x00])
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when the early-return BNE does not land on an RTS', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.uploadLevelMusic + 19, [0x00]) // now targets the routine's LDA, not RTS
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when an STA.W operand no longer targets the shared staging addresses (N3)', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    // Repoint the first STA.W from $0000 to $2140: opcodes are untouched.
    rom.writeAt(BASE_LAYOUT.routine + 3, [0x40, 0x21])
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when an LDA in the pattern is replaced, opcodes elsewhere unchanged', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.routine + 5, [0x60]) // RTS in place of the second LDA.B #imm
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('reproduces the real AddmusicK shape: JSR/RTS stub in place of the routine, filler at the derived address', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    // SEP #$20 / RTS in place of the first LDA.B #imm / STA.W pair, the
    // exact bytes measured on Grand Poo World 2 and Invictus at $008148.
    rom.writeAt(BASE_LAYOUT.routine, [0xe2, 0x20, 0x60])
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when the BRA no longer reaches the body', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.routine + 16, [0x00]) // displacement now targets itself
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses when the byte at the BRA is no longer a BRA, displacement left as-is', () => {
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.routine + 15, [0x60]) // RTS in place of BRA
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })

  it('refuses a kept BRA into a body that no longer matches StartMusicUpload', () => {
    // The BRA's target address is untouched; only what is written there
    // changed - a hack replacing the shared upload tail's own body.
    const rom = buildValidRom(BASE_LAYOUT)
    rom.writeAt(BASE_LAYOUT.routine + BODY_OFFSET, [0x60]) // RTS in place of LDA #$FF
    expect(getLevelMusicBankAddrIfReadable(rom)).toBeNull()
  })
})
