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
import { BytePattern, WILD, matchesAt } from './BytePattern'
import { loromToOffset } from './addressing'

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

export const SPC_HEADER_SIZE = 256
export const ARAM_SIZE = 65536
export const DSP_REG_SIZE = 128
const SPC_FILE_SIZE = SPC_HEADER_SIZE + ARAM_SIZE + DSP_REG_SIZE

/** SPC file signature: "SNES-SPC700 Sound File Data v0.30" + 0x1A1A */
export const SPC_SIGNATURE = 'SNES-SPC700 Sound File Data v0.30\x1A\x1A'

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
/**
 * Extra SPC I/O port values baked into the snapshot alongside the BGM
 * command.
 *
 * These exist because the player engine loads a 64 KB ARAM snapshot and
 * exposes no way to write a port afterwards, so a control that the game
 * implements as a single port write has to be set BEFORE the snapshot is
 * handed over. A caller toggling one rebuilds and reloads, which restarts
 * the track; that is a limitation of the player, not of the ROM.
 *
 * The SNES writes $2140-$2143 and the SPC reads $F4-$F7, and the game
 * mirrors SPCIO0-3 ($1DF9-$1DFC) onto them in NMI (bank_00.asm:213-218).
 * So port 0 is $F4, port 1 is $F5 and port 2 is $F6.
 */
export interface SpcPorts {
  /**
   * Port 0. $FF is `!SFX_HURRYUP` (constants.asm:322), the byte
   * UpdateStatusBar writes when the timer ticks to 099 (bank_00.asm:1591).
   * It both plays the jingle and speeds the music up.
   */
  port0?: number
  /**
   * Port 1. $02 is `!SFX_YOSHIDRUMON` and $03 `!SFX_YOSHIDRUMOFF`
   * (constants.asm:325-326). Port 1 carries only four commands in total.
   */
  port1?: number
}

export function buildSpc(
  rom: RomFile,
  bgmCommand: number,
  musicBank: 'level' | 'overworld' | 'credits' = 'level',
  ports: SpcPorts = {},
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

  // Ports 0 and 1, when the caller wants a control the game drives with a
  // single port write: hurry-up on port 0, Yoshi drums on port 1. Left
  // untouched when absent, so the default snapshot is exactly what the
  // engine sees on an ordinary track change.
  // No byte mask: `aram` is a Uint8Array and truncates on assignment, so a
  // mask here would be code that no test could turn red.
  if (ports.port0 !== undefined) aram[0xf4] = ports.port0
  if (ports.port1 !== undefined) aram[0xf5] = ports.port1

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
const OPCODE_BRA = 0x80

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
 * The routine a `JSR abs` at `callSite` transfers to, or null when the call
 * site no longer holds a JSR.
 *
 * The bank comes from the CALL SITE, not from a constant: a JSR is
 * bank-local, so the callee is wherever the operand points within the bank
 * the JSR itself sits in.
 *
 * No check is made that the operand is above $8000. It reads like one is
 * needed - the low half of a LoROM bank is WRAM and registers, not code -
 * but `loromToOffset` already returns null for any address under $8000 in
 * banks $00-$3F (addressing.ts:51), so every subsequent read of such a
 * target fails and the shape gate refuses. A guard here would be dead code
 * with a test that could not go red.
 *
 * Measured across the six-ROM corpus: the three stock ROMs hold JSR at each
 * of the three music call sites. The three AddmusicK ROMs hold $80 (BRA) at
 * the overworld and credits sites, but $EA $EA $EA (NOP) at the level site,
 * $009702 - not a branch there.
 */
function calleeOf(rom: RomFile, callSite: number): number | null {
  if (rom.readByte(callSite) !== OPCODE_JSR) return null
  const lo = rom.readByte(callSite + 1)
  const hi = rom.readByte(callSite + 2)
  if (lo === null || hi === null) return null
  return (callSite & 0xff0000) | (hi << 8) | lo
}

const OPCODE_BEQ = 0xf0
const OPCODE_RTS = 0x60

/**
 * StartMusicUpload's own body (bank_00.asm:152-155): `LDA.B #-1` (opcode
 * $A9 - the immediate is always $FF, not an operand that varies) then
 * `STA.W HW_APUIO1` ($2141, a fixed hardware register) then `JSR
 * UploadDataToSPC`. The JSR's own target is wildcarded; the rest proves the
 * BRA below lands IN this body and not in a replacement that happens to
 * share its address - a kept BRA into a hijacked body must still refuse.
 */
const START_MUSIC_UPLOAD_BODY: BytePattern = [0xa9, 0xff, 0x8d, 0x41, 0x21, OPCODE_JSR, WILD, WILD]

/**
 * UploadLevelMusic's conditional header (bank_00.asm:165-173). The BNE at
 * the head is the BONUS-GAME edge; loading a new level takes none of these
 * three branches and falls straight through into UploadOverworldMusic
 * (:174). Opcodes are pinned. Every operand this reads - the two WRAM
 * addresses, the CMP immediate, both ORA.W addresses - only selects at
 * runtime between two destinations locateLevelMusicUploadRoutine verifies
 * independently below (the routine, and the RTS an early return lands on),
 * never a third one, so none of them can move where the code goes and stay
 * wildcarded. The three branch displacements are NOT wildcarded away here
 * because the pattern only proves their opcode; locateLevelMusicUploadRoutine
 * reads and checks where each one actually lands.
 */
const UPLOAD_LEVEL_MUSIC_HEADER: BytePattern = [
  OPCODE_LDA_W,
  WILD,
  WILD, // LDA.W BonusGameActivate
  OPCODE_BNE,
  WILD,
  OPCODE_LDA_W,
  WILD,
  WILD, // LDA.W OverworldOverride
  0xc9,
  WILD, // CMP.B #imm
  OPCODE_BEQ,
  WILD,
  0x0d,
  WILD,
  WILD, // ORA.W SublevelCount
  0x0d,
  WILD,
  WILD, // ORA.W ShowMarioStart
  OPCODE_BNE,
  WILD,
]

/** The 3 × (LDA.B #imm + STA.W abs) that follow the header, at `routine`. */
const UPLOAD_TRIPLE_LENGTH = 15

/**
 * The absolute target of a PC-relative branch at `at`, or null when the
 * opcode there is not `opcode`. Shared by BNE, BEQ and BRA: all three
 * encode a signed 8-bit displacement from the byte after the instruction.
 */
function relBranchTarget(rom: RomFile, at: number, opcode: number): number | null {
  if (rom.readByte(at) !== opcode) return null
  const displacement = rom.readByte(at + 1)
  if (displacement === null) return null
  const signed = displacement > 0x7f ? displacement - 0x100 : displacement
  return ((at + 2 + signed) & 0xffff) | (at & 0xff0000)
}

/**
 * Locate the level music bank's upload routine by tracing the actual call
 * path from LEVEL_LOAD_MUSIC_CALL_SITE and checking the whole run through to
 * the BRA that hands off to StartMusicUpload (bank_00.asm:165-181) - not
 * just the bonus-game BNE at the head.
 */
function locateLevelMusicUploadRoutine(rom: RomFile): number | null {
  const uploadLevelMusic = calleeOf(rom, LEVEL_LOAD_MUSIC_CALL_SITE)
  if (uploadLevelMusic === null) return null

  // loromToOffset, not rom.fileOffsetOf: matchesAt wants the CART-RELATIVE
  // offset readAtFileOffset takes, and fileOffsetOf already adds the copier
  // header on a headered ROM, which double-counts it here.
  const headerOffset = loromToOffset(uploadLevelMusic, rom.romSize)
  if (headerOffset === null) return null
  if (!matchesAt(rom, headerOffset, UPLOAD_LEVEL_MUSIC_HEADER)) return null

  // The header's opcodes are the only way through to here on an ordinary
  // level load, so the routine sits exactly one header past its start.
  const routine = uploadLevelMusic + UPLOAD_LEVEL_MUSIC_HEADER.length
  if (!uploadRoutineIntact(rom, routine)) return null

  // Both the bonus-game BNE and the intro-level BEQ must reach the SAME
  // UploadOverworldMusic entry this function just verified - if either
  // targets somewhere else, that edge has been diverted.
  if (relBranchTarget(rom, uploadLevelMusic + 3, OPCODE_BNE) !== routine) return null
  if (relBranchTarget(rom, uploadLevelMusic + 10, OPCODE_BEQ) !== routine) return null

  // The "already uploaded, don't re-upload" BNE must land on an RTS. Not a
  // hardcoded address: the displacement is read from this ROM's own bytes,
  // and only the opcode at wherever it lands is asserted.
  const earlyReturn = relBranchTarget(rom, uploadLevelMusic + 18, OPCODE_BNE)
  if (earlyReturn === null || rom.readByte(earlyReturn) !== OPCODE_RTS) return null

  const braTarget = relBranchTarget(rom, routine + UPLOAD_TRIPLE_LENGTH, OPCODE_BRA)
  if (braTarget === null) return null
  const bodyOffset = loromToOffset(braTarget, rom.romSize)
  if (bodyOffset === null) return null
  return matchesAt(rom, bodyOffset, START_MUSIC_UPLOAD_BODY) ? routine : null
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

/** An engine-and-samples ARAM image, and where the engine code landed. */
export interface EngineImage {
  /** 64 KB of ARAM holding the SPC engine and the BRR samples. */
  aram: Uint8Array
  /** ARAM address the engine's first block uploaded to. */
  engineLo: number
  /** One past the last byte of that block. */
  engineHi: number
  /**
   * Every block the engine upload wrote, in order.
   *
   * Kept rather than discarded because a reader needs the span of the
   * block a table lives in as a real read bound. The stock engine uploads
   * three, and the tables and phrases are all in the second.
   */
  blocks: ReadonlyArray<{ dest: number; size: number }>
}

/**
 * Upload the engine and the samples, and say where the engine code sits.
 *
 * No music bank: sound effects live in the engine upload's second block
 * (`SoundEffects`, bank_0E.asm:2025), so this image already holds them.
 * See docs/sfx-tables.md.
 *
 * Gated, unlike `buildAram`. Both upload routines have to still be the
 * shape `readUploadAddress` assumes, or the addresses it derives name
 * blocks this ROM never uploads.
 *
 * `engineLo`/`engineHi` bound the FIRST block only, which is where the
 * stock readers and init sequence sit on all six corpus ROMs. That is a
 * measurement, not an invariant: the stock engine uploads three blocks and
 * a hack could emit them in another order, in which case a perfectly good
 * reader is not found and the caller refuses. That fails closed, which is
 * the right direction, but it is a false negative rather than a guarantee.
 * `blocks` carries all of them so a caller can bound differently.
 */
export function buildEngineImage(rom: RomFile): EngineImage | null {
  if (!uploadRoutineIntact(rom, UPLOAD_SPC_ENGINE)) return null
  if (!uploadRoutineIntact(rom, UPLOAD_SAMPLES)) return null

  const aram = new Uint8Array(ARAM_SIZE)
  const engineBlocks = uploadBlockSpans(rom, readUploadAddress(rom, UPLOAD_SPC_ENGINE), aram)
  if (engineBlocks.length === 0) return null
  // Checked for outcome, not only for shape. A samples walk that yields
  // nothing leaves a well-formed snapshot with no BRR data, which plays as
  // silence and is indistinguishable from an empty phrase.
  if (uploadBlockSpans(rom, readUploadAddress(rom, UPLOAD_SAMPLES), aram).length === 0) return null

  const first = engineBlocks[0]
  return {
    aram,
    engineLo: first.dest,
    engineHi: first.dest + first.size,
    blocks: engineBlocks,
  }
}

/**
 * The same walk `uploadBlocks` does, reporting each block's ARAM span.
 *
 * Separate from `uploadBlocks` rather than replacing it: that one returns
 * the first destination and is called from three places on the music path,
 * and widening its return type to serve one new caller would churn all of
 * them for nothing.
 */
function uploadBlockSpans(
  rom: RomFile,
  romAddr: number,
  aram: Uint8Array,
): Array<{ dest: number; size: number }> {
  const spans: Array<{ dest: number; size: number }> = []
  let offset = romAddr

  for (;;) {
    const header = rom.readAt(offset, 4)
    if (!header) break
    const size = header[0] | (header[1] << 8)
    const dest = header[2] | (header[3] << 8)
    if (size === 0) break // terminator

    const data = rom.readAt(offset + 4, size)
    if (!data) break

    const end = Math.min(size, ARAM_SIZE - dest)
    for (let i = 0; i < end; i++) aram[dest + i] = data[i]
    spans.push({ dest, size: end })
    offset += 4 + size
  }
  return spans
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
 * `JSR UploadMusicBank1` on the title-screen load path (bank_00.asm:2623).
 * UploadMusicBank1 is called from two places on a stock cart, $0096C3 and
 * $00A0B3; either would do as an anchor, and this is the earlier one.
 */
const OVERWORLD_MUSIC_CALL_SITE = 0x0096c3

/** `JSR UploadCreditsMusic` on the credits load path (bank_00.asm:183). */
const CREDITS_MUSIC_CALL_SITE = 0x0094a0

/**
 * The overworld and credits banks reached the same way as the level bank:
 * from a call site, gating on the opcode there and on the routine's shape.
 *
 * Neither had a gate before, and the credits one is why this matters. On all
 * three AddmusicK carts in the corpus the credits upload routine at $008159
 * is BYTE-IDENTICAL to stock and still holds the stock operands, so every
 * check anchored on the routine itself passes and getCreditsMusicBankAddr
 * hands back $03E400 with full confidence. Nothing calls it: $0094A0 holds
 * $80 (BRA), not JSR. Existing is not the same as reached, and without this
 * the bank switcher would play a stock credits soundtrack for a cart that
 * has replaced its music wholesale.
 *
 * Unlike the level bank there is no guard to hop: both routines begin the
 * LDA #imm / STA.W triple directly (bank_00.asm:145, 183).
 */
function bankAddrIfReached(rom: RomFile, callSite: number): number | null {
  const routine = calleeOf(rom, callSite)
  if (routine === null) return null
  return uploadRoutineIntact(rom, routine) ? readUploadAddress(rom, routine) : null
}

/**
 * The overworld music bank's ROM address, or null when the path to its
 * upload routine cannot be verified.
 */
export function getOverworldMusicBankAddrIfReadable(rom: RomFile): number | null {
  return bankAddrIfReached(rom, OVERWORLD_MUSIC_CALL_SITE)
}

/**
 * The credits music bank's ROM address, or null when the path to its upload
 * routine cannot be verified.
 */
export function getCreditsMusicBankAddrIfReadable(rom: RomFile): number | null {
  return bankAddrIfReached(rom, CREDITS_MUSIC_CALL_SITE)
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
 * docs/spikes/music-bank-song-table.md for the full derivation and issue #417.
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
