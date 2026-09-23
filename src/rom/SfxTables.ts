/**
 * The SPC engine's two sound-effect pointer tables, and playable snapshots
 * of what they point at.
 *
 * Sound effects are not in a music bank. They ride in the engine upload's
 * second block, so the engine-and-samples image already holds them. Each of
 * the two APU ports that carries SFX has its own pointer table, read by its
 * own routine inside the engine. The derivation, the citations and the
 * corpus measurements are in docs/sfx-tables.md.
 *
 * Nothing here hardcodes a table address. The reader routine carries its
 * table in its own operands, so the table is read from the instruction that
 * reads it, and a ROM whose engine has been replaced reports unavailable
 * rather than falling back to the stock address. On an AddmusicK ROM the
 * whole driver is different and the reader pattern is simply absent, which
 * is the case this refusal exists for.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findInBytes } from './BytePattern'
import {
  buildEngineImage,
  ARAM_SIZE,
  DSP_REG_SIZE,
  SPC_HEADER_SIZE,
  SPC_SIGNATURE,
} from './SpcBuilder'

/**
 * The two ports that carry table-driven sound effects.
 *
 * Port 1 is deliberately absent: its ids are hand-written routines in the
 * engine with no table behind them, so there is nothing to enumerate.
 */
export type SfxPort = 0 | 3

export const SFX_PORTS: readonly SfxPort[] = [0, 3] as const

/** SNES-side mirror of each port, for citing in the UI. */
export const SFX_PORT_MIRROR: Record<SfxPort, string> = { 0: '$1DF9', 3: '$1DFC' }

/**
 * Direct-page base of the engine's copy of the input ports: a reader for
 * port n opens `MOV A,$04+n`.
 *
 * Measured, not assumed. On the stock engine the two readers sit at ARAM
 * $071F and $084E with dp operands $04 and $07, which is port 0 and port 3.
 * A first attempt derived $0A from where the music command lands and found
 * nothing at all, so the value is pinned by SfxTables.rom.test.ts.
 */
const PORT_MIRROR_BASE = 0x04

/** ARAM input ports: the SNES writes $2140-$2143, the SPC reads $F4-$F7. */
const APU_IN_PORT = 0xf4

export interface SfxEntry {
  /** 1-based id, the byte the game writes to the port. */
  id: number
  idHex: string
  /** Where this id's pointer-table slot points, in ARAM. */
  aramPointer: number
  /**
   * The phrase is a single end marker, so this id renders silent.
   * Correct behaviour, not a fault: port 0's $22 and $24 are both like this.
   */
  empty: boolean
}

export interface SfxTable {
  port: SfxPort
  /** ARAM address of the table, recovered from the reader's own operands. */
  tableAram: number
  /** ARAM address of the reader routine, so a reader can check the claim. */
  readerAram: number
  entries: SfxEntry[]
}

export type SfxTableResult =
  { status: 'ok'; table: SfxTable } | { status: 'unavailable'; reason: string }

/**
 * The reader's instruction sequence, as a byte pattern with its operands
 * wild (bank_0E.asm:320-328 for port 0, 479-488 for port 3):
 *
 *   MOV A,dp      E4 nn     nn is $04+port, which names the port
 *   ASL A         1C
 *   MOV Y,A       FD
 *   MOV A,!t-2+Y  F6 lo hi
 *   MOV dp,A      C4 pp
 *   MOV A,!t-1+Y  F6 lo hi
 *   MOV dp+1,A    C4 pp
 */
const READER: BytePattern = [
  0xe4,
  WILD,
  0x1c,
  0xfd,
  0xf6,
  WILD,
  WILD,
  0xc4,
  WILD,
  0xf6,
  WILD,
  WILD,
  0xc4,
  WILD,
]

/** Offsets into READER of the two absolute operands and the port operand. */
const PORT_OPERAND = 1
const LOW_OPERAND = 5
const HIGH_OPERAND = 10

/**
 * The most entries a table can have, derived rather than assumed.
 *
 * The reader does `MOV A,dp : ASL A : MOV Y,A`, and the SPC700's ASL A is
 * 8-bit, so Y is `(id << 1) & 0xFF`. Id $80 wraps to Y=0 and id $81 aliases
 * onto id $01, which means only $01..$7F are reachable at all. The opcode
 * proving it, $1C, is already byte 2 of READER.
 *
 * A table longer than this is not more effects; it is entries the game has
 * no way to ask for.
 */
const MAX_ENTRIES = 0x7f

const word = (aram: Uint8Array, at: number): number => aram[at] | (aram[at + 1] << 8)

interface Reader {
  at: number
  table: number
}

/**
 * Locate the reader for one port and recover its table address.
 *
 * Three gates, and the middle one is the load-bearing one. The two absolute
 * operands must be consecutive, because the routine reads a pointer's low
 * byte from `table-2+Y` and its high byte from `table-1+Y`. A pattern that
 * only matched the opcodes would accept any routine of this shape reading
 * any two unrelated addresses.
 */
function findReader(aram: Uint8Array, port: SfxPort, lo: number, hi: number): Reader[] {
  const readers: Reader[] = []
  for (const at of findInBytes(aram, READER, lo, hi)) {
    if (aram[at + PORT_OPERAND] !== PORT_MIRROR_BASE + port) continue
    const low = word(aram, at + LOW_OPERAND)
    const high = word(aram, at + HIGH_OPERAND)
    if (high !== low + 1) continue
    // The operand is `table-2` because Y is the id doubled, so id 1 lands
    // on the table's first slot.
    readers.push({ at, table: low + 2 })
  }
  return readers
}

/**
 * Read one port's table.
 *
 * The entry count is bounded two ways, and both are needed. A slot that
 * reaches the smallest pointer seen so far is past the end, the same rule
 * `readBankSongPointers` uses. And port 3's table runs straight into port
 * 0's, so the other table's base is a hard fence: without it a scan of
 * port 3 walks on into port 0's entries and reports far too many.
 */
export function readSfxTable(rom: RomFile, port: SfxPort): SfxTableResult {
  const image = buildEngineImage(rom)
  if (image === null) {
    return {
      status: 'unavailable',
      reason:
        'The SPC engine upload routine could not be verified, so no engine image can be built. ' +
        'A music patch such as AddmusicK replaces it along with the whole sound driver.',
    }
  }

  const { aram, engineLo, engineHi } = image

  // EVERY port's reader is resolved before any table is read, because a
  // table's length cannot be established without knowing what sits above it.
  //
  // This is not belt and braces. Port 3's table ends at $5683 on the stock
  // ROMs while its own lowest pointer is $56E3, sixty bytes higher, so its
  // own pointers do not bound it: an unfenced read runs into port 0's table
  // and reports 94 effects instead of 52. And the over-read is
  // SELF-CONSISTENT ($561B + 94*2 = $56D7, exactly the lowest pointer), so
  // no check on the port's own data can tell the two apart. Only port 0's
  // table being at $5683 distinguishes them.
  //
  // So if any port's reader is missing or ambiguous, every port refuses.
  // A number we cannot establish is worse than no number, because the panel
  // would make all 94 clickable and the engine bounds-checks nothing.
  const readers = new Map<SfxPort, Reader>()
  for (const p of SFX_PORTS) {
    const found = findReader(aram, p, engineLo, engineHi)
    if (found.length === 1) {
      readers.set(p, found[0])
      continue
    }
    const why =
      found.length === 0
        ? `no table reader for port ${p} (${SFX_PORT_MIRROR[p]})`
        : `${found.length} candidate readers for port ${p}; cannot say which one runs`
    return {
      status: 'unavailable',
      reason:
        `This ROM's sound effect tables cannot be listed: ${why}. Each table is bounded by the ` +
        `next one above it, so one unreadable port leaves the others' lengths unestablished.`,
    }
  }

  const reader = readers.get(port)!

  // The block the table sits in is the outer bound; the next table above it
  // is the real one. Both tables share a block on a stock ROM, so the block
  // alone would not separate them.
  const holder = image.blocks.find(b => reader.table >= b.dest && reader.table < b.dest + b.size)
  if (!holder) {
    return {
      status: 'unavailable',
      reason: `The table for port ${port} at $${reader.table.toString(16).toUpperCase()} is outside every block the engine uploads.`,
    }
  }
  let hardStop = holder.dest + holder.size
  for (const [other, r] of readers) {
    if (other !== port && r.table > reader.table) hardStop = Math.min(hardStop, r.table)
  }

  const entries: SfxEntry[] = []
  let lowestPointer = hardStop
  for (let i = 0; i < MAX_ENTRIES; i++) {
    const slot = reader.table + i * 2
    if (slot + 1 >= hardStop) break
    if (slot >= lowestPointer) break
    const ptr = word(aram, slot)
    // No `ptr >= aram.length` check: `word` returns at most $FFFF and ARAM
    // is exactly 64 KB, so it could never fire. `ptr === 0` is likewise
    // covered, since the table base is always at least 2.
    if (ptr <= reader.table) break
    entries.push({
      id: i + 1,
      idHex: `$${(i + 1).toString(16).toUpperCase().padStart(2, '0')}`,
      aramPointer: ptr,
      empty: aram[ptr] === 0,
    })
    lowestPointer = Math.min(lowestPointer, ptr)
  }

  if (entries.length === 0) {
    return {
      status: 'unavailable',
      reason: `The table for port ${port} at $${reader.table.toString(16).toUpperCase()} holds no usable pointers.`,
    }
  }

  return {
    status: 'ok',
    table: { port, tableAram: reader.table, readerAram: reader.at, entries },
  }
}

// ── Building a playable snapshot ──────────────────────────────────────────

/**
 * `MOV X,#count : MOV A,!regs+X : MOV Y,A : MOV A,!vals+X : CALL WriteDSPReg`
 *
 * The engine's own DSP initialisation. Read rather than hardcoded: buildSpc
 * still uses fixed $12A1/$1295 for the same two tables, which is the
 * assumption this avoids. Retrofitting buildSpc is issue #461.
 */
const DSP_DEFAULTS: BytePattern = [0xcd, WILD, 0xf5, WILD, WILD, 0xfd, 0xf5, WILD, WILD, 0x3f]

/** `MOV A,#$01 : MOV !$00F1,A : MOV Y,!$00FD` - the engine's main loop. */
const APU_LOOP: BytePattern = [0xe8, 0x01, 0xc5, 0xf1, 0x00, 0xec, 0xfd, 0x00]

/** `MOV A,#tempo : MOV dp,A` immediately before that loop entry. */
const TEMPO: BytePattern = [0xe8, WILD, 0xc4, WILD, 0xe8, 0x01, 0xc5, 0xf1, 0x00]

/**
 * A playable .spc for one sound effect, or null when the port's table
 * cannot be read.
 *
 * The id goes on the port's INPUT register ($F4+port) with no BGM command,
 * so the engine plays the effect over silence. `CopyToSNES` edge-detects
 * the port (bank_0E.asm:111-129), which is why the value simply sitting in
 * the snapshot is enough to trigger it.
 */
export function buildSfxSpc(rom: RomFile, port: SfxPort, id: number): Uint8Array | null {
  const table = readSfxTable(rom, port)
  if (table.status !== 'ok') return null
  if (!table.table.entries.some(e => e.id === id)) return null

  const image = buildEngineImage(rom)
  if (image === null) return null
  const { aram, engineLo, engineHi } = image

  const loop = findInBytes(aram, APU_LOOP, engineLo, engineHi)
  const dsp = findInBytes(aram, DSP_DEFAULTS, engineLo, engineHi)
  const tempo = findInBytes(aram, TEMPO, engineLo, engineHi)
  // Each must be unique. Two matches means we cannot say which the engine
  // runs, and starting the snapshot at the wrong one yields silence or noise
  // with no indication which.
  if (loop.length !== 1 || dsp.length !== 1 || tempo.length !== 1) return null

  // The engine's init zeroes these before entering its loop; the snapshot
  // starts at the loop, so it has to arrive in that state.
  for (let i = 0; i < 0xe8; i++) aram[i] = 0
  for (let i = 0x200; i < 0x400; i++) aram[i] = 0

  const dspRegs = new Uint8Array(DSP_REG_SIZE)
  const count = aram[dsp[0] + 1] + 1
  const regsAt = word(aram, dsp[0] + 3)
  const valsAt = word(aram, dsp[0] + 7)
  for (let i = 0; i < count; i++) {
    const reg = aram[regsAt + i]
    if (reg < DSP_REG_SIZE) dspRegs[reg] = aram[valsAt + i]
  }

  aram[aram[tempo[0] + 3]] = aram[tempo[0] + 1]
  aram[0xf1] = 0x01 // timer 0 running, ports NOT cleared
  aram[0xfa] = 0x10 // timer 0 target, a 2 ms tick
  aram[APU_IN_PORT + port] = id

  const spc = new Uint8Array(SPC_HEADER_SIZE + ARAM_SIZE + DSP_REG_SIZE)
  spc.set(new TextEncoder().encode(SPC_SIGNATURE), 0)
  const entry = loop[0] + 5 // the MOV Y,!$00FD that opens the loop body
  spc[37] = entry & 0xff
  spc[38] = (entry >> 8) & 0xff
  spc[43] = 0xcf // stack pointer
  spc.set(aram, SPC_HEADER_SIZE)
  spc.set(dspRegs, SPC_HEADER_SIZE + ARAM_SIZE)
  return spc
}
