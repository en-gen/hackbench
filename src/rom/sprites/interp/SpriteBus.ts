/**
 * SpriteBus.ts -- the machine a sprite routine runs on: 128 KB WRAM, the cart
 * read through LoROM, and the hardware registers a sprite touches stubbed.
 * No SMW knowledge beyond the OAM mirror ranges the caller names; no shell.
 *
 * Deliberately absent (a reader cannot tell a stub from an omission otherwise):
 * open bus, the WRAM port $2180-$2183, DMA, $4210-$4212, and HiROM (refused
 * up front, see Machine.ts). SRAM is ONE 32 KB buffer aliased across
 * $70-$7D and $F0-$FD (a real chip is smaller and mirrors inside it; no vanilla
 * path touches SRAM), and `recordWrites` does not see its writes. ROM reads past the image
 * mirror (`romOffset`).
 *
 * Hardware modelled (everything else in $2000-$43FF reads 0 and counts its
 * writes): the CPU multiply/divide unit ($4202-$4206 in, $4214-$4217 out) and
 * the PPU signed multiply ($211B/$211C in, $2134-$2136 out). Evidence scope:
 * the register layouts are the SNES hardware's own; exercised by unit tests on
 * synthetic code only.
 */
import type { Bus } from '../../cpu/Cpu65816'
import type { RomFile } from '../../RomFile'

export const WRAM_SIZE = 0x20000
export const SRAM_SIZE = 0x8000

/**
 * File offset (header-stripped) a LoROM address reads, or null when the address
 * is not cart ROM: WRAM ($7E/$7F), the register and low-RAM half of banks
 * $00-$3F/$80-$BF, and the SRAM window ($70-$7D/$F0-$FD, $0000-$7FFF). Reads
 * past the image mirror as the board does: the address wraps at the next power
 * of two, and a remainder above a non-power-of-two image repeats the image's
 * upper part. Done here and not in addressing.ts because the bus owns the SRAM
 * window; `loromToOffset` has callers that rely on null past the image.
 */
export function romOffset(addr: number, romSize: number): number | null {
  const bank = (addr >>> 16) & 0xff
  const lo = addr & 0xffff
  if (bank === 0x7e || bank === 0x7f || !(romSize > 0)) return null
  const eb = bank & 0x7f
  if (lo < 0x8000 && (eb < 0x40 || (eb >= 0x70 && eb <= 0x7d))) return null
  let off = eb * 0x8000 + (lo & 0x7fff)
  if (off >= romSize) {
    // Board mirroring as bsnes does it (its `mirror()` function, no code copied): repeatedly
    // take the largest power of two the address still reaches, and repeat the
    // part of the image above it. Exact for any size; evidence: synthetic tests.
    let addr = off
    let size = romSize
    let base = 0
    let mask = 1 << 23
    while (addr >= size) {
      while (!(addr & mask)) mask >>= 1
      addr -= mask
      if (size > mask) {
        size -= mask
        base += mask
      }
      mask >>= 1
    }
    off = base + addr
  }
  return off
}

/** The byte a LoROM address reads from `rom` (copier header skipped), or null when it is not cart ROM. */
export function romByte(rom: RomFile, addr: number): number | null {
  const off = romOffset(addr, rom.romSize)
  return off === null
    ? null
    : rom.buffer[off + (rom.hasHeader ? rom.buffer.length - rom.romSize : 0)]
}

interface MulState {
  a: number
  prod: number
  dividend: number
  quot: number
  rem: number
}
interface PpuMulState {
  m7a: number
  m7b: number
  prev: number
  result: number
}

/** Everything a run changes in a SpriteBus, for a cheap reset between runs; see `snapshot`. */
export interface BusSnapshot {
  wram: Uint8Array
  written: Uint8Array
  sram: Uint8Array
  mul: MulState
  ppuMul: PpuMulState
  hwWrites: Map<number, number>
}

export class SpriteBus implements Bus {
  readonly wram = new Uint8Array(WRAM_SIZE)
  /** Called for every WRAM write with the WRAM offset (0..$1FFFF) and value. */
  onWramWrite: ((off: number, v: number) => void) | null = null
  /** Called for every hardware-register write ($2000-$43FF) with the 16-bit address and value. */
  onHwWrite: ((reg: number, v: number) => void) | null = null
  /** Every hardware register address ($2000-$43FF, bank-folded) written, with counts. */
  readonly hwWrites = new Map<number, number>()
  onInstruction?: (addr: number, op: number) => void
  /**
   * When set, collects the WRAM offsets a run READ before anything wrote them:
   * the inputs a seed has to supply. Off by default (one extra branch per read).
   */
  inputs: Set<number> | null = null
  /** Cart SRAM window ($70-$7D/$F0-$FD:0000-7FFF), one 32 KB buffer; reads before any write are 0. */
  readonly sram = new Uint8Array(SRAM_SIZE)
  private written = new Uint8Array(WRAM_SIZE)
  private mul: MulState = { a: 0, prod: 0, dividend: 0, quot: 0, rem: 0 }
  private ppuMul: PpuMulState = { m7a: 0, m7b: 0, prev: 0, result: 0 }

  /** When set, every ROM byte read is marked here (by buffer index) and listed once in `romList`: a run's ROM inputs. */
  romSeen: Uint8Array | null = null
  romList: number[] = []

  constructor(private readonly rom: RomFile) {}

  /** Back to power-on: the multiply/divide unit and the PPU multiplier keep results between routines otherwise. */
  resetUnits(): void {
    this.mul = { a: 0, prod: 0, dividend: 0, quot: 0, rem: 0 }
    this.ppuMul = { m7a: 0, m7b: 0, prev: 0, result: 0 }
  }

  /** Forgets which WRAM bytes were written, so `inputs` reads them again (one run's inputs are not the last run's). */
  clearWritten(): void {
    this.written.fill(0)
  }

  /** Copies the whole machine state (WRAM, read-before-write map, SRAM, multiplier latches, register write counts). */
  snapshot(): BusSnapshot {
    return {
      wram: this.wram.slice(),
      written: this.written.slice(),
      sram: this.sram.slice(),
      mul: { ...this.mul },
      ppuMul: { ...this.ppuMul },
      hwWrites: new Map(this.hwWrites),
    }
  }

  /** Puts the machine back as `snapshot` found it; hooks and `inputs` are left alone. */
  restore(s: BusSnapshot): void {
    this.wram.set(s.wram)
    this.written.set(s.written)
    this.sram.set(s.sram)
    this.mul = { ...s.mul }
    this.ppuMul = { ...s.ppuMul }
    this.hwWrites.clear()
    for (const [k, v] of s.hwWrites) this.hwWrites.set(k, v)
  }

  /** WRAM offset an address reaches, or -1. Banks $00-$3F/$80-$BF mirror the low 8 KB. */
  private wramOffset(a: number): number {
    const bank = a >>> 16
    const lo = a & 0xffff
    if (bank === 0x7e) return lo
    if (bank === 0x7f) return 0x10000 + lo
    if ((bank & 0x7f) < 0x40 && lo < 0x2000) return lo
    return -1
  }

  read(addr: number): number {
    addr &= 0xffffff
    const w = this.wramOffset(addr)
    if (w >= 0) {
      if (this.inputs && !this.written[w]) this.inputs.add(w)
      return this.wram[w]
    }
    const bank = addr >>> 16
    const lo = addr & 0xffff
    if ((bank & 0x7f) < 0x40 && lo >= 0x2000 && lo < 0x4400) return this.readReg(lo)
    if (this.isSram(bank, lo)) return this.sram[lo]
    if (this.romSeen) {
      const off = romOffset(addr, this.rom.romSize)
      if (off !== null) {
        const i = off + (this.rom.hasHeader ? this.rom.buffer.length - this.rom.romSize : 0)
        if (!this.romSeen[i]) {
          this.romSeen[i] = 1
          this.romList.push(i)
        }
      }
    }
    return romByte(this.rom, addr) ?? 0
  }

  private isSram(bank: number, lo: number): boolean {
    const eb = bank & 0x7f
    return lo < 0x8000 && eb >= 0x70 && eb <= 0x7d
  }

  private readReg(lo: number): number {
    const m = this.mul
    switch (lo) {
      case 0x2134:
      case 0x2135:
      case 0x2136:
        return (this.ppuMul.result >> (8 * (lo - 0x2134))) & 0xff
      case 0x4214:
        return m.quot & 0xff
      case 0x4215:
        return (m.quot >> 8) & 0xff
      case 0x4216:
        return m.rem & 0xff
      case 0x4217:
        return (m.rem >> 8) & 0xff
      default:
        return 0
    }
  }

  write(addr: number, v: number): void {
    addr &= 0xffffff
    v &= 0xff
    const w = this.wramOffset(addr)
    if (w >= 0) {
      this.wram[w] = v
      this.written[w] = 1
      this.onWramWrite?.(w, v)
      return
    }
    const bank = addr >>> 16
    const lo = addr & 0xffff
    if (this.isSram(bank, lo)) {
      this.sram[lo] = v
      return
    }
    if ((bank & 0x7f) >= 0x40 || lo < 0x2000 || lo >= 0x4400) return
    this.hwWrites.set(lo, (this.hwWrites.get(lo) ?? 0) + 1)
    this.onHwWrite?.(lo, v)
    const m = this.mul
    if (lo === 0x4202) m.a = v
    else if (lo === 0x4203) {
      m.prod = m.a * v
      // The unit leaves the product in the remainder pair, $4216/7.
      m.rem = m.prod
    } else if (lo === 0x4204) m.dividend = (m.dividend & 0xff00) | v
    else if (lo === 0x4205) m.dividend = (m.dividend & 0xff) | (v << 8)
    else if (lo === 0x4206) {
      m.quot = v ? Math.floor(m.dividend / v) : 0xffff
      m.rem = v ? m.dividend % v : m.dividend
    } else if (lo >= 0x211b && lo <= 0x2120) {
      // $211B-$2120 (Mode 7 A-D, centre X/Y) share ONE latch: each write is
      // the high byte over whatever any of them wrote last. The multiplicand
      // is the 16-bit value $211B built; $211C's latest byte is the multiplier.
      if (lo === 0x211b) this.ppuMul.m7a = (v << 8) | this.ppuMul.prev
      if (lo === 0x211c) this.ppuMul.m7b = v
      // The product is continuous: any later $211B or $211C write changes it.
      if (lo === 0x211b || lo === 0x211c) {
        const m = this.ppuMul
        const a = m.m7a & 0x8000 ? m.m7a - 0x10000 : m.m7a
        const b = m.m7b & 0x80 ? m.m7b - 256 : m.m7b
        m.result = (a * b) & 0xffffff
      }
      this.ppuMul.prev = v
    }
  }
}
