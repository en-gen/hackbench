/**
 * A cart the production entry of the L1 interpreter can walk, built from our
 * own bytes (#442): the loader's three pinned sites, ENTRY_STANDARD
 * dispatching through a stand-in for ExecutePtrLong, the object dispatch
 * table and a handler, all at their real addresses. No Nintendo bytes.
 */
import { loromToOffset } from '../../../src/rom/addressing'
import { RomFile } from '../../../src/rom/RomFile'
import { fingerprint } from '../../../src/rom/Fingerprint'
import {
  ADDR_TILESET_DISPATCH,
  STANDARD_HANDLER_COUNT,
} from '../../../src/rom/objectHandlers/romData'
import type { RecognizedPrimitive } from '../../../src/rom/objectHandlers/interpret'

export const CODE = 0x0d8000
export const DISPATCH = 0x0d9000
const off = (snes: number): number => loromToOffset(snes, 0x400000)!
export const lo = (w: number): number => w & 0xff
export const hi = (w: number): number => (w >> 8) & 0xff

/** A blank LoROM cart (all BRK, which is outside the allowed set) with `code` at CODE. */
export function cart(code: number[], extra: [number, number[]][] = [], size = 0x80000): RomFile {
  const bytes = new Uint8Array(size)
  bytes.set(code, off(CODE))
  for (const [a, b] of extra) bytes.set(b, off(a))
  return RomFile.fromBytes('synthetic', bytes)
}

export const HANDLER = 0x0dadeb
export const PIPES = 0x0dab3e // object $12's routine; the size's low nibble picks the variant
export const CLOUD = 0x12
const VARIANT = 5 // low nibble of size $E5
export const RTL = 0x6b
const LOADER = 0x0586ea // LevLoadNrmObj (bank_05.asm:805-808)
export const ENTRY = 0x0da40f
/** ExecutePtrLong's address, the JSL target the stock dispatch path pins (#302). */
export const SIG_AT = 0x0086fa
/** Where the dispatch stub lives: ENTRY jumps here, so it stays clear of the stock bytes at $0DA415. */
const STUB_AT = 0x0d9900
const HOP_AT = 0x0d8900
/** The stock dispatch path the gate pins (#302; bank_0D.asm:1324-1327, 1345-1350). */
const STOCK_TILESET_ENTRY = [0xe2, 0x30, 0xad, 0x31, 0x19, 0x22, 0xfa, 0x86, 0x00]
const STOCK_EXTENDED_ENTRY = [0xe2, 0x30, 0xa5, 0x59, 0xaa, 0x22, 0xfa, 0x86, 0x00]
const STOCK_PREAMBLE = [0xe2, 0x30, 0xa6, 0x5a, 0xca, 0x8a, 0x22, 0xfa, 0x86, 0x00]
const BRANCH = 0x0586c5 // LDA $5A; BNE +6 (bank_05.asm:783-784)
const CALL_SITE = 0x0586cf // JSR LevLoadNrmObj (bank_05.asm:788)
export const STUB = 0x0d8800 // a dispatch target that is not the handler

/** A stand-in for ExecutePtrLong: the interpreter recognizes its hash and models the effect. */
export const STAND_IN = Array.from({ length: 36 }, (_, i) => (i * 37 + 11) & 0xff)
export const STAND_IN_PRIMITIVES: readonly RecognizedPrimitive[] = [
  {
    sha256: fingerprint(Uint8Array.from(STAND_IN))!,
    length: STAND_IN.length,
  },
]

export const loaderBytes = (operand = [lo(ENTRY), hi(ENTRY), 0x0d]): number[] => [0xe2, 0x30, 0x22, ...operand, 0x60] // prettier-ignore
export const STOCK_PINS = {
  branch: [0xa5, 0x5a, 0xd0, 0x06],
  call: [0x20, lo(LOADER), hi(LOADER)],
  loader: loaderBytes(),
}

export interface ProductionCartOptions {
  to?: number
  bank?: number
  variantBank?: number
  loader?: number[]
  branch?: number[]
  call?: number[]
  /** Dispatch first to a hop that dispatches again, to `to`. */
  hop?: boolean
  /** False leaves the three loader sites blank, as a bare cart has them. */
  pins?: boolean
}

/** Object $12 reaches `handler` at $0DADEB as pipe variant 5, entered as the loader enters it. */
export function productionCart(handler: number[], o: ProductionCartOptions = {}): RomFile {
  const { to = HANDLER, bank = 0x0d, pins = true } = o
  const dispatchTo = (t: number) => [0xa9, 0, 0x22, lo(SIG_AT), hi(SIG_AT), 0x00, lo(t), hi(t), bank] // prettier-ignore
  const table = new Array(STANDARD_HANDLER_COUNT * 3).fill(0)
  table.splice((CLOUD - 1) * 3, 3, lo(PIPES), hi(PIPES), 0x0d)
  const variants = new Array(30).fill(0)
  variants.splice(VARIANT * 3, 3, lo(HANDLER), hi(HANDLER), o.variantBank ?? bank)
  const sites: [number, number[]][] = pins
    ? [[LOADER, o.loader ?? STOCK_PINS.loader], [BRANCH, o.branch ?? STOCK_PINS.branch], [CALL_SITE, o.call ?? STOCK_PINS.call]] // prettier-ignore
    : []
  return cart(
    [],
    [
      [HANDLER, handler],
      [0x0da415, STOCK_TILESET_ENTRY],
      [0x0da106, STOCK_EXTENDED_ENTRY],
      [DISPATCH, STOCK_PREAMBLE],
      [ADDR_TILESET_DISPATCH, [lo(DISPATCH), hi(DISPATCH), 0x0d]],
      [DISPATCH + 10, table],
      [PIPES + 18, variants],
      [ENTRY, [0x4c, lo(STUB_AT), hi(STUB_AT)]], // JMP to the stub
      [STUB_AT, dispatchTo(o.hop ? HOP_AT : to)],
      [SIG_AT, STAND_IN],
      [STUB, [RTL]],
      [HOP_AT, dispatchTo(to)],
      ...sites,
    ],
  )
}
