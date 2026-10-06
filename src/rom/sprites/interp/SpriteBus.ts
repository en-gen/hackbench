/**
 * SpriteBus.ts -- the machine a sprite routine runs on: 128 KB WRAM, the cart
 * read through LoROM, and the hardware registers a sprite touches stubbed.
 * No SMW knowledge beyond the OAM mirror ranges the caller names; no shell.
 *
 * Hardware modelled (everything else in $2000-$43FF reads 0 and counts its
 * writes): the CPU multiply/divide unit ($4202-$4206 in, $4214-$4217 out) and
 * the PPU signed multiply ($211B/$211C in, $2134-$2136 out). Evidence scope:
 * the register layouts are the SNES hardware's own; exercised by unit tests on
 * synthetic code only.
 */
import type { Bus } from '../../cpu/Cpu65816'
import { loromToOffset } from '../../addressing'
import type { RomFile } from '../../RomFile'

export const WRAM_SIZE = 0x20000

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
  private written = new Uint8Array(WRAM_SIZE)
  /** Forgets which WRAM bytes were written, so `inputs` reads them again (one run's inputs are not the last run's). */
  clearWritten(): void {
    this.written.fill(0)
  }
  private mul = { a: 0, prod: 0, dividend: 0, quot: 0, rem: 0 }
  private ppuMul = { m7a: 0, prev: 0, result: 0 }
  private header: number

  constructor(private readonly rom: RomFile) {
    this.header = rom.hasHeader ? rom.buffer.length - rom.romSize : 0
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
    const off = loromToOffset(addr, this.rom.romSize)
    return off === null ? 0 : this.rom.buffer[off + this.header]
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
    } else if (lo === 0x211b) {
      // Two writes build a 16-bit multiplicand: this byte is high, the last was low.
      this.ppuMul.m7a = (v << 8) | this.ppuMul.prev
      this.ppuMul.prev = v
    } else if (lo === 0x211c) {
      const a = this.ppuMul.m7a & 0x8000 ? this.ppuMul.m7a - 0x10000 : this.ppuMul.m7a
      const b = v & 0x80 ? v - 256 : v
      this.ppuMul.result = (a * b) & 0xffffff
    }
  }
}
