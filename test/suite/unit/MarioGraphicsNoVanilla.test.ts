/**
 * The #980 fixtures and detection pattern carry no vanilla bytes (BA safety rule 2026-10-17). Every synthetic cart the
 * branch's tests assemble, is checked against the vanilla ROM: no 8-byte window with at
 * least 3 distinct values (an all-equal fill is padding, not code) may occur in it. Checked on the ASSEMBLED bytes, so a
 * run split across array literals is found. Gated on the vanilla ROM; the scanner is proven able to fail on a planted copy.
 */
import { describe, expect, it } from 'vitest'
import { STOCK_BOOT, STOCK_DMA } from '../../../src/rom/MarioGraphics'
import { freshRom, hasRom, VANILLA } from '../support/corpus'
import {
  bankCarryCart,
  cart,
  dmaCode,
  highBankCart,
  seq,
  type Cart,
} from '../support/marioGraphicsFixture'

const W = 8
const distinct = (w: Uint8Array) => new Set(w).size >= 3
const key = (w: Uint8Array) => Buffer.from(w).toString('latin1')

/** File offsets of `bytes` windows that also occur in the vanilla windows. */
function shared(bytes: Uint8Array, vanilla: Set<string>): number[] {
  const hits: number[] = []
  for (let i = 0; i + W <= bytes.length; i++) {
    const w = bytes.subarray(i, i + W)
    if (distinct(w) && vanilla.has(key(w))) hits.push(i)
  }
  return hits
}

/** Every distinct 8-byte window of the vanilla ROM, headerless. */
function vanillaWindows(): { set: Set<string>; bytes: Uint8Array } {
  const rom = freshRom()
  const bytes = rom.buffer.subarray(rom.hasHeader ? 512 : 0)
  const set = new Set<string>()
  for (let i = 0; i + W <= bytes.length; i++) set.add(key(bytes.subarray(i, i + W)))
  return { set, bytes }
}

/** The carts the MarioGraphics tests build, one per shape: default, another bank and offset, oversized, odd operands. */
const CARTS: Cart[] = [
  {},
  { d33: seq(1, 72), bank: 9, low: 0x9000, top: 0x207e, srcTop: 71 },
  { d33: Array(0x9100).fill(7) },
  { d32: Array(0x9100).fill(7) },
  { copies: 2 },
  { top: 0xb000 },
  { edit: c => { c[40] = 0x60 } }, // prettier-ignore
]

/** Byte arrays other tests feed in directly (expansion buffers, the player buffer). */
function loose(): Uint8Array[] {
  const tiles = new Uint8Array(0xb000 - 0x2000)
  for (let t = 0; t < tiles.length / 32; t++) tiles.fill((t % 255) + 1, t * 32, t * 32 + 32)
  return [
    Uint8Array.from(seq(1, 48)),
    Uint8Array.from(seq(1, 24 * 3)),
    tiles,
    Uint8Array.from(dmaCode()),
  ]
}

describe.skipIf(!hasRom(VANILLA))('MarioGraphics fixtures against the vanilla ROM (#980)', () => {
  it('assembles no 8-byte window that occurs in the vanilla ROM', () => {
    const { set } = vanillaWindows()
    const carts = [...CARTS.map(cart), bankCarryCart(), highBankCart()]
    const hits = carts.map(c => shared(c.buffer, set).length)
    expect(hits, 'windows per cart').toEqual(carts.map(() => 0))
    expect(loose().map(b => shared(b, set).length)).toEqual(loose().map(() => 0))
  })

  it('stores no routine bytes: the stock records are a length and a hash', () => {
    expect(Object.keys(STOCK_BOOT).sort()).toEqual(['at', 'length', 'sha256'])
    expect(Object.keys(STOCK_DMA).sort()).toEqual(['at', 'length', 'sha256'])
  })

  it('goes red on a planted copy: 8 bytes read from the vanilla ROM at run time are reported at their offset', () => {
    const { set, bytes } = vanillaWindows()
    let at = 0x10000
    while (new Set(bytes.subarray(at, at + W)).size < 3) at++
    const planted = Uint8Array.from(cart({}).buffer)
    planted.set(bytes.subarray(at, at + W), 0x4000)
    expect(shared(planted, set)).toContain(0x4000)
    expect(shared(cart({}).buffer, set)).not.toContain(0x4000)
  })
})
