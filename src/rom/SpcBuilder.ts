/**
 * SpcBuilder.ts - Build playable SPC files from Super Mario World ROM data.
 *
 * The SNES SPC700 audio processor has 64KB of dedicated RAM (ARAM).
 * At startup, the game uploads three data blocks to ARAM:
 *   1. SPC engine code (N-SPC by Kankichi Ito) - from UploadSPCEngine ($80E8)
 *   2. BRR instrument samples - from UploadSamples ($80FD)
 *   3. A music bank (songs + sequence data) - from UploadMusicBank1/2/3
 *
 * Each ROM block has a 4-byte header: [size_lo, size_hi, dest_lo, dest_hi]
 * followed by raw data bytes.
 *
 * An SPC file packages the complete 64KB ARAM state + DSP registers + CPU state
 * as a snapshot that an SPC emulator can load and play.
 *
 * ROM addresses for each block are read from immediate operands in the upload
 * routines (same technique as Layer 3 GFX detection).
 *
 * References:
 *   - bank_00.asm: UploadSPCEngine ($80E8), UploadSamples ($80FD),
 *     UploadMusicBank1 ($810E), UploadLevelMusic ($8134), UploadCreditsMusic ($8159)
 *   - bank_0E.asm: SPC700 engine code, MusicBank1/2 data
 *   - bank_0F.asm: MusicSamples (BRR instrument data)
 *   - SPC file format: https://wiki.superfamicom.org/spc-and-rsn-file-format
 */

import { RomFile } from './RomFile'

// ── Upload routine addresses (from SMW_U.sym) ────────────────────────────────
// Each routine loads a 24-bit ROM address into _0/_1/_2 via three LDA #imm
// instructions. US version uses STA.W (3 bytes), so the pattern per byte is:
//   LDA.B #val (2 bytes) + STA.W addr (3 bytes) = 5 bytes per component.
// Operand bytes are at offsets +1, +6, +11 from the pattern start.

const UPLOAD_SPC_ENGINE = 0x0080e8 // UploadSPCEngine routine
const UPLOAD_SAMPLES = 0x0080fd // UploadSamples routine
const UPLOAD_MUSIC_BANK1 = 0x00810e // UploadMusicBank1 (overworld)
// UploadLevelMusic ($8134) has a conditional preamble (20 bytes) before the
// MusicBank2 LDA pattern at UploadOverworldMusic ($8148).
const UPLOAD_MUSIC_BANK2 = 0x008148 // UploadOverworldMusic (level music bank)
const UPLOAD_MUSIC_BANK3 = 0x008159 // UploadCreditsMusic

/** Read a 24-bit ROM address from three LDA #imm operands at offsets +1, +6, +11. */
function readUploadAddress(rom: RomFile, routineAddr: number): number {
  const lo = rom.readByte(routineAddr + 1) ?? 0
  const hi = rom.readByte(routineAddr + 6) ?? 0
  const bank = rom.readByte(routineAddr + 11) ?? 0
  return (bank << 16) | (hi << 8) | lo
}

// ── SPC file format constants ────────────────────────────────────────────────

const SPC_HEADER_SIZE = 256
const ARAM_SIZE = 65536
const DSP_REG_SIZE = 128
const SPC_FILE_SIZE = SPC_HEADER_SIZE + ARAM_SIZE + DSP_REG_SIZE

/** SPC file signature: "SNES-SPC700 Sound File Data v0.30" + 0x1A1A */
const SPC_SIGNATURE = 'SNES-SPC700 Sound File Data v0.30\x1A\x1A'

// ── ROM block parser ─────────────────────────────────────────────────────────

/**
 * Upload all consecutive ROM blocks into an ARAM buffer.
 * The SPC upload protocol (SPC700UploadLoop in bank_00.asm) sends blocks
 * until it hits a 0-size terminator. Each block: [size_lo, size_hi, dest_lo, dest_hi, ...data].
 * Returns the ARAM dest of the FIRST block (used as engine entry point).
 */
function uploadBlocks(rom: RomFile, romAddr: number, aram: Uint8Array): number {
  let offset = romAddr
  let firstDest = -1
  let blockCount = 0

  for (;;) {
    const header = rom.readAt(offset, 4)
    if (!header) break
    const size = header[0] | (header[1] << 8)
    const aramDest = header[2] | (header[3] << 8)

    if (size === 0) break // terminator block

    if (firstDest < 0) firstDest = aramDest

    const data = rom.readAt(offset + 4, size)
    if (!data) break

    // Copy to ARAM at the specified destination
    const end = Math.min(size, ARAM_SIZE - aramDest)
    for (let i = 0; i < end; i++) aram[aramDest + i] = data[i]

    blockCount++
    offset += 4 + size // advance past header + data
  }

  console.log(
    `[SPC] Uploaded ${blockCount} blocks from ROM $${romAddr.toString(16)}, firstDest=$${firstDest.toString(16).padStart(4, '0')}`,
  )
  return firstDest
}

// ── ARAM builder ─────────────────────────────────────────────────────────────

/**
 * Build a complete 64KB ARAM image by uploading ROM blocks.
 * Follows the game's init sequence: engine → samples → music bank.
 * Each ROM source may contain multiple consecutive blocks (the SPC upload
 * protocol processes blocks until a 0-size terminator).
 */
function buildAram(
  rom: RomFile,
  musicBankAddr: number,
): { aram: Uint8Array; engineEntry: number } | null {
  const engineAddr = readUploadAddress(rom, UPLOAD_SPC_ENGINE)
  const samplesAddr = readUploadAddress(rom, UPLOAD_SAMPLES)

  const aram = new Uint8Array(ARAM_SIZE)

  // Upload in game order: engine → samples → music bank
  const engineEntry = uploadBlocks(rom, engineAddr, aram)
  uploadBlocks(rom, samplesAddr, aram)
  uploadBlocks(rom, musicBankAddr, aram)

  if (engineEntry < 0) {
    console.warn('[SPC] Failed to upload engine blocks')
    return null
  }

  return { aram, engineEntry }
}

// ── SPC file packager ────────────────────────────────────────────────────────

/**
 * Build a complete .spc file buffer for a given BGM command.
 *
 * @param rom          ROM file to extract data from
 * @param bgmCommand   SPC BGM command byte (1-based song index within the bank)
 * @param musicBank    Which music bank to use: 'level' | 'overworld' | 'credits'
 * @returns            Uint8Array containing a valid .spc file, or null on failure
 */
export function buildSpc(
  rom: RomFile,
  bgmCommand: number,
  musicBank: 'level' | 'overworld' | 'credits' = 'level',
): Uint8Array | null {
  // Determine music bank ROM address
  let bankRoutineAddr: number
  switch (musicBank) {
    case 'overworld':
      bankRoutineAddr = UPLOAD_MUSIC_BANK1
      break
    case 'credits':
      bankRoutineAddr = UPLOAD_MUSIC_BANK3
      break
    default:
      bankRoutineAddr = UPLOAD_MUSIC_BANK2
      break
  }
  const musicBankAddr = readUploadAddress(rom, bankRoutineAddr)

  const result = buildAram(rom, musicBankAddr)
  if (!result) return null

  const { aram } = result

  // ── Simulate the engine's init (APU_Start → APU_Loop) ──
  // The engine's init at APU_Start ($0500):
  //   1. Zeros ARAM $00-$E7 (work RAM)
  //   2. Zeros ARAM $0200-$03FF (voice state)
  //   3. Writes default DSP register values from DefaultDSPRegs/Vals tables
  //   4. Writes $F0 to CONTROL ($F1) - CLEARS ALL I/O PORTS including $F4
  //   5. Sets timer 0
  //   6. Enters APU_Loop at $0549
  //
  // If we start from APU_Start, the $F0 write to CONTROL wipes our BGM command.
  // So we simulate the init ourselves and set PC directly to APU_Loop ($0549).

  // Step 1-2: Zero work areas (same as engine init)
  for (let i = 0; i < 0xe8; i++) aram[i] = 0
  for (let i = 0x200; i < 0x400; i++) aram[i] = 0

  // Step 3: Read DSP defaults from the engine's ARAM tables
  // DefaultDSPRegs at $12A1, DefaultDSPVals at $1295, 12 entries each
  const DSP_DEFAULTS_COUNT = 12
  const DSP_REGS_ADDR = 0x12a1
  const DSP_VALS_ADDR = 0x1295
  const dspRegs = new Uint8Array(128)
  for (let i = 0; i < DSP_DEFAULTS_COUNT; i++) {
    const reg = aram[DSP_REGS_ADDR + i]
    const val = aram[DSP_VALS_ADDR + i]
    dspRegs[reg] = val
  }

  // Step 4: Set master tempo (engine sets $51 = $36)
  aram[0x51] = 0x36

  // Step 5: Set CONTROL ($F1) = $01 (timer 0 running, ports NOT cleared)
  aram[0xf1] = 0x01
  // Timer 0 target ($FA) = $10 (2ms interval)
  aram[0xfa] = 0x10

  // BGM command: I/O port 2 ($F6) is the music command port (SNES writes SPCIO2).
  // The engine also checks SPCOutBuffer+2 ($0C) - both must be set for the
  // engine to process the command on the first main loop iteration.
  aram[0xf6] = bgmCommand
  aram[0x0c] = bgmCommand

  // ── Build SPC file ──
  const spc = new Uint8Array(SPC_FILE_SIZE)

  // Header (256 bytes)
  const encoder = new TextEncoder()
  const sig = encoder.encode(SPC_SIGNATURE)
  spc.set(sig, 0)

  // CPU registers at offset 37
  // PC = APU_Loop ($0549) - skip init, start in main loop
  const APU_LOOP = 0x0549
  spc[37] = APU_LOOP & 0xff
  spc[38] = (APU_LOOP >> 8) & 0xff
  // A = 0, X = 0, Y = 0 (already zero)
  // PSW at offset 42 = 0
  // SP at offset 43 = $CF
  spc[43] = 0xcf

  // ARAM dump at offset 256
  spc.set(aram, SPC_HEADER_SIZE)

  // DSP registers at offset 256 + 65536 = 65792
  const dspBase = SPC_HEADER_SIZE + ARAM_SIZE
  spc.set(dspRegs, dspBase)

  return spc
}

// ── Music bank address helpers ───────────────────────────────────────────────

/** Get the ROM address of the level music bank (Bank 2). */
export function getLevelMusicBankAddr(rom: RomFile): number {
  return readUploadAddress(rom, UPLOAD_MUSIC_BANK2)
}

const OPCODE_JSR = 0x20
const OPCODE_LDA_W = 0xad
const OPCODE_BNE = 0xd0
const OPCODE_LDA_IMM = 0xa9
const OPCODE_STA_W = 0x8d

/**
 * The unique `JSR UploadLevelMusic` in the level-load flow (bank_00.asm:2650,
 * file offset 0x1702). A stable anchor because a music hack replaces the
 * upload routines' bodies, not the level-load call site that invokes them
 * (CLAUDE.md: verify the path a fixed destination is reached by, not just
 * the destination's own bytes).
 */
const LEVEL_LOAD_MUSIC_CALL_SITE = 0x009702

/** The 3 direct-page addresses the upload pattern's STA.W operands must target. */
const UPLOAD_ADDR_TARGETS = [0x0000, 0x0001, 0x0002]

/**
 * Whether the 15-byte LDA.B #imm / STA.W pattern readUploadAddress depends
 * on is still present at `routineAddr`, gating on both opcodes AND the
 * STA.W operand at each of the three components (bank_00.asm:175-180):
 * opcode-only checks pass a hack that repoints the STA targets elsewhere
 * while leaving the LDA/STA opcodes themselves untouched.
 */
function uploadRoutineIntact(rom: RomFile, routineAddr: number): boolean {
  return [0, 5, 10].every((offset, i) => {
    if (rom.readByte(routineAddr + offset) !== OPCODE_LDA_IMM) return false
    if (rom.readByte(routineAddr + offset + 2) !== OPCODE_STA_W) return false
    const lo = rom.readByte(routineAddr + offset + 3)
    const hi = rom.readByte(routineAddr + offset + 4)
    if (lo === null || hi === null) return false
    return (lo | (hi << 8)) === UPLOAD_ADDR_TARGETS[i]
  })
}

/**
 * Locate the level music bank's upload routine by tracing the actual call
 * path from LEVEL_LOAD_MUSIC_CALL_SITE, gating on the opcode at every hop,
 * rather than trusting a fixed address for the routine itself: a routine a
 * hack relocates but leaves otherwise intact is still found this way. See
 * docs/music-bank-song-table.md.
 */
function locateLevelMusicUploadRoutine(rom: RomFile): number | null {
  if (rom.readByte(LEVEL_LOAD_MUSIC_CALL_SITE) !== OPCODE_JSR) return null
  const calleeLo = rom.readByte(LEVEL_LOAD_MUSIC_CALL_SITE + 1)
  const calleeHi = rom.readByte(LEVEL_LOAD_MUSIC_CALL_SITE + 2)
  if (calleeLo === null || calleeHi === null) return null
  const uploadLevelMusic = 0x008000 | (calleeHi << 8) | calleeLo

  // UploadLevelMusic opens LDA.W BonusGameActivate; BNE takes the common
  // "loading a new level" path straight to the upload routine
  // (bank_00.asm:166-167).
  if (rom.readByte(uploadLevelMusic) !== OPCODE_LDA_W) return null
  if (rom.readByte(uploadLevelMusic + 3) !== OPCODE_BNE) return null
  const displacement = rom.readByte(uploadLevelMusic + 4)
  if (displacement === null) return null
  const signed = displacement > 0x7f ? displacement - 0x100 : displacement
  const routine = ((uploadLevelMusic + 5 + signed) & 0xffff) | (uploadLevelMusic & 0xff0000)

  return uploadRoutineIntact(rom, routine) ? routine : null
}

/**
 * The level music bank's ROM address, or null when the path to its upload
 * routine cannot be verified end to end. Unlike getLevelMusicBankAddr, this
 * refuses rather than returning whatever readUploadAddress derives from a
 * routine (or a call path to it) it cannot verify.
 */
export function getLevelMusicBankAddrIfReadable(rom: RomFile): number | null {
  const routine = locateLevelMusicUploadRoutine(rom)
  return routine === null ? null : readUploadAddress(rom, routine)
}

/** Get the ROM address of the overworld music bank (Bank 1). */
export function getOverworldMusicBankAddr(rom: RomFile): number {
  return readUploadAddress(rom, UPLOAD_MUSIC_BANK1)
}

/** Get the ROM address of the credits music bank (Bank 3). */
export function getCreditsMusicBankAddr(rom: RomFile): number {
  return readUploadAddress(rom, UPLOAD_MUSIC_BANK3)
}

interface BankHeader {
  size: number
  aramDest: number
}

/** The 4-byte block header getBankBlockSize and readBankSongPointers both read. */
function readBankHeader(rom: RomFile, bankRomAddr: number): BankHeader | null {
  const header = rom.readAt(bankRomAddr, 4)
  if (!header) return null
  return { size: header[0] | (header[1] << 8), aramDest: header[2] | (header[3] << 8) }
}

/** Bank block size in bytes, from the same 4-byte header readBankSongPointers parses. */
export function getBankBlockSize(rom: RomFile, bankRomAddr: number): number {
  return readBankHeader(rom, bankRomAddr)?.size ?? 0
}

export interface BankSongPointer {
  /** 1-based song index within the bank; also the SPC BGM command sent to the engine. */
  bgmCommand: number
  /** ARAM address this song's pointer-table entry resolves to. */
  aramPointer: number
}

/**
 * Read a music bank's song pointer table, stopping at the table's true end
 * rather than reading into a song's own sub-pointers. See
 * docs/music-bank-song-table.md for the full derivation and issue #417.
 */
export function readBankSongPointers(rom: RomFile, bankRomAddr: number): BankSongPointer[] {
  const header = readBankHeader(rom, bankRomAddr)
  if (!header || header.size === 0) return []
  const { size: blockSize, aramDest } = header

  const bankEnd = aramDest + blockSize
  const tableAddr = bankRomAddr + 4
  // How many bytes actually remain in the ROM file from here: RomFile.readAt
  // refuses the whole read rather than truncating on overrun, so a declared
  // blockSize past the end of a short ROM must not be requested outright.
  const tableOffset = rom.fileOffsetOf(tableAddr)
  const availableBytes = tableOffset === null ? 0 : rom.buffer.length - tableOffset
  // ABSOLUTE_ENTRY_CAP is a defensive ceiling against a garbage header (e.g.
  // an unrelated large blockSize), not a claim about how many songs a real
  // bank can hold; the loop's own minSongStart bound is what actually
  // decides where a real table ends.
  const ABSOLUTE_ENTRY_CAP = 512
  const maxEntries = Math.max(
    0,
    Math.min(Math.floor(blockSize / 2), Math.floor(availableBytes / 2), ABSOLUTE_ENTRY_CAP),
  )
  const tableData = maxEntries > 0 ? rom.readAt(tableAddr, maxEntries * 2) : null
  if (!tableData) return []

  const entries: BankSongPointer[] = []
  let minSongStart = bankEnd
  for (let i = 0; i < maxEntries; i++) {
    if (aramDest + i * 2 >= minSongStart) break
    const ptr = tableData[i * 2] | (tableData[i * 2 + 1] << 8)
    if (ptr === 0 || ptr <= aramDest || ptr >= bankEnd) break
    entries.push({ bgmCommand: i + 1, aramPointer: ptr })
    minSongStart = Math.min(minSongStart, ptr)
  }
  return entries
}

/** Count the songs in a music bank by reading its song pointer table. */
export function countBankSongs(rom: RomFile, bankRomAddr: number): number {
  return readBankSongPointers(rom, bankRomAddr).length
}
