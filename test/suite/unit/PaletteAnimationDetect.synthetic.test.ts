/**
 * Synthetic-ROM tests for the palette-animation detection.
 *
 * These run in CI with no ROM file involved, and they are the mutation
 * oracle for the derivation. Each rule the detector enforces gets a cart
 * built to break it: the opcode gate on every probe, the direct-page link
 * between a caller's base store and the kernel's add, the two `LDA abs,Y`
 * operands forming one word, the carry out of the last `LSR`, the phase
 * sequence and period coming from the mask, and the approaches that decide
 * whether the routine is reached at all.
 *
 * The central assertion is that a patched cart yields no target. A detector
 * that answered $64 anyway would be confidently wrong on the one cart this
 * module exists for, and a cart whose routine is intact but never reached is
 * the commonest shape of that patch.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loromToOffset } from '../../../src/rom/addressing'
import {
  decodeFlashKernel,
  detectPaletteAnimation,
  findFlashKernels,
  PROBE_LEVEL_APPROACHES,
  PROBE_LEVEL_BLOCK_ENTRY,
  PROBE_LEVEL_TARGET,
  PROBE_NMI_VECTOR,
  PROBE_OW_CALL_SITE,
  PROBE_OW_FIRST_TARGET,
  PROBE_OW_ROUTINE_ENTRY,
  PROBE_OW_SECOND_BASE,
  PROBE_OW_SECOND_TARGET,
  VANILLA_EXPECTED,
} from '../../../src/rom/PaletteAnimationDetect'
import { loadPaletteAnimData } from '../../../src/rom/PaletteAnimationLoader'

const BUF_SIZE = 0x80000
const off = (snes: number, size = BUF_SIZE): number => loromToOffset(snes, size)!

/** Where the stock routine's pieces sit, so a test can name one to break. */
const ZERO_ENTRY = 0x00a41c
const KERNEL = 0x00a41e
const TABLE = 0x00b60c
const NMI = 0x00816a

interface Shape {
  /** Phase mask in the kernel's `AND #imm`. */
  mask?: number
  /** Number of `LSR A` after the mask. */
  shift?: number
  /** Emit a `CLC` between the shift and the add. */
  clc?: boolean
  /** Direct-page byte the kernel reads as its phase counter. */
  counterDp?: number
  /** Direct-page byte the kernel adds; callers store to it unless overridden. */
  kernelBaseDp?: number
  callerBaseDp?: number
  /** Offset between the kernel's two `LDA abs,Y` operands. */
  highOperandGap?: number
  /** Where the kernel's `LDA abs,Y` points. */
  tableAddr?: number
  /** BGR555 words seeded at `tableAddr`, replacing the default ramp. */
  colors?: number[]
  /** Total buffer size, for testing carts larger than 512 KB. */
  size?: number
  /** Raw byte overwrites applied last, keyed by SNES address. */
  poke?: Record<number, number>
  /** Replace $00A4E3 with a JSL to a routine built out of bank $00. */
  relocate?: Relocated
  /** Extra frame tables to seed, so a test can tell two banks apart. */
  tables?: Array<{ at: number; words: number[] }>
  /** Extra raw byte runs, for decoys and foreign routines. */
  blobs?: Array<{ at: number; bytes: number[] }>
}

interface Relocated {
  /** Where the JSL points. */
  at: number
  /** Instructions between the landing address and the first CGRAM write. */
  lead?: number[]
  /** Writes in the folded chain, in order. */
  chain?: Array<{ cgramIdx: number; table: number; tail?: boolean }>
  /** Closing byte: $60 RTS, $6B RTL, or none. */
  terminator?: number | null
}

const lo = (w: number): number => w & 0xff
const hi = (w: number): number => (w >> 8) & 0xff

/** `STA $2121`, the counter arithmetic, and a TAX-indexed table read pair. */
function taxKernel(table: number): number[] {
  return [
    0x8d,
    0x21,
    0x21, // STA $2121
    0xa5,
    0x14, // LDA EffFrame
    0x29,
    0x1c, // AND #$1C
    0x4a, // LSR A
    0xaa, // TAX
    0xbd,
    lo(table),
    hi(table), // LDA table,X
    0x8d,
    0x22,
    0x21, // STA $2122
    0xbd,
    lo(table + 1),
    hi(table + 1),
    0x8d,
    0x22,
    0x21,
  ]
}

/** A write with no arithmetic of its own, riding the previous one's index. */
function tailWrite(table: number): number[] {
  return [
    0x8d,
    0x21,
    0x21,
    0xbd,
    lo(table),
    hi(table),
    0x8d,
    0x22,
    0x21,
    0xbd,
    lo(table + 1),
    hi(table + 1),
    0x8d,
    0x22,
    0x21,
  ]
}

/** The byte run of a relocated routine, as GPW2 lays one out. */
function relocatedBody(r: Relocated): number[] {
  const out = [...(r.lead ?? [])]
  for (const link of r.chain ?? []) {
    out.push(0xa9, link.cgramIdx)
    out.push(...(link.tail ? tailWrite(link.table) : taxKernel(link.table)))
  }
  if (r.terminator !== null) out.push(r.terminator ?? 0x6b)
  return out
}

/**
 * A LoROM cart carrying the NMI palette routine, its frame table, and the
 * approaches the detector walks to decide the routine is reached. Colors are
 * a recognisable ramp so a misread offset is visible.
 */
function buildRom(shape: Shape = {}): RomFile {
  const mask = shape.mask ?? 0x1c
  const shift = shape.shift ?? 1
  const kernelBaseDp = shape.kernelBaseDp ?? 0x00
  const callerBaseDp = shape.callerBaseDp ?? kernelBaseDp
  const gap = shape.highOperandGap ?? 1
  const table = shape.tableAddr ?? TABLE
  const size = shape.size ?? BUF_SIZE

  const buf = Buffer.alloc(size, 0)
  buf[0x7fd5] = 0x20

  const write = (snes: number, bytes: number[]): void => {
    bytes.forEach((b, i) => {
      buf[off(snes, size) + i] = b
    })
  }

  // Approaches: NMI vector and prologue, the level block entry and the two
  // branches into it, and the overworld arm's call.
  write(PROBE_NMI_VECTOR, [lo(NMI), hi(NMI)])
  write(NMI, [0x78, 0x08, 0xc2, 0x30, 0x48, 0xda, 0x5a, 0x8b, 0x4b, 0xab])
  write(PROBE_LEVEL_BLOCK_ENTRY, [0xe2, 0x20])
  write(PROBE_LEVEL_APPROACHES[0]!, [
    0xf0,
    PROBE_LEVEL_BLOCK_ENTRY - PROBE_LEVEL_APPROACHES[0]! - 2,
  ])
  write(PROBE_LEVEL_APPROACHES[1]!, [
    0x80,
    PROBE_LEVEL_BLOCK_ENTRY - PROBE_LEVEL_APPROACHES[1]! - 2,
  ])
  write(PROBE_OW_CALL_SITE, [0x20, lo(PROBE_OW_ROUTINE_ENTRY), hi(PROBE_OW_ROUTINE_ENTRY)])
  write(PROBE_OW_ROUTINE_ENTRY, [0xc2, 0x10])

  // Level caller: LDA #$64 falling into the zeroing entry.
  write(PROBE_LEVEL_TARGET, [0xa9, VANILLA_EXPECTED.levelCgramIdx])
  write(ZERO_ENTRY, [0x64, callerBaseDp])
  write(KERNEL, [
    0x8d,
    0x21,
    0x21, // STA $2121
    0xa5,
    shape.counterDp ?? 0x14, // LDA EffFrame
    0x29,
    mask, // AND #mask
    ...new Array(shift).fill(0x4a), // LSR A
    ...(shape.clc ? [0x18] : []), // CLC
    0x65,
    kernelBaseDp, // ADC base
    0xa8, // TAY
    0xb9,
    lo(table),
    hi(table), // LDA table,Y
    0x8d,
    0x22,
    0x21, // STA $2122
    0xb9,
    lo(table + gap),
    hi(table + gap),
    0x8d,
    0x22,
    0x21,
    0x60, // RTS
  ])

  // Overworld callers: one through the zeroing entry, one preloading $10.
  write(PROBE_OW_FIRST_TARGET, [
    0xa9,
    VANILLA_EXPECTED.overworldCgramIdx[0],
    0x20,
    lo(ZERO_ENTRY),
    hi(ZERO_ENTRY),
  ])
  write(PROBE_OW_SECOND_BASE, [
    0xa9,
    0x10,
    0x85,
    callerBaseDp,
    0xa9,
    VANILLA_EXPECTED.overworldCgramIdx[1],
    0x4c,
    lo(KERNEL),
    hi(KERNEL),
  ])

  // Frame table: word n is 0x0100 * n by default, so a misread offset shows
  // up as a wrong phase rather than as plausible noise.
  const words = shape.colors ?? Array.from({ length: 16 }, (_, n) => n << 8)
  words.forEach((w, n) => {
    buf[off(table, size) + n * 2] = w & 0xff
    buf[off(table, size) + n * 2 + 1] = (w >> 8) & 0xff
  })

  // A cart that moved its overworld upload out of bank $00 and left the long
  // call behind, the way Grand Poo World 2 does.
  if (shape.relocate) {
    write(PROBE_OW_ROUTINE_ENTRY, [
      0x22,
      lo(shape.relocate.at),
      hi(shape.relocate.at),
      (shape.relocate.at >> 16) & 0xff,
      0x60,
    ])
    write(shape.relocate.at, relocatedBody(shape.relocate))
  }
  for (const t of shape.tables ?? []) {
    t.words.forEach((w, n) => {
      buf[off(t.at, size) + n * 2] = w & 0xff
      buf[off(t.at, size) + n * 2 + 1] = (w >> 8) & 0xff
    })
  }
  for (const b of shape.blobs ?? []) write(b.at, b.bytes)

  for (const [addr, byte] of Object.entries(shape.poke ?? {})) {
    buf[off(Number(addr), size)] = byte
  }
  return new RomFile('synthetic.sfc', buf)
}

/** The whole routine, unreachable because the NMI vector was redirected. */
const hijackedVector = { [PROBE_NMI_VECTOR]: 0x00, [PROBE_NMI_VECTOR + 1]: 0x90 }

/**
 * Point the vector at a chain of `hops` stubs, each a single `JML` to the
 * next, with the last landing on the real NMI. One hop is what the corpus
 * carts do; the rest sweep the follower's limit from both sides.
 */
function trampoline(hops: number): Record<number, number> {
  const STUB = 0x00b000
  const poke: Record<number, number> = {
    [PROBE_NMI_VECTOR]: STUB & 0xff,
    [PROBE_NMI_VECTOR + 1]: (STUB >> 8) & 0xff,
  }
  for (let i = 0; i < hops; i++) {
    const to = i === hops - 1 ? NMI : STUB + (i + 1) * 4
    // JML long, with the bank byte set to the $80 mirror the real carts use.
    poke[STUB + i * 4] = 0x5c
    poke[STUB + i * 4 + 1] = to & 0xff
    poke[STUB + i * 4 + 2] = (to >> 8) & 0xff
    poke[STUB + i * 4 + 3] = 0x80
  }
  return poke
}

// ── The stock shape decodes ──────────────────────────────────────────────

describe('detectPaletteAnimation on an intact routine', () => {
  it('derives the level index, table and phases from the opcodes', () => {
    const d = detectPaletteAnimation(buildRom())
    expect(d.level.available).toBe(true)
    expect(d.level.targets).toHaveLength(1)
    const t = d.level.targets[0]!
    expect(t.cgramIdx).toBe(VANILLA_EXPECTED.levelCgramIdx)
    expect(t.tableAddr).toBe(TABLE)
    expect(t.phaseCount).toBe(VANILLA_EXPECTED.phaseCount)
    expect(t.frameStride).toBe(VANILLA_EXPECTED.frameStride)
    // Phase n reads word n: the mask/shift pair walks the table two bytes
    // at a time, so a wrong shift shows up as a wrong ramp.
    expect(t.colors).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(n => n << 8))
  })

  it('derives both overworld indices, the second from its preloaded base', () => {
    const d = detectPaletteAnimation(buildRom())
    expect(d.overworld.available).toBe(true)
    expect(d.overworld.targets.map(t => t.cgramIdx)).toEqual([
      ...VANILLA_EXPECTED.overworldCgramIdx,
    ])
    expect(d.overworld.targets[0]!.tableAddr).toBe(TABLE)
    expect(d.overworld.targets[1]!.tableAddr).toBe(TABLE + 0x10)
    expect(d.overworld.targets[1]!.colors).toEqual([8, 9, 10, 11, 12, 13, 14, 15].map(n => n << 8))
  })

  it('finds exactly one flash kernel', () => {
    expect(findFlashKernels(buildRom())).toEqual([KERNEL])
  })
})

// ── Reached, not merely present ──────────────────────────────────────────

describe('a routine that is intact but not reached yields nothing', () => {
  it('a redirected NMI vector invalidates both contexts', () => {
    const rom = buildRom({ poke: hijackedVector })
    // The routine itself is untouched, which is the whole point.
    expect(decodeFlashKernel(rom, KERNEL)).not.toBeNull()
    const d = detectPaletteAnimation(rom)
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
    expect(d.level.targets).toEqual([])
    expect(d.level.notes.join(' ')).toContain('$009000')
    expect(loadPaletteAnimData(rom, 'level')).toBeNull()
    expect(loadPaletteAnimData(rom, 'overworld')).toBeNull()
  })

  // MAX_JUMP_HOPS is 4. Swept either side rather than at one value, because
  // a limit tested only where it passes is not a limit.
  it.each([1, 2, 3, 4])('follows a %i-hop trampoline to the real handler', hops => {
    const d = detectPaletteAnimation(buildRom({ poke: trampoline(hops) }))
    expect(d.level.available).toBe(true)
    expect(d.overworld.available).toBe(true)
    expect(d.level.targets[0]!.cgramIdx).toBe(VANILLA_EXPECTED.levelCgramIdx)
  })

  it.each([5, 6])('refuses a %i-hop chain rather than accepting where it stopped', hops => {
    const d = detectPaletteAnimation(buildRom({ poke: trampoline(hops) }))
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
    expect(d.level.targets).toEqual([])
    // It must refuse, not silently treat the last stub as the handler.
    expect(d.level.notes.join(' ')).toContain('diverted')
  })

  it('a stub that does work before jumping is not followed', () => {
    // NOP then JML: the first opcode is not a jump, so the chain stops at
    // the stub and the prologue check rejects it.
    const poke = { ...trampoline(1), [0x00b000]: 0xea }
    const d = detectPaletteAnimation(buildRom({ poke }))
    expect(d.level.available).toBe(false)
  })

  it('a prologue without its PHK/PLB invalidates both contexts', () => {
    // The frame table operand is 16-bit; the bank it resolves against is the
    // one this PLB installs. Without it the table address would be a guess,
    // so the whole detection is refused rather than reported.
    const d = detectPaletteAnimation(buildRom({ poke: { [NMI + 8]: 0xea, [NMI + 9]: 0xea } }))
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
    expect(d.level.notes.join(' ')).toContain('prologue')
  })

  it('a JML poked over the NMI prologue invalidates both contexts', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [NMI]: 0x5c } }))
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
  })

  it('an RTS at the level block entry invalidates only the level context', () => {
    const rom = buildRom({ poke: { [PROBE_LEVEL_BLOCK_ENTRY]: 0x60 } })
    expect(decodeFlashKernel(rom, KERNEL)).not.toBeNull()
    const d = detectPaletteAnimation(rom)
    expect(d.level.available).toBe(false)
    expect(d.level.notes.join(' ')).toContain('SEP #$20')
    expect(d.overworld.available).toBe(true)
  })

  it.each([0, 1])('a branch at approach %i retargeted invalidates the level context', i => {
    const addr = PROBE_LEVEL_APPROACHES[i]!
    const d = detectPaletteAnimation(buildRom({ poke: { [addr + 1]: 0x02 } }))
    expect(d.level.available).toBe(false)
    expect(d.level.notes.join(' ')).toContain(addr.toString(16).toUpperCase())
    expect(d.overworld.available).toBe(true)
  })

  it('a branch replaced by a non-branch invalidates the level context', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_LEVEL_APPROACHES[0]!]: 0xea } }))
    expect(d.level.available).toBe(false)
    expect(d.level.notes.join(' ')).toContain('a branch into $00A418')
  })

  it('a retargeted overworld call invalidates only the overworld context', () => {
    const rom = buildRom({
      poke: { [PROBE_OW_CALL_SITE + 1]: 0x00, [PROBE_OW_CALL_SITE + 2]: 0x90 },
    })
    const d = detectPaletteAnimation(rom)
    expect(d.overworld.available).toBe(false)
    expect(d.overworld.notes.join(' ')).toContain('$008237')
    expect(d.level.available).toBe(true)
  })

  it('a rewritten overworld routine head invalidates the overworld context', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_OW_ROUTINE_ENTRY]: 0x5c } }))
    expect(d.overworld.available).toBe(false)
    expect(d.overworld.notes.join(' ')).toContain('REP #$10')
  })
})

// ── The opcode gate, per probe ───────────────────────────────────────────

describe('a replaced routine reports unavailable and names no index', () => {
  it('level: a non-LDA opcode at the probe yields no target', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_LEVEL_TARGET]: 0x22 } }))
    expect(d.level.available).toBe(false)
    expect(d.level.targets).toEqual([])
    expect(d.level.notes.join(' ')).toContain('$00A41A')
  })

  it('level: the stock index is not substituted when the gate fails', () => {
    const rom = buildRom({ poke: { [PROBE_LEVEL_TARGET]: 0x22 } })
    expect(detectPaletteAnimation(rom).level.targets.map(t => t.cgramIdx)).not.toContain(
      VANILLA_EXPECTED.levelCgramIdx,
    )
    expect(loadPaletteAnimData(rom, 'level')).toBeNull()
  })

  it('overworld: breaking only the first target invalidates the whole context', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_OW_FIRST_TARGET]: 0x22 } }))
    expect(d.overworld.available).toBe(false)
    expect(d.overworld.targets).toEqual([])
  })

  it('overworld: breaking only the second target invalidates the whole context', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_OW_SECOND_TARGET]: 0x22 } }))
    expect(d.overworld.available).toBe(false)
    expect(d.overworld.targets).toEqual([])
  })

  it('contexts fail independently', () => {
    const d = detectPaletteAnimation(buildRom({ poke: { [PROBE_LEVEL_TARGET]: 0x22 } }))
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(true)
  })

  it('a rewritten kernel body invalidates every context that reaches it', () => {
    const rom = buildRom({ poke: { [KERNEL]: 0xea } })
    const d = detectPaletteAnimation(rom)
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
    expect(findFlashKernels(rom)).toEqual([])
  })

  it('the note names where the routine actually diverges, not the probe', () => {
    // Garbage inside the kernel body. The probe at $00A41A is still a
    // correct `LDA #$64`, so naming it would misdirect.
    const inside = KERNEL + 8
    const notes = detectPaletteAnimation(buildRom({ poke: { [inside]: 0xea } })).level.notes.join(
      ' ',
    )
    expect(notes).toContain(inside.toString(16).toUpperCase())
    expect(notes).toContain('does not decode')
    expect(notes).not.toContain('$00A41A holds')
  })
})

// ── Kernel invariants ────────────────────────────────────────────────────

describe('decodeFlashKernel invariants', () => {
  it('rejects a kernel whose base store misses the byte the add reads', () => {
    // The kernel itself is intact, so it still decodes standalone.
    const rom = buildRom({ kernelBaseDp: 0x02, callerBaseDp: 0x00 })
    expect(decodeFlashKernel(rom, KERNEL)).not.toBeNull()
    // The callers are not connected to it, so no context resolves.
    const d = detectPaletteAnimation(rom)
    expect(d.level.available).toBe(false)
    expect(d.overworld.available).toBe(false)
  })

  it('rejects two table reads that do not form one word', () => {
    expect(decodeFlashKernel(buildRom({ highOperandGap: 2 }), KERNEL)).toBeNull()
  })

  it('rejects a mask whose last LSR can carry into the add', () => {
    // Mask $1D keeps bit 0, so `LSR A` sets carry on odd counters and the
    // ADC would land one byte past the phase.
    expect(decodeFlashKernel(buildRom({ mask: 0x1d }), KERNEL)).toBeNull()
  })

  it('rejects a kernel with no LSR, whose carry is whatever the caller left', () => {
    expect(decodeFlashKernel(buildRom({ shift: 0 }), KERNEL)).toBeNull()
  })

  it.each([0x13, 0x14])('accepts frame counter $%s', dp => {
    expect(decodeFlashKernel(buildRom({ counterDp: dp }), KERNEL)).not.toBeNull()
  })

  it('rejects a counter that is not a frame counter', () => {
    // The cadence the editors replay at is built on the counter's tick rate,
    // so reading the byte and then assuming it is EffFrame would be a guess.
    expect(decodeFlashKernel(buildRom({ counterDp: 0x20 }), KERNEL)).toBeNull()
    expect(detectPaletteAnimation(buildRom({ counterDp: 0x20 })).level.available).toBe(false)
  })

  it('rejects an empty mask', () => {
    expect(decodeFlashKernel(buildRom({ mask: 0x00 }), KERNEL)).toBeNull()
  })

  it('rejects a mask and shift that reach only one offset', () => {
    // AND #$01 with three LSR: every counter indexes byte 0. There is no
    // animation there, and calling it a one-phase cycle would be a fiction.
    expect(decodeFlashKernel(buildRom({ mask: 0x01, shift: 3 }), KERNEL)).toBeNull()
  })

  it('accepts a CLC, which makes the add exact whatever the mask does', () => {
    // Behaviour-identical to stock on stock's mask, and the reason a
    // hand-edited cart should not be refused for a cosmetic difference.
    expect(decodeFlashKernel(buildRom({ clc: true }), KERNEL)?.phaseOffsets).toEqual(
      decodeFlashKernel(buildRom(), KERNEL)?.phaseOffsets,
    )
    // With a CLC the carry rule no longer has to hold.
    expect(decodeFlashKernel(buildRom({ mask: 0x1d, clc: true }), KERNEL)).not.toBeNull()
    expect(decodeFlashKernel(buildRom({ shift: 0, mask: 0x0e, clc: true }), KERNEL)).not.toBeNull()
  })
})

// ── Phase sequence, count and period follow the mask ─────────────────────

describe('the phase sequence comes from the mask and shift', () => {
  it('a four-phase mask yields four phases', () => {
    // AND #$0C / LSR -> offsets 0,2,4,6 and a phase every 4 counter ticks.
    const k = decodeFlashKernel(buildRom({ mask: 0x0c }), KERNEL)!
    expect(k.phaseOffsets).toEqual([0, 2, 4, 6])
    expect(k.frameStride).toBe(4)
    expect(k.periodTicks).toBe(16)
  })

  it('a wider mask yields more phases', () => {
    // AND #$3C / LSR -> 16 offsets, still 2 bytes apart.
    const k = decodeFlashKernel(buildRom({ mask: 0x3c }), KERNEL)!
    expect(k.phaseOffsets).toHaveLength(16)
    expect(k.phaseOffsets[1]! - k.phaseOffsets[0]!).toBe(2)
  })

  it('a slower mask yields a longer stride', () => {
    // AND #$70 / LSR x4 -> a phase every 16 counter ticks, one byte apart.
    const k = decodeFlashKernel(buildRom({ mask: 0x70, shift: 4 }), KERNEL)!
    expect(k.frameStride).toBe(0x10)
    expect(k.phaseOffsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(k.periodTicks).toBe(128)
  })

  it('a non-contiguous mask keeps counter order and its true period', () => {
    // AND #$2C / LSR revisits offsets 0,2,4,6 at ticks 16-31 before moving
    // on, and only repeats after 64 ticks. Sorting the distinct offsets
    // would replay 8 frames over 32 ticks and diverge from tick 16.
    const k = decodeFlashKernel(buildRom({ mask: 0x2c }), KERNEL)!
    expect(k.phaseOffsets).toEqual([0, 2, 4, 6, 0, 2, 4, 6, 16, 18, 20, 22, 16, 18, 20, 22])
    expect(k.periodTicks).toBe(64)
    expect(k.frameStride).toBe(4)
  })

  it('the loader replays the derived count, not eight', () => {
    expect(loadPaletteAnimData(buildRom({ mask: 0x0c }), 'level')!.frameCount).toBe(4)
    expect(loadPaletteAnimData(buildRom({ mask: 0x2c }), 'level')!.frameCount).toBe(16)
  })

  it('the loader replays a non-contiguous mask in counter order', () => {
    const data = loadPaletteAnimData(buildRom({ mask: 0x2c }), 'level')!
    // Word n is n << 8, so the blue channel of frame f names the byte offset.
    const blue = data.frames.map(f => f[0]!.color[2])
    expect(blue[0]).toBe(blue[4])
    expect(blue[8]).toBe(blue[12])
    expect(blue[0]).not.toBe(blue[8])
  })
})

// ── Relocation ───────────────────────────────────────────────────────────

describe('a relocated table is followed, a relocated kernel is not guessed at', () => {
  // Swept over several destinations rather than one: a detector that
  // hardcodes $00B60C passes any test whose table happens to sit there.
  it.each(['00B700', '00A800', '00FE00'])('reads the frame table at $%s from the operand', hex => {
    const moved = parseInt(hex, 16)
    const rom = buildRom({ tableAddr: moved, colors: [0x7fab, 0x0123, 0x4567] })
    expect(decodeFlashKernel(rom, KERNEL)!.tableAddr).toBe(moved)
    // Nothing is left at the stock address, so a hardcoded reader sees zeros.
    expect(rom.readWord(VANILLA_EXPECTED.frameTableAddr)).toBe(0)

    const d = detectPaletteAnimation(rom)
    expect(d.level.targets[0]!.tableAddr).toBe(moved)
    expect(d.level.targets[0]!.colors.slice(0, 3)).toEqual([0x7fab, 0x0123, 0x4567])
    expect(d.overworld.targets[0]!.tableAddr).toBe(moved)
    expect(d.overworld.targets[1]!.tableAddr).toBe(moved + 0x10)
  })

  /** A verbatim second copy of the kernel at an address nothing calls. */
  function withKernelCopy(copyAt: number, shape: Shape = {}): RomFile {
    const source = buildRom(shape)
    const bytes = Buffer.from(source.buffer)
    const size = shape.size ?? BUF_SIZE
    for (let i = 0; i < 24; i++) bytes[off(copyAt, size) + i] = bytes[off(KERNEL, size) + i]!
    return new RomFile('synthetic.sfc', bytes)
  }

  it('a second decodable kernel does not change an intact detection', () => {
    const rom = withKernelCopy(0x00c000)
    expect(findFlashKernels(rom)).toEqual([KERNEL, 0x00c000])
    expect(detectPaletteAnimation(rom).level.available).toBe(true)
  })

  it('an unavailable context says how many places the pattern decodes', () => {
    const one = detectPaletteAnimation(buildRom({ poke: { [PROBE_LEVEL_TARGET]: 0x22 } }))
    expect(one.level.notes.join(' ')).toContain('still decodes at $00A41E')

    const two = detectPaletteAnimation(
      withKernelCopy(0x00c000, { poke: { [PROBE_LEVEL_TARGET]: 0x22 } }),
    )
    expect(two.level.available).toBe(false)
    expect(two.level.notes.join(' ')).toContain('decodes at 2 addresses')
  })

  it('sees a kernel in the last bank of a 4MB cart', () => {
    // Those offsets map to banks $FE/$FF. Reporting "nowhere else in this
    // cart" for a kernel that is plainly there would be a false negative.
    const rom = withKernelCopy(0x00ffc000, { size: 0x400000 })
    expect(findFlashKernels(rom)).toContain(0x00ffc000)
  })
})

// ── Relocated overworld uploads ──────────────────────────────────────────

/**
 * A cart that moves the overworld upload out of bank $00 is the shape this
 * module is least able to guess about, so every fixture here but the first
 * two is a refusal. CI never has a cartridge, so a safeguard with only
 * corpus coverage is unproven where it actually runs.
 */
describe('a relocated overworld upload', () => {
  const AT = 0x1b8000
  const TABLE = 0x00b60c
  const ramp = Array.from({ length: 16 }, (_, n) => (n + 1) << 8)
  // Bank $1B needs a cart at least 2MB, or the landing address is unmapped
  // and every one of these passes for the wrong reason.
  const relocated = (shape: Shape): RomFile => buildRom({ size: 0x200000, ...shape })

  it('is read when the routine falls straight through to its writes', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: {
          at: AT,
          lead: [0xe2, 0x30], // SEP #$30
          chain: [
            { cgramIdx: 0x6d, table: TABLE },
            { cgramIdx: 0x7d, table: TABLE + 0x10, tail: true },
          ],
        },
        tables: [{ at: TABLE, words: ramp }],
      }),
    )
    expect(d.overworld.available).toBe(true)
    expect(d.overworld.targets.map(t => [t.cgramIdx, t.tableAddr])).toEqual([
      [0x6d, TABLE],
      [0x7d, TABLE + 0x10],
    ])
    expect(d.overworld.targets[0]!.phaseCount).toBe(8)
  })

  // R1: the scan used to take the first matching bytes anywhere in the bank,
  // reachable or not.
  it('refuses when the routine returns before writing anything', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, lead: [0x6b], chain: [] },
        // An unrelated kernel further up the bank. Every edited cart in the
        // corpus carries one of these, so finding it is the normal case.
        blobs: [{ at: 0x1b9000, bytes: [0xa9, 0x2a, ...taxKernel(0x00b700), 0x6b] }],
        tables: [{ at: 0x00b700, words: ramp }],
      }),
    )
    expect(d.overworld.available).toBe(false)
    expect(d.overworld.targets).toEqual([])
  })

  it('refuses when the routine jumps out of its bank before writing', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, lead: [0x5c, 0x00, 0x90, 0x14], chain: [] },
        blobs: [{ at: 0x1b9000, bytes: [0xa9, 0x2a, ...taxKernel(0x00b700), 0x6b] }],
        tables: [{ at: 0x00b700, words: ramp }],
      }),
    )
    expect(d.overworld.available).toBe(false)
  })

  // R4: an unconditional branch over a decoy is determinate, so follow it.
  it('follows a branch over a decoy rather than reporting the decoy', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, lead: [0x80, 0x20], chain: [] }, // BRA +$20
        blobs: [
          { at: AT + 2, bytes: [0xa9, 0x2a, ...taxKernel(0x00b700), 0x6b] },
          { at: AT + 0x22, bytes: [0xa9, 0x6d, ...taxKernel(TABLE), 0x6b] },
        ],
        tables: [
          { at: TABLE, words: ramp },
          { at: 0x00b700, words: ramp },
        ],
      }),
    )
    expect(d.overworld.available).toBe(true)
    expect(d.overworld.targets.map(t => t.cgramIdx)).toEqual([0x6d])
  })

  // R2: the callee may install its own data bank, and it is three readable
  // bytes at the landing address.
  it('reads a data bank the relocated routine sets for itself', () => {
    const near = Array.from({ length: 16 }, (_, n) => 0x0100 + n)
    const far = Array.from({ length: 16 }, (_, n) => 0x7000 + n)
    const d = detectPaletteAnimation(
      relocated({
        relocate: {
          at: AT,
          lead: [0x8b, 0x4b, 0xab], // PHB / PHK / PLB -> DBR = $1B
          chain: [{ cgramIdx: 0x6d, table: 0xb60c }],
        },
        tables: [
          { at: 0x00b60c, words: near },
          { at: 0x1bb60c, words: far },
        ],
      }),
    )
    expect(d.overworld.available).toBe(true)
    expect(d.overworld.targets[0]!.tableAddr).toBe(0x1bb60c)
    expect(d.overworld.targets[0]!.colors[0]).toBe(0x7000)
  })

  // R3: a write with no arithmetic must not inherit numbers nothing read.
  it('refuses a chain whose first write has no arithmetic of its own', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, chain: [{ cgramIdx: 0x6d, table: TABLE, tail: true }] },
        tables: [{ at: TABLE, words: ramp }],
      }),
    )
    expect(d.overworld.available).toBe(false)
  })

  it('does not run a chain on into a routine it never entered', () => {
    const foreign = [0x31, 0x32, 0x33].flatMap(i => [0xa9, i, ...tailWrite(TABLE)])
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, chain: [{ cgramIdx: 0x6d, table: TABLE }], terminator: null },
        blobs: [{ at: AT + 2 + 21, bytes: [...foreign, 0x6b] }],
        tables: [{ at: TABLE, words: ramp }],
      }),
    )
    const seen = d.overworld.targets.map(t => t.cgramIdx)
    expect(seen).not.toContain(0x31)
    expect(seen).not.toContain(0x33)
  })

  // R5: a cycle that does not cycle is not a cycle.
  it('refuses a chain whose frames are all one colour', () => {
    const flat = new Array(16).fill(0x1234)
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, chain: [{ cgramIdx: 0x6d, table: TABLE }] },
        tables: [{ at: TABLE, words: flat }],
      }),
    )
    expect(d.overworld.available).toBe(false)
  })

  // R6: the long call is the door to this whole class, so it is validated.
  it('refuses a JSL whose target is not backed by ROM', () => {
    const d = detectPaletteAnimation(
      relocated({
        poke: {
          [PROBE_OW_ROUTINE_ENTRY]: 0x22,
          [PROBE_OW_ROUTINE_ENTRY + 1]: 0x00,
          [PROBE_OW_ROUTINE_ENTRY + 2]: 0x00,
          [PROBE_OW_ROUTINE_ENTRY + 3]: 0x7e,
        },
      }),
    )
    expect(d.overworld.available).toBe(false)
  })

  it('leaves the level context alone whatever the overworld does', () => {
    const d = detectPaletteAnimation(
      relocated({
        relocate: { at: AT, lead: [0x6b], chain: [] },
      }),
    )
    expect(d.level.available).toBe(true)
    expect(d.level.targets[0]!.cgramIdx).toBe(VANILLA_EXPECTED.levelCgramIdx)
  })
})

// ── Frame addresses and timing metadata ──────────────────────────────────

describe('targets carry their own frame addresses and timing', () => {
  it('maskAddr is the AND #imm after STA $2121 and LDA dp', () => {
    // STA abs (3 bytes) + LDA dp (2 bytes) precede the AND in the stock shape.
    expect(decodeFlashKernel(buildRom(), KERNEL)!.maskAddr).toBe(KERNEL + 5)
  })

  it('frameAddrs are the table plus each phase offset, in counter order', () => {
    const t = detectPaletteAnimation(buildRom()).level.targets[0]!
    const k = decodeFlashKernel(buildRom(), KERNEL)!
    expect(t.frameAddrs).toEqual(k.phaseOffsets.map(o => t.tableAddr + o))
    expect(t.frameAddrs.length).toBe(t.colors.length)
  })

  // Literal addresses, not re-derived from phaseOffsets: an oracle that
  // recomputes the detector's own formula agrees with any bug in it.
  it('the level target reads $00B60C through $00B61A, two bytes apart', () => {
    const t = detectPaletteAnimation(buildRom()).level.targets[0]!
    expect(t.frameAddrs).toEqual([
      0x00b60c, 0x00b60e, 0x00b610, 0x00b612, 0x00b614, 0x00b616, 0x00b618, 0x00b61a,
    ])
  })

  it("the second overworld target's frames start at its $10 base", () => {
    const t = detectPaletteAnimation(buildRom()).overworld.targets[1]!
    expect(t.frameAddrs).toEqual([
      0x00b61c, 0x00b61e, 0x00b620, 0x00b622, 0x00b624, 0x00b626, 0x00b628, 0x00b62a,
    ])
  })

  // The kernel adds the base with an 8-bit ADC (A is 8-bit after SEP #$20,
  // bank_00.asm:4662; ADC.B _0 / TAY at :4671-4672), so Y wraps at $FF and
  // the read lands back at the start of the table, not $100 past it.
  it('a base plus offset past $FF wraps the index, as the 8-bit ADC does', () => {
    const rom = buildRom({
      poke: { [PROBE_OW_SECOND_BASE + 1]: 0xf8 },
      tables: [{ at: TABLE + 0xf8, words: [0x7001, 0x7002, 0x7003, 0x7004] }],
    })
    const t = detectPaletteAnimation(rom).overworld.targets[1]!
    expect(t.frameAddrs).toEqual([
      0x00b704, 0x00b706, 0x00b708, 0x00b70a, 0x00b60c, 0x00b60e, 0x00b610, 0x00b612,
    ])
    expect(t.colors).toEqual([0x7001, 0x7002, 0x7003, 0x7004, 0x0000, 0x0100, 0x0200, 0x0300])
  })

  it('timing reports the mask and shift the kernel actually holds', () => {
    const t = detectPaletteAnimation(buildRom({ mask: 0x0c })).level.targets[0]!
    expect(t.timing).toEqual({ maskAddr: KERNEL + 5, mask: 0x0c, shift: 1, counterDp: 0x14 })
  })
})
