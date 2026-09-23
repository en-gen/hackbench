/**
 * Which CGRAM indices this cartridge cycles, where their frame tables are,
 * and how many phases each has. All three are operands inside the NMI
 * handler rather than entries in a data table, so they are read from the
 * cart; a context whose bytes do not decode, or whose routine is no longer
 * reached, reports itself unavailable and emits nothing.
 *
 * A cart that moved the routine out of bank $00 is read by walking its
 * instructions to the first CGRAM write its own control flow reaches, never
 * by scanning bytes for one.
 *
 * Kernel and callers: bank_00.asm:4667-4677, :4663-4665, :4779-4784.
 * Approaches: smw.asm:43, bank_00.asm:194-196, :288, :4635, :4644, :4760.
 * The derivation, the phase arithmetic, the known gaps in the reach check
 * and the per-cart corpus results are in docs/spikes/palette-animation-detect.md.
 */

import type { RomFile } from './RomFile'
import { LOROM_BANK_SIZE, COPIER_HEADER_SIZE } from './addressing'
import { hex2, hex6 } from './hex'

// ── Opcodes ──────────────────────────────────────────────────────────────

const OP_LDA_IMM = 0xa9
const OP_LDA_DP = 0xa5
const OP_LDA_ABS_Y = 0xb9
const OP_STA_ABS = 0x8d
const OP_STA_DP = 0x85
const OP_STZ_DP = 0x64
const OP_AND_IMM = 0x29
const OP_LSR_A = 0x4a
const OP_CLC = 0x18
const OP_ADC_DP = 0x65
const OP_TAY = 0xa8
const OP_JSR_ABS = 0x20
const OP_JMP_ABS = 0x4c
const OP_JML_LONG = 0x5c
const OP_RTS = 0x60

/** Every 65816 opcode taking an 8-bit relative displacement. */
const REL8_OPCODES = new Set([0x10, 0x30, 0x50, 0x70, 0x80, 0x90, 0xb0, 0xd0, 0xf0])

const HW_CGADD = 0x2121
const HW_CGDATA = 0x2122

const OP_TAX = 0xaa
const OP_LDA_ABS_X = 0xbd
const OP_RTL = 0x6b
const OP_JSL_LONG = 0x22

/**
 * Frame counters whose tick rate the millisecond figure can be built on:
 * `TrueFrame` $7E0013 and `EffFrame` $7E0014 (rammap.asm:52, :60). Both
 * advance once per non-lag frame. A kernel counting anything else is not
 * decoded, because a stride in unknown units is not a cadence.
 */
const FRAME_COUNTER_DP = new Set([0x13, 0x14])

// ── Probe addresses ──────────────────────────────────────────────────────

/** `LDA #imm` carrying the level CGRAM index (bank_00.asm:4663). */
export const PROBE_LEVEL_TARGET = 0x00a41a
/** `LDA #imm` carrying the first overworld CGRAM index (bank_00.asm:4779). */
export const PROBE_OW_FIRST_TARGET = 0x00a513
/** `LDA #imm` carrying the second sub-table's base offset (bank_00.asm:4781). */
export const PROBE_OW_SECOND_BASE = 0x00a518
/** `LDA #imm` carrying the second overworld CGRAM index (bank_00.asm:4783). */
export const PROBE_OW_SECOND_TARGET = 0x00a51c

/** Native NMI vector (smw.asm:43, vectors based at $00FFE0). */
export const PROBE_NMI_VECTOR = 0x00ffea
/**
 * SMW's NMI prologue, `SEI` through `PLB` (bank_00.asm:194-202). The last
 * two bytes are the `PHK / PLB` that sets the data bank, which is the only
 * reason a frame-table operand can be resolved against a known bank at all,
 * so they are checked rather than cited.
 */
const NMI_PROLOGUE = [0x78, 0x08, 0xc2, 0x30, 0x48, 0xda, 0x5a, 0x8b, 0x4b, 0xab]

/** `SEP #$20` opening the block that falls into the level target (:4662). */
export const PROBE_LEVEL_BLOCK_ENTRY = 0x00a418
const LEVEL_BLOCK_OPENING = [0xe2, 0x20]
/** The `BEQ` and `BRA` that transfer into it (bank_00.asm:4635, :4644). */
export const PROBE_LEVEL_APPROACHES = [0x00a3d5, 0x00a3ee]

/** `JSR CODE_00A4E3` in the NMI's overworld arm (bank_00.asm:288). */
export const PROBE_OW_CALL_SITE = 0x008237
/** `REP #$10` opening the overworld routine (bank_00.asm:4760-4761). */
export const PROBE_OW_ROUTINE_ENTRY = 0x00a4e3
const OW_ROUTINE_OPENING = [0xc2, 0x10]

/**
 * What a stock U cart yields, for cross-checking a detection against the
 * disassembly. Never a fallback: an unreadable probe yields no target.
 */
export const VANILLA_EXPECTED = {
  levelCgramIdx: 0x64,
  overworldCgramIdx: [0x6d, 0x7d] as const,
  frameTableAddr: 0x00b60c,
  phaseCount: 8,
  frameStride: 4,
} as const

// ── Types ────────────────────────────────────────────────────────────────

export interface FlashKernel {
  /** SNES address of the kernel's `STA $2121`. */
  addr: number
  /** SNES address of the kernel's `AND #imm`, the byte that sets phase count and speed. */
  maskAddr: number
  /** Direct-page byte the kernel reads as the phase counter. */
  counterDp: number
  phaseMask: number
  /** Number of `LSR A` between the mask and the add. */
  shift: number
  /** Direct-page byte the kernel adds, or null when no `ADC` folds one in. */
  baseDp: number | null
  /** The `LDA abs,X|Y` operand as written. */
  tableOperand: number
  /** Which indexed load this kernel used, so a tail write can reuse it. */
  indexed: number
  /** Frame table, resolved against the data bank the NMI prologue sets. */
  tableAddr: number
  /** First byte after the kernel's second CGDATA write. */
  end: number
  /** Byte offsets into the table in counter order, one per phase. */
  phaseOffsets: number[]
  /** Counter ticks between phase changes. */
  frameStride: number
  /** Counter ticks for one full pass over `phaseOffsets`. */
  periodTicks: number
}

export interface PaletteAnimTarget {
  /** CGRAM color index 0-255: row = idx >> 4, col = idx & 15. */
  cgramIdx: number
  /** Where this index was read from, for reporting. */
  cgramIdxAddr: number
  /** Base of this target's own frames, kernel table plus the caller's base. */
  tableAddr: number
  /** Frames in `colors`, which is the period, not the distinct-color count. */
  phaseCount: number
  frameStride: number
  /** BGR555 words in counter order; a non-contiguous mask repeats values. */
  colors: number[]
  /** SNES address of each entry of `colors`, same order: table plus phase offset. */
  frameAddrs: number[]
  /** The kernel operands that set count and speed (bank_00.asm:4668-4670). Read-only facts. */
  timing: { maskAddr: number; mask: number; shift: number; counterDp: number }
  kernelAddr: number
}

export type PaletteAnimContextName = 'level' | 'overworld'

export interface PaletteAnimContext {
  context: PaletteAnimContextName
  /** False means the derivation is blind; `targets` is then empty. */
  available: boolean
  targets: PaletteAnimTarget[]
  notes: string[]
}

export interface PaletteAnimDetection {
  level: PaletteAnimContext
  overworld: PaletteAnimContext
}

/** Where a decode stopped and what it wanted, so a note can name it. */
interface Divergence {
  at: number
  wanted: string
}

type Decoded<T> = { ok: true; value: T } | ({ ok: false } & Divergence)

const no = (at: number, wanted: string): { ok: false } & Divergence => ({ ok: false, at, wanted })
const yes = <T>(value: T): Decoded<T> => ({ ok: true, value })

// ── Kernel decoding ──────────────────────────────────────────────────────

/**
 * LoROM file offset back to an SNES address. Offsets in the last two banks
 * of a 4MB cart map to $FE/$FF, not $7E/$7F, which are WRAM.
 */
function snesFromLoromOffset(offset: number): number {
  const bank = (offset / LOROM_BANK_SIZE) | 0
  return ((bank >= 0x7e ? bank | 0x80 : bank) << 16) | 0x8000 | (offset % LOROM_BANK_SIZE)
}

class Cursor {
  constructor(
    private rom: RomFile,
    public at: number,
  ) {}

  /** Consume `opcode` plus one operand byte, returning the operand. */
  takeOperand(opcode: number): number | null {
    if (this.rom.readByte(this.at) !== opcode) return null
    const operand = this.rom.readByte(this.at + 1)
    if (operand === null) return null
    this.at += 2
    return operand
  }

  /** Consume `opcode` plus a 16-bit operand, returning the operand. */
  takeAbsolute(opcode: number): number | null {
    if (this.rom.readByte(this.at) !== opcode) return null
    const operand = this.rom.readWord(this.at + 1)
    if (operand === null) return null
    this.at += 3
    return operand
  }

  takeImplied(opcode: number): boolean {
    if (this.rom.readByte(this.at) !== opcode) return false
    this.at += 1
    return true
  }

  /** Consume `STA abs` only when it names `register`. */
  takeStore(register: number): boolean {
    const at = this.at
    if (this.takeAbsolute(OP_STA_ABS) === register) return true
    this.at = at
    return false
  }
}

/** Table offsets in counter order over one full period of the mask. */
function phaseSequence(phaseMask: number, shift: number): number[] {
  const lowBit = phaseMask & -phaseMask
  const periodTicks = 1 << (32 - Math.clz32(phaseMask))
  const out: number[] = []
  for (let tick = 0; tick < periodTicks; tick += lowBit) out.push((tick & phaseMask) >>> shift)
  return out
}

/**
 * `TAY / LDA abs,Y` or `TAX / LDA abs,X`, the write pair, and an optional
 * `RTS` / `RTL`. Which index register and whether the routine returns here
 * are the assembler's choice, not part of what makes this a palette write.
 */
function decodeTableReads(
  rom: RomFile,
  c: Cursor,
  inherited?: number,
): Decoded<{
  lowOperand: number
  highOperand: number
  highAddr: number
  end: number
  indexed: number
}> {
  const indexed =
    inherited ??
    (c.takeImplied(OP_TAY) ? OP_LDA_ABS_Y : c.takeImplied(OP_TAX) ? OP_LDA_ABS_X : null)
  if (indexed === null) return no(c.at, 'TAY or TAX')

  const lowOperand = c.takeAbsolute(indexed)
  if (lowOperand === null) return no(c.at, 'LDA abs,X or abs,Y reading the frame table')
  if (!c.takeStore(HW_CGDATA))
    return no(c.at, `STA $${hex2(HW_CGDATA >> 8)}${hex2(HW_CGDATA & 0xff)}`)
  const highAddr = c.at
  const highOperand = c.takeAbsolute(indexed)
  if (highOperand === null) return no(highAddr, 'a second indexed frame-table read')
  if (!c.takeStore(HW_CGDATA))
    return no(c.at, `STA $${hex2(HW_CGDATA >> 8)}${hex2(HW_CGDATA & 0xff)}`)
  const end = c.at
  if (!c.takeImplied(OP_RTS)) c.takeImplied(OP_RTL)
  return yes({ lowOperand, highOperand, highAddr, end, indexed })
}

function decodeKernel(
  rom: RomFile,
  addr: number,
  dbrBank = (addr >>> 16) & 0xff,
): Decoded<FlashKernel> {
  const c = new Cursor(rom, addr)
  if (!c.takeStore(HW_CGADD)) return no(c.at, `STA $${hex2(HW_CGADD >> 8)}${hex2(HW_CGADD & 0xff)}`)

  const counterAddr = c.at
  const counterDp = c.takeOperand(OP_LDA_DP)
  if (counterDp === null) return no(counterAddr, 'LDA dp reading the phase counter')

  const maskAddr = c.at
  const phaseMask = c.takeOperand(OP_AND_IMM)
  if (phaseMask === null) return no(maskAddr, 'AND #imm masking the phase counter')
  if (phaseMask === 0) return no(maskAddr, 'a non-zero phase mask')

  const shiftAddr = c.at
  let shift = 0
  while (c.takeImplied(OP_LSR_A)) shift++

  const carryAddr = c.at
  const hasClc = c.takeImplied(OP_CLC)

  // Absent on a kernel whose sub-table offset is folded into the operand.
  const baseDp = c.takeOperand(OP_ADC_DP)

  const reads = decodeTableReads(rom, c)
  if (!reads.ok) return reads
  const { lowOperand, highOperand, highAddr } = reads.value

  if (highOperand !== ((lowOperand + 1) & 0xffff)) {
    return no(
      highAddr,
      `a frame-table operand of $${hex2((lowOperand + 1) >> 8)}${hex2((lowOperand + 1) & 0xff)}, so the two reads form one word`,
    )
  }
  if (baseDp !== null && !hasClc && (shift === 0 || (phaseMask & (1 << (shift - 1))) !== 0)) {
    return no(
      carryAddr,
      'a CLC, or a mask whose bit below the shift is clear, so no carry reaches the ADC',
    )
  }
  if (!FRAME_COUNTER_DP.has(counterDp)) {
    return no(counterAddr, 'a counter of $13 or $14, whose tick rate a cadence can be built on')
  }

  const phaseOffsets = phaseSequence(phaseMask, shift)
  if (new Set(phaseOffsets).size < 2) {
    return no(shiftAddr, 'a mask and shift that reach more than one table offset')
  }

  const frameStride = phaseMask & -phaseMask
  return yes({
    addr,
    maskAddr,
    counterDp,
    phaseMask,
    shift,
    baseDp,
    tableOperand: lowOperand,
    indexed: reads.value.indexed,
    tableAddr: (dbrBank << 16) | lowOperand,
    end: reads.value.end,
    phaseOffsets,
    frameStride,
    periodTicks: phaseOffsets.length * frameStride,
  })
}

/** The CGRAM flash kernel at `addr`, or null when the bytes are anything else. */
export function decodeFlashKernel(rom: RomFile, addr: number): FlashKernel | null {
  const decoded = decodeKernel(rom, addr)
  return decoded.ok ? decoded.value : null
}

/**
 * Every address in the cart whose bytes decode as the flash kernel. Anchored
 * on `STA $2121`, which is cheap to find and rare enough that the full decode
 * runs only a few dozen times.
 */
export function findFlashKernels(rom: RomFile): number[] {
  if (rom.mapMode === 'hirom') return []
  const bytes = rom.buffer
  const base = rom.hasHeader ? COPIER_HEADER_SIZE : 0
  const out: number[] = []
  for (let i = base; i + 2 < bytes.length; i++) {
    if (
      bytes[i] !== OP_STA_ABS ||
      bytes[i + 1] !== (HW_CGADD & 0xff) ||
      bytes[i + 2] !== HW_CGADD >> 8
    )
      continue
    const addr = snesFromLoromOffset(i - base)
    if (decodeFlashKernel(rom, addr)) out.push(addr)
  }
  return out
}

// ── Reaching the routine ─────────────────────────────────────────────────

function bytesMatch(rom: RomFile, addr: number, expected: number[]): boolean {
  return expected.every((byte, i) => rom.readByte(addr + i) === byte)
}

/** Target of an 8-bit relative branch, or null when there is no branch here. */
function relativeTarget(rom: RomFile, addr: number): number | null {
  const opcode = rom.readByte(addr)
  const displacement = rom.readByte(addr + 1)
  if (opcode === null || displacement === null || !REL8_OPCODES.has(opcode)) return null
  const signed = displacement < 0x80 ? displacement : displacement - 0x100
  return (addr & 0xff0000) | ((addr + 2 + signed) & 0xffff)
}

function absoluteTarget(rom: RomFile, addr: number, opcode: number): number | null {
  const operand = new Cursor(rom, addr).takeAbsolute(opcode)
  return operand === null ? null : (addr & 0xff0000) | operand
}

/** Hooked vectors usually trampoline; more hops than this is not a trampoline. */
const MAX_JUMP_HOPS = 4

/** Walk a run of leading unconditional jumps to where control settles. */
function followJumps(rom: RomFile, addr: number): number {
  let at = addr
  for (let hop = 0; hop < MAX_JUMP_HOPS; hop++) {
    const opcode = rom.readByte(at)
    if (opcode === OP_JMP_ABS) {
      const target = rom.readWord(at + 1)
      if (target === null) return at
      at = (at & 0xff0000) | target
    } else if (opcode === OP_JML_LONG) {
      const target = rom.readWord(at + 1)
      const bank = rom.readByte(at + 3)
      if (target === null || bank === null) return at
      at = (bank << 16) | target
    } else {
      return at
    }
  }
  return at
}

/** The NMI is still SMW's, so the fixed probes below address the live handler. */
function nmiIntact(rom: RomFile): Decoded<number> {
  const vector = rom.readWord(PROBE_NMI_VECTOR)
  if (vector === null) return no(PROBE_NMI_VECTOR, 'a native NMI vector backed by ROM')
  const entry = followJumps(rom, (PROBE_NMI_VECTOR & 0xff0000) | vector)
  const blind =
    `The palette routines may be byte-for-byte intact and never run, so nothing is ` +
    'claimed about them.'
  // Every probe below is a bank-$00 address, so a handler anywhere else is
  // not the one those probes read.
  if (((entry >>> 16) & 0x7f) !== 0x00) {
    return no(entry, `an NMI in the bank this module's probes read. ${blind}`)
  }
  if (!bytesMatch(rom, entry, NMI_PROLOGUE)) {
    return no(entry, `SMW's NMI prologue through its PLB (bank_00.asm:194-202). ${blind}`)
  }
  // The PLB just checked installs the program bank as the data bank, which is
  // the bank every frame-table operand below resolves against.
  return yes((entry >>> 16) & 0x7f)
}

function reachNote(rom: RomFile, at: Divergence): string {
  const held = rom.readByte(at.at)
  const seen = held === null ? 'nothing mapped' : `0x${hex2(held)}`
  return (
    `The path to the palette routine is diverted: $${hex6(at.at)} holds ${seen} where it ` +
    `needs ${at.wanted}. The routine may be byte-for-byte intact and never run, so nothing is ` +
    'claimed about what it animates.'
  )
}

function levelReach(rom: RomFile): Decoded<number> {
  const nmi = nmiIntact(rom)
  if (!nmi.ok) return nmi
  if (!bytesMatch(rom, PROBE_LEVEL_BLOCK_ENTRY, LEVEL_BLOCK_OPENING)) {
    return no(
      PROBE_LEVEL_BLOCK_ENTRY,
      'the SEP #$20 opening the level palette block (bank_00.asm:4662)',
    )
  }
  for (const addr of PROBE_LEVEL_APPROACHES) {
    if (relativeTarget(rom, addr) === PROBE_LEVEL_BLOCK_ENTRY) continue
    return no(addr, `a branch into $${hex6(PROBE_LEVEL_BLOCK_ENTRY)} (bank_00.asm:4635, :4644)`)
  }
  return nmi
}

/** How this cart's overworld palette upload is reached, if at all. */
type OverworldRoute =
  | { ok: true; kind: 'stock'; dbrBank: number }
  | { ok: true; kind: 'relocated'; dbrBank: number; at: number }
  | ({ ok: false } & Divergence)

function overworldRoute(rom: RomFile): OverworldRoute {
  const nmi = nmiIntact(rom)
  if (!nmi.ok) return nmi
  const called = absoluteTarget(rom, PROBE_OW_CALL_SITE, OP_JSR_ABS)
  if (called !== PROBE_OW_ROUTINE_ENTRY) {
    return no(PROBE_OW_CALL_SITE, `a JSR to $${hex6(PROBE_OW_ROUTINE_ENTRY)} (bank_00.asm:288)`)
  }
  if (bytesMatch(rom, PROBE_OW_ROUTINE_ENTRY, OW_ROUTINE_OPENING)) {
    return { ok: true, kind: 'stock', dbrBank: nmi.value }
  }
  // The routine was moved out of bank $00 and its entry replaced by the long
  // call that reaches it, followed by the RTS that ends what is left here.
  const c = new Cursor(rom, PROBE_OW_ROUTINE_ENTRY)
  const target = c.takeAbsolute(OP_JSL_LONG)
  const bank = target === null ? null : rom.readByte(PROBE_OW_ROUTINE_ENTRY + 3)
  if (target === null || bank === null) {
    return no(
      PROBE_OW_ROUTINE_ENTRY,
      'the stock REP #$10 (bank_00.asm:4761), or a JSL to where the routine moved',
    )
  }
  if (rom.readByte(PROBE_OW_ROUTINE_ENTRY + 4) !== OP_RTS) {
    return no(
      PROBE_OW_ROUTINE_ENTRY + 4,
      'an RTS after the long call, so the call is the whole routine',
    )
  }
  const at = (bank << 16) | target
  if (rom.readByte(at) === null) return no(at, 'a long-call target backed by ROM')
  return { ok: true, kind: 'relocated', dbrBank: nmi.value, at }
}

// ── Caller decoding ──────────────────────────────────────────────────────

interface CallSite {
  cgramIdx: number
  cgramIdxAddr: number
  baseOffset: number
  kernel: FlashKernel
}

/** A kernel reached through its zeroing entry: `STZ dp` then the kernel. */
function kernelBehindZeroEntry(
  rom: RomFile,
  entryAddr: number,
  dbrBank: number,
): Decoded<FlashKernel> {
  const c = new Cursor(rom, entryAddr)
  const dp = c.takeOperand(OP_STZ_DP)
  if (dp === null) return no(entryAddr, 'STZ dp zeroing the sub-table base')
  const decoded = decodeKernel(rom, c.at, dbrBank)
  if (!decoded.ok) return decoded
  if (decoded.value.baseDp !== dp) {
    return no(
      entryAddr,
      decoded.value.baseDp === null
        ? 'a kernel with an ADC, since this caller supplies a sub-table base'
        : `STZ of $${hex2(decoded.value.baseDp)}, the byte the kernel's ADC reads`,
    )
  }
  return decoded
}

/** `LDA #imm` then a fall-through into the zeroing entry (level path). */
function decodeFallThroughCaller(rom: RomFile, addr: number, dbrBank: number): Decoded<CallSite> {
  const c = new Cursor(rom, addr)
  const cgramIdx = c.takeOperand(OP_LDA_IMM)
  if (cgramIdx === null) return no(addr, 'LDA #imm carrying the CGRAM index')
  const kernel = kernelBehindZeroEntry(rom, c.at, dbrBank)
  return kernel.ok
    ? yes({ cgramIdx, cgramIdxAddr: addr + 1, baseOffset: 0, kernel: kernel.value })
    : kernel
}

/** `LDA #imm` then `JSR` to the zeroing entry (overworld, first target). */
function decodeJsrCaller(rom: RomFile, addr: number, dbrBank: number): Decoded<CallSite> {
  const c = new Cursor(rom, addr)
  const cgramIdx = c.takeOperand(OP_LDA_IMM)
  if (cgramIdx === null) return no(addr, 'LDA #imm carrying the CGRAM index')
  const entry = c.at
  const target = c.takeAbsolute(OP_JSR_ABS)
  if (target === null) return no(entry, 'JSR to the kernel')
  const kernel = kernelBehindZeroEntry(rom, (addr & 0xff0000) | target, dbrBank)
  return kernel.ok
    ? yes({ cgramIdx, cgramIdxAddr: addr + 1, baseOffset: 0, kernel: kernel.value })
    : kernel
}

/**
 * `LDA #imm / STA dp / LDA #imm / JMP kernel` (overworld, second target).
 * The base immediate is what selects the second sub-table.
 */
function decodePreloadedCaller(rom: RomFile, baseAddr: number, dbrBank: number): Decoded<CallSite> {
  const c = new Cursor(rom, baseAddr)
  const baseOffset = c.takeOperand(OP_LDA_IMM)
  if (baseOffset === null) return no(baseAddr, 'LDA #imm carrying the sub-table base')
  const storeAddr = c.at
  const dp = c.takeOperand(OP_STA_DP)
  if (dp === null) return no(storeAddr, 'STA dp storing the sub-table base')
  const cgramIdxAddr = c.at + 1
  const cgramIdx = c.takeOperand(OP_LDA_IMM)
  if (cgramIdx === null) return no(cgramIdxAddr - 1, 'LDA #imm carrying the CGRAM index')
  const jumpAddr = c.at
  const target = c.takeAbsolute(OP_JMP_ABS)
  if (target === null) return no(jumpAddr, 'JMP to the kernel')
  const kernel = decodeKernel(rom, (baseAddr & 0xff0000) | target, dbrBank)
  if (!kernel.ok) return kernel
  if (kernel.value.baseDp !== dp) {
    return no(
      storeAddr,
      kernel.value.baseDp === null
        ? 'a kernel with an ADC, since this caller supplies a sub-table base'
        : `a store to $${hex2(kernel.value.baseDp)}, the byte the kernel's ADC reads`,
    )
  }
  return yes({ cgramIdx, cgramIdxAddr, baseOffset, kernel: kernel.value })
}

/**
 * A relocated routine writes its CGRAM index inline rather than in a caller
 * that jumps to a shared kernel: `LDA #imm / STA $2121 / ...`. Successive
 * targets sit byte-adjacent, and a later one may reuse the index register
 * the first one loaded instead of recomputing it, so its phases are the
 * first's and its sub-table offset is folded into its own operand.
 */
function decodeFoldedChain(rom: RomFile, startAddr: number, dbrBank: number): CallSite[] {
  const sites: CallSite[] = []
  let at = startAddr
  let phases: FlashKernel | null = null

  while (sites.length <= MAX_CHAIN_WRITES) {
    const c = new Cursor(rom, at)
    const cgramIdx = c.takeOperand(OP_LDA_IMM)
    if (cgramIdx === null) return sites
    const writeAddr = c.at

    const full = decodeKernel(rom, writeAddr, dbrBank)
    if (full.ok) {
      phases = full.value
      sites.push({ cgramIdx, cgramIdxAddr: at + 1, baseOffset: 0, kernel: full.value })
      at = full.value.end
      continue
    }
    // No arithmetic of its own: it rides the previous write's index register.
    if (phases === null) return sites
    const tail = new Cursor(rom, writeAddr)
    if (!tail.takeStore(HW_CGADD)) return sites
    const reads = decodeTableReads(rom, tail, phases.indexed)
    if (!reads.ok) return sites

    sites.push({
      cgramIdx,
      cgramIdxAddr: at + 1,
      baseOffset: 0,
      kernel: {
        ...phases,
        addr: writeAddr,
        end: reads.value.end,
        tableOperand: reads.value.lowOperand,
        tableAddr: (dbrBank << 16) | reads.value.lowOperand,
      },
    })
    at = reads.value.end
  }
  // More adjacent writes than a flash routine has means the chain has run on
  // into code this module never entered, and a tail write there would
  // inherit arithmetic nothing read at that address.
  return sites.length > MAX_CHAIN_WRITES ? [] : sites
}

/** True when the byte after the chain ends the routine it belongs to. */
function chainEndsCleanly(rom: RomFile, sites: CallSite[]): boolean {
  const last = sites[sites.length - 1]
  if (!last) return false
  const after = rom.readByte(last.kernel.end)
  return after === OP_RTS || after === OP_RTL
}

// ── Walking to a relocated routine's writes ──────────────────────────────

/**
 * 65816 instruction lengths by opcode, `m` and `x` where the length depends
 * on the accumulator or index width. Hardware, not SMW: a relocated routine
 * cannot be read without instruction boundaries, and a byte scan for the
 * write finds matching bytes no path reaches.
 */
const OPCODE_LENGTHS =
  '222222221m113334' +
  '2222222213113334' +
  '324222221m113334' +
  '2222222213113334' +
  '122232221m113334' +
  '2222322213114334' +
  '132222221m113334' +
  '2222222213113334' +
  '232222221m113334' +
  '2222222213113334' +
  'x2x222221m113334' +
  '2222222213113334' +
  'x22222221m113334' +
  '2222222213113334' +
  'x22222221m113334' +
  '2222322213113334'

const OP_REP = 0xc2
const OP_SEP = 0xe2
const OP_PHK = 0x4b
const OP_PLB = 0xab
const OP_RTI = 0x40
const OP_BRA = 0x80
const OP_BRL = 0x82
/** Their targets are data this module does not read, so they end a walk. */
const INDIRECT_JUMPS = new Set([0x6c, 0x7c, 0xdc])

/** Enough to cross a bank of straight-line code; a loop ends the walk sooner. */
const MAX_WALK_STEPS = 4096
/** One full write plus one riding its index is what a flash routine is. */
const MAX_CHAIN_WRITES = 2

function instructionLength(opcode: number, m16: boolean, x16: boolean): number {
  const code = OPCODE_LENGTHS[opcode]!
  if (code === 'm') return m16 ? 3 : 2
  if (code === 'x') return x16 ? 3 : 2
  return Number(code)
}

/**
 * Walk from a relocated routine's entry to the first CGRAM write its own
 * control flow reaches, tracking the data bank it installs on the way.
 *
 * Unconditional transfers are followed, because where they go is determinate.
 * Conditional ones are not: the walk continues straight through, so a write
 * only a taken branch reaches is missed and the context reports unavailable.
 * That is the safe direction. Calls are stepped over, since they return.
 */
function walkToCgramWrite(
  rom: RomFile,
  from: number,
  dbrBank: number,
): Decoded<{ at: number; dbrBank: number }> {
  const bank = from & 0xff0000
  let at = from
  let dbr = dbrBank
  let m16 = false
  let x16 = false
  const seen = new Set<number>()

  for (let step = 0; step < MAX_WALK_STEPS; step++) {
    if (seen.has(at)) return no(at, 'a routine that reaches a CGRAM write rather than looping')
    seen.add(at)
    if ((at & 0xff0000) !== bank)
      return no(at, 'a routine that stays in the bank it was called into')

    const opcode = rom.readByte(at)
    if (opcode === null) return no(at, 'a routine backed by ROM')

    // The shape a relocated routine uses: the index immediately before the write.
    if (opcode === OP_LDA_IMM && !m16 && new Cursor(rom, at + 2).takeStore(HW_CGADD)) {
      return yes({ at, dbrBank: dbr })
    }
    // A write whose index came from somewhere this module did not read.
    if (new Cursor(rom, at).takeStore(HW_CGADD)) {
      return no(at, 'a CGRAM index loaded by the instruction before the write')
    }

    if (opcode === OP_PHK && rom.readByte(at + 1) === OP_PLB) {
      dbr = (at >>> 16) & 0x7f
      at += 2
      continue
    }
    // Any other PLB takes its bank off the stack, which is not readable here.
    if (opcode === OP_PLB) return no(at, 'a data bank installed by a PHK this module can see')

    if (opcode === OP_REP || opcode === OP_SEP) {
      const flags = rom.readByte(at + 1)
      if (flags === null) return no(at + 1, 'a REP/SEP operand backed by ROM')
      const wide = opcode === OP_REP
      if (flags & 0x20) m16 = wide
      if (flags & 0x10) x16 = wide
      at += 2
      continue
    }

    if (opcode === OP_RTS || opcode === OP_RTL || opcode === OP_RTI) {
      return no(at, 'a CGRAM write before the routine returns')
    }
    if (INDIRECT_JUMPS.has(opcode)) return no(at, 'a direct jump rather than one through a pointer')

    if (opcode === OP_JMP_ABS) {
      const target = rom.readWord(at + 1)
      if (target === null) return no(at, 'a JMP operand backed by ROM')
      at = bank | target
      continue
    }
    if (opcode === OP_BRA) {
      const target = relativeTarget(rom, at)
      if (target === null) return no(at, 'a BRA operand backed by ROM')
      at = target
      continue
    }
    if (opcode === OP_BRL) {
      const displacement = rom.readWord(at + 1)
      if (displacement === null) return no(at, 'a BRL operand backed by ROM')
      const signed = displacement < 0x8000 ? displacement : displacement - 0x10000
      at = bank | ((at + 3 + signed) & 0xffff)
      continue
    }
    if (opcode === OP_JML_LONG) return no(at, 'a routine that stays in the bank it was called into')

    at += instructionLength(opcode, m16, x16)
  }
  return no(at, 'a CGRAM write within a routine this module can walk')
}

// ── Detection ────────────────────────────────────────────────────────────

function toTarget(rom: RomFile, site: CallSite): PaletteAnimTarget | null {
  const { kernel, baseOffset } = site
  const colors: number[] = []
  const frameAddrs: number[] = []
  for (const offset of kernel.phaseOffsets) {
    // The ADC is 8-bit (SEP #$20 at bank_00.asm:4662; ADC.B _0 / TAY at
    // :4671-4672), so the index wraps at $FF. Without an ADC there is no
    // add to overflow.
    const index = kernel.baseDp !== null ? (baseOffset + offset) & 0xff : baseOffset + offset
    const addr = kernel.tableAddr + index
    const word = rom.readWord(addr)
    if (word === null) return null
    colors.push(word)
    frameAddrs.push(addr)
  }
  return {
    cgramIdx: site.cgramIdx,
    cgramIdxAddr: site.cgramIdxAddr,
    tableAddr: kernel.tableAddr + baseOffset,
    phaseCount: kernel.phaseOffsets.length,
    frameStride: kernel.frameStride,
    colors,
    frameAddrs,
    timing: {
      maskAddr: kernel.maskAddr,
      mask: kernel.phaseMask,
      shift: kernel.shift,
      counterDp: kernel.counterDp,
    },
    kernelAddr: kernel.addr,
  }
}

function divergenceNote(rom: RomFile, at: Divergence, role: string): string {
  const held = rom.readByte(at.at)
  const seen = held === null ? 'nothing mapped' : `0x${hex2(held)}`
  return (
    `The ${role} does not decode: $${hex6(at.at)} holds ${seen} where the routine needs ` +
    `${at.wanted}. This ROM drives that palette cycle with code HackBench does not read, so the ` +
    'animated index and its frames are unknown. No slot is claimed to be animated and none is ' +
    'claimed to be static.'
  )
}

/**
 * Where else the kernel pattern decodes. A relocated but intact kernel is
 * worth naming, and more than one match means the pattern alone cannot say
 * which routine the NMI reaches. Costs a full pass over the cart, so it runs
 * only once a probe has already failed.
 */
function relocationNote(rom: RomFile): string {
  const found = findFlashKernels(rom)
  if (found.length === 0) return 'The kernel pattern decodes nowhere in this ROM.'
  const addrs = found.map(a => `$${hex6(a)}`).join(', ')
  return found.length === 1
    ? `The kernel pattern still decodes at ${addrs}. Whether this context reaches it is not ` +
        'something the pattern alone can say.'
    : `The kernel pattern decodes at ${found.length} addresses (${addrs}), so the pattern alone ` +
        'cannot say which of them this context reaches.'
}

function unavailable(context: PaletteAnimContextName, notes: string[]): PaletteAnimContext {
  return { context, available: false, targets: [], notes }
}

function describe(target: PaletteAnimTarget): string {
  const distinct = new Set(target.colors).size
  const repeats = distinct === target.phaseCount ? '' : `, ${distinct} of them distinct`
  return (
    `CGRAM $${hex2(target.cgramIdx)} cycles ${target.phaseCount} phases from ` +
    `$${hex6(target.tableAddr)}${repeats}, one phase every ${target.frameStride} counter ticks.`
  )
}

/**
 * The overworld upload on a cart that moved it out of bank $00. Its CGRAM
 * indices are folded inline rather than sitting in callers that jump to a
 * shared kernel, so the chain starting at the first inline write is what
 * this routine does. A routine that jumps somewhere else before writing is
 * not followed, and reports unavailable rather than a guess.
 */
function relocatedOverworld(rom: RomFile, at: number, dbrBank: number): PaletteAnimContext {
  const blind = (why: string): PaletteAnimContext =>
    unavailable('overworld', [
      `The overworld upload was moved to $${hex6(at)} and cannot be read there: ${why}`,
      relocationNote(rom),
    ])

  const found = walkToCgramWrite(rom, at, dbrBank)
  if (!found.ok) {
    const held = rom.readByte(found.at)
    const seen = held === null ? 'nothing mapped' : `0x${hex2(held)}`
    return blind(`$${hex6(found.at)} holds ${seen} where the walk needs ${found.wanted}.`)
  }

  const sites = decodeFoldedChain(rom, found.value.at, found.value.dbrBank)
  if (sites.length === 0) return blind(`its writes at $${hex6(found.value.at)} do not decode.`)
  if (!chainEndsCleanly(rom, sites)) {
    return blind(`its writes at $${hex6(found.value.at)} run on past where the routine returns.`)
  }

  const targets = sites
    .map(site => toTarget(rom, site))
    .filter((t): t is PaletteAnimTarget => t !== null)
  if (targets.length !== sites.length) {
    return blind('one of its frame tables does not point into ROM.')
  }
  // A swatch painted as cycling has to cycle. `decodeKernel` already refuses a
  // mask reaching one offset; this catches the same emptiness in the data.
  const flat = targets.find(t => new Set(t.colors).size < 2)
  if (flat) {
    return blind(
      `CGRAM $${hex2(flat.cgramIdx)} reads one repeated colour from ` +
        `$${hex6(flat.tableAddr)}, so nothing there animates.`,
    )
  }

  return {
    context: 'overworld',
    available: true,
    targets,
    notes: [
      `The overworld upload was moved to $${hex6(at)}; its inline CGRAM writes start at ` +
        `$${hex6(found.value.at)}.`,
      ...targets.map(describe),
    ],
  }
}

/**
 * Derive, per context, which CGRAM indices this cart animates and where their
 * frames live. Contexts fail independently: a cart may have an intact level
 * path and a rewritten overworld one.
 */
export function detectPaletteAnimation(rom: RomFile): PaletteAnimDetection {
  const level = ((): PaletteAnimContext => {
    const reach = levelReach(rom)
    if (!reach.ok) return unavailable('level', [reachNote(rom, reach), relocationNote(rom)])

    const site = decodeFallThroughCaller(rom, PROBE_LEVEL_TARGET, reach.value)
    if (!site.ok) {
      return unavailable('level', [
        divergenceNote(rom, site, 'level NMI path'),
        relocationNote(rom),
      ])
    }
    const target = toTarget(rom, site.value)
    if (!target) {
      return unavailable('level', [
        `The level kernel's frame table at $${hex6(site.value.kernel.tableAddr)} does not point into ` +
          'ROM, so its frames cannot be read.',
      ])
    }
    return { context: 'level', available: true, targets: [target], notes: [describe(target)] }
  })()

  const overworld = ((): PaletteAnimContext => {
    const route = overworldRoute(rom)
    if (!route.ok) return unavailable('overworld', [reachNote(rom, route), relocationNote(rom)])

    if (route.kind === 'relocated') return relocatedOverworld(rom, route.at, route.dbrBank)

    const sites = [
      decodeJsrCaller(rom, PROBE_OW_FIRST_TARGET, route.dbrBank),
      decodePreloadedCaller(rom, PROBE_OW_SECOND_BASE, route.dbrBank),
    ]
    const roles = ['overworld NMI first target', 'overworld NMI second target']
    // Either half rewritten leaves the other half's meaning unclear, since the
    // two share one kernel and one direct-page base byte.
    const notes = sites.flatMap((s, i) => (s.ok ? [] : [divergenceNote(rom, s, roles[i]!)]))
    if (notes.length > 0) return unavailable('overworld', [...notes, relocationNote(rom)])

    const targets: PaletteAnimTarget[] = []
    for (const site of sites) {
      if (!site.ok) continue
      const target = toTarget(rom, site.value)
      if (!target) {
        return unavailable('overworld', [
          `An overworld frame table at $${hex6(site.value.kernel.tableAddr + site.value.baseOffset)} ` +
            'does not point into ROM, so its frames cannot be read.',
        ])
      }
      targets.push(target)
    }
    return { context: 'overworld', available: true, targets, notes: targets.map(describe) }
  })()

  return { level, overworld }
}
