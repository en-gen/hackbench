/**
 * Made-up boot routines and carts for MarioGraphics (#980), shared by the synthetic test and the vanilla-window scan.
 * Nothing here is the cart's code: the head and filler are invented, only the operand layout is the stock one.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import type { CompressionCheck } from '../../../src/rom/GfxArena'
import { fingerprint } from '../../../src/rom/Fingerprint'
import { bootFingerprint, type BootRoutine } from '../../../src/rom/MarioGraphics'

/** Distinct, scattered byte values for consecutive indexes (an ascending run of small values occurs in the vanilla ROM). */
export const seq = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => (((from + i) * 37) % 251) + 1)

// A made-up boot routine with the stock operand layout (84 bytes; operands at 3-4, 8, 30-31, 35-36, 80-81).
export const HEAD = [0xa5, 0x5a, 0xa5]
export const BOOT_LEN = 84
export type Operands = { at33: number; bank: number; top: number; srcTop: number; at32: number }
export const routine = (o: Operands) => {
  const b = new Array<number>(BOOT_LEN).fill(0xea)
  b.splice(0, 3, ...HEAD)
  const word = (at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >> 8) & 0xff } // prettier-ignore
  word(3, o.at33)
  b[8] = o.bank
  word(30, o.top)
  word(35, o.srcTop)
  word(80, o.at32)
  return b
}
export const boot = (): BootRoutine => ({
  anchor: HEAD,
  length: BOOT_LEN,
  sha256: bootFingerprint(
    Uint8Array.from(routine({ at33: 0, bank: 0, top: 0, srcTop: 0, at32: 0 })),
  )!,
})
/** A made-up upload routine (64 bytes, invented head and filler) and its record, as `boot` is for the boot routine. */
export const DMA_HEAD = [0xa5, 0x5c, 0xa6]
export const dmaCode = (): number[] => [...DMA_HEAD, ...new Array<number>(61).fill(0xea)]
export const dma = (): BootRoutine => ({ anchor: DMA_HEAD, length: 64, sha256: fingerprint(Uint8Array.from(dmaCode()))! }) // prettier-ignore
export const GATE: CompressionCheck = {
  ok: true,
  sites: {} as never,
  kind: 'stock' as never,
  order: 'be',
}
export const base = (bank: number) => bank * 0x8000 // file offset of $bank:8000 in a LoROM

/** GFX33 ends at the top of bank $08, so GFX32 starts at the bottom of the next one. */
export const bankCarryCart = () => {
  const c33 = encode(Uint8Array.from(seq(1, 48)))
  const low = 0x10000 - c33.length
  const bytes = new Uint8Array(0x80000)
  bytes.set(c33, base(8) + low - 0x8000)
  bytes.set(encode(Uint8Array.from(Array(16).fill(0xee))), base(9))
  bytes.set(routine({ at33: low, bank: 8, top: 0x205e, srcTop: 47, at32: 0x8000 }), 0x100)
  return RomFile.fromBytes('s.sfc', bytes)
}

/** GFX33 at $48:0000, which LoROM reads at file offset $48 * $8000 though the pointer is not into a ROM half. */
export const highBankCart = () => {
  const [c33, c32] = [encode(Uint8Array.from(seq(1, 48))), encode(Uint8Array.from(Array(16).fill(0xee)))] // prettier-ignore
  const bytes = new Uint8Array(0x400000)
  bytes.set(c33, 0x48 * 0x8000)
  bytes.set(c32, 0x48 * 0x8000 + c33.length)
  bytes.set(routine({ at33: 0, bank: 0x48, top: 0x205e, srcTop: 47, at32: c33.length }), 0x100)
  return RomFile.fromBytes('s.sfc', bytes)
}

export type Cart = { d33?: number[]; d32?: number[]; bank?: number; low?: number; top?: number; srcTop?: number; copies?: number; edit?: (b: number[]) => void } // prettier-ignore
/** A cart with GFX33 at $<bank>:<low>, GFX32 right after it, and `copies` of the boot routine. */
export const cart = (o: Cart) => {
  const [bank, low] = [o.bank ?? 8, o.low ?? 0x8000]
  const c33 = encode(Uint8Array.from(o.d33 ?? seq(1, 48)))
  const c32 = encode(Uint8Array.from(o.d32 ?? Array(16).fill(0xee)))
  const bytes = new Uint8Array(0x80000)
  bytes.set(c33, base(bank) + low - 0x8000)
  bytes.set(c32, base(bank) + low - 0x8000 + c33.length)
  const code = routine({ at33: low, bank, top: o.top ?? 0x205e, srcTop: o.srcTop ?? 47, at32: low + c33.length }) // prettier-ignore
  o.edit?.(code)
  for (let i = 0; i < (o.copies ?? 1); i++) bytes.set(code, 0x100 + i * 0x100)
  return RomFile.fromBytes('synthetic.sfc', bytes)
}
