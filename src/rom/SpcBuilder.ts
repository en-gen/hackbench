/**
 * SpcBuilder.ts — Build playable SPC files from Super Mario World ROM data.
 *
 * The SNES SPC700 audio processor has 64KB of dedicated RAM (ARAM).
 * At startup, the game uploads three data blocks to ARAM:
 *   1. SPC engine code (N-SPC by Kankichi Ito) — from UploadSPCEngine ($80E8)
 *   2. BRR instrument samples — from UploadSamples ($80FD)
 *   3. A music bank (songs + sequence data) — from UploadMusicBank1/2/3
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

const UPLOAD_SPC_ENGINE   = 0x0080E8  // UploadSPCEngine routine
const UPLOAD_SAMPLES      = 0x0080FD  // UploadSamples routine
const UPLOAD_MUSIC_BANK1  = 0x00810E  // UploadMusicBank1 (overworld)
// UploadLevelMusic ($8134) has a conditional preamble (20 bytes) before the
// MusicBank2 LDA pattern at UploadOverworldMusic ($8148).
const UPLOAD_MUSIC_BANK2  = 0x008148  // UploadOverworldMusic (level music bank)
const UPLOAD_MUSIC_BANK3  = 0x008159  // UploadCreditsMusic

/** Read a 24-bit ROM address from three LDA #imm operands at offsets +1, +6, +11. */
function readUploadAddress(rom: RomFile, routineAddr: number): number {
  const lo   = rom.readByte(routineAddr + 1) ?? 0
  const hi   = rom.readByte(routineAddr + 6) ?? 0
  const bank = rom.readByte(routineAddr + 11) ?? 0
  return (bank << 16) | (hi << 8) | lo
}

// ── SPC file format constants ────────────────────────────────────────────────

const SPC_HEADER_SIZE = 256
const ARAM_SIZE       = 65536
const DSP_REG_SIZE    = 128
const SPC_FILE_SIZE   = SPC_HEADER_SIZE + ARAM_SIZE + DSP_REG_SIZE

/** SPC file signature: "SNES-SPC700 Sound File Data v0.30" + 0x1A1A */
const SPC_SIGNATURE = 'SNES-SPC700 Sound File Data v0.30\x1A\x1A'

// ── ROM block parser ─────────────────────────────────────────────────────────

interface RomBlock {
  /** Size of data payload (from header). */
  size: number
  /** ARAM destination address (from header). */
  aramDest: number
  /** Raw data bytes. */
  data: Uint8Array
}

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
    const size     = header[0] | (header[1] << 8)
    const aramDest = header[2] | (header[3] << 8)

    if (size === 0) break  // terminator block

    if (firstDest < 0) firstDest = aramDest

    const data = rom.readAt(offset + 4, size)
    if (!data) break

    // Copy to ARAM at the specified destination
    const end = Math.min(size, ARAM_SIZE - aramDest)
    for (let i = 0; i < end; i++) aram[aramDest + i] = data[i]

    blockCount++
    offset += 4 + size  // advance past header + data
  }

  console.log(`[SPC] Uploaded ${blockCount} blocks from ROM $${romAddr.toString(16)}, firstDest=$${firstDest.toString(16).padStart(4, '0')}`)
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
  const engineAddr  = readUploadAddress(rom, UPLOAD_SPC_ENGINE)
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
    case 'overworld': bankRoutineAddr = UPLOAD_MUSIC_BANK1; break
    case 'credits':   bankRoutineAddr = UPLOAD_MUSIC_BANK3; break
    default:          bankRoutineAddr = UPLOAD_MUSIC_BANK2; break
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
  //   4. Writes $F0 to CONTROL ($F1) — CLEARS ALL I/O PORTS including $F4
  //   5. Sets timer 0
  //   6. Enters APU_Loop at $0549
  //
  // If we start from APU_Start, the $F0 write to CONTROL wipes our BGM command.
  // So we simulate the init ourselves and set PC directly to APU_Loop ($0549).

  // Step 1-2: Zero work areas (same as engine init)
  for (let i = 0; i < 0xE8; i++) aram[i] = 0
  for (let i = 0x200; i < 0x400; i++) aram[i] = 0

  // Step 3: Read DSP defaults from the engine's ARAM tables
  // DefaultDSPRegs at $12A1, DefaultDSPVals at $1295, 12 entries each
  const DSP_DEFAULTS_COUNT = 12
  const DSP_REGS_ADDR  = 0x12A1
  const DSP_VALS_ADDR  = 0x1295
  const dspRegs = new Uint8Array(128)
  for (let i = 0; i < DSP_DEFAULTS_COUNT; i++) {
    const reg = aram[DSP_REGS_ADDR + i]
    const val = aram[DSP_VALS_ADDR + i]
    dspRegs[reg] = val
  }

  // Step 4: Set master tempo (engine sets $51 = $36)
  aram[0x51] = 0x36

  // Step 5: Set CONTROL ($F1) = $01 (timer 0 running, ports NOT cleared)
  aram[0xF1] = 0x01
  // Timer 0 target ($FA) = $10 (2ms interval)
  aram[0xFA] = 0x10

  // BGM command: I/O port 2 ($F6) is the music command port (SNES writes SPCIO2).
  // The engine also checks SPCOutBuffer+2 ($0C) — both must be set for the
  // engine to process the command on the first main loop iteration.
  aram[0xF6] = bgmCommand
  aram[0x0C] = bgmCommand

  // ── Build SPC file ──
  const spc = new Uint8Array(SPC_FILE_SIZE)

  // Header (256 bytes)
  const encoder = new TextEncoder()
  const sig = encoder.encode(SPC_SIGNATURE)
  spc.set(sig, 0)

  // CPU registers at offset 37
  // PC = APU_Loop ($0549) — skip init, start in main loop
  const APU_LOOP = 0x0549
  spc[37] = APU_LOOP & 0xFF
  spc[38] = (APU_LOOP >> 8) & 0xFF
  // A = 0, X = 0, Y = 0 (already zero)
  // PSW at offset 42 = 0
  // SP at offset 43 = $CF
  spc[43] = 0xCF

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

/** Get the ROM address of the overworld music bank (Bank 1). */
export function getOverworldMusicBankAddr(rom: RomFile): number {
  return readUploadAddress(rom, UPLOAD_MUSIC_BANK1)
}

/** Get the ROM address of the credits music bank (Bank 3). */
export function getCreditsMusicBankAddr(rom: RomFile): number {
  return readUploadAddress(rom, UPLOAD_MUSIC_BANK3)
}

/**
 * Count the number of songs in a music bank by reading the song pointer table.
 *
 * The music bank block data starts with a song pointer table: 2-byte ARAM
 * addresses that point into the song data region of the bank. We count
 * consecutive entries that point within the bank's ARAM range. The table
 * ends when we see a value outside the bank or reach the first pointer's
 * target address (the start of song data).
 */
export function countBankSongs(rom: RomFile, bankRomAddr: number): number {
  const header = rom.readAt(bankRomAddr, 4)
  if (!header) return 0
  const blockSize = header[0] | (header[1] << 8)
  const aramDest  = header[2] | (header[3] << 8)
  if (blockSize === 0) return 0

  const bankEnd = aramDest + blockSize
  // Read enough data for a reasonable pointer table (max 64 songs)
  const maxEntries = 64
  const tableData = rom.readAt(bankRomAddr + 4, maxEntries * 2)
  if (!tableData) return 0

  // Song pointers are ARAM addresses within the bank. They are NOT sorted.
  // The table ends when we hit a $0000 entry or a value outside the bank range.
  let count = 0
  for (let i = 0; i < maxEntries; i++) {
    const ptr = tableData[i * 2] | (tableData[i * 2 + 1] << 8)
    if (ptr === 0 || ptr < aramDest || ptr >= bankEnd) break
    count++
  }
  return count
}
