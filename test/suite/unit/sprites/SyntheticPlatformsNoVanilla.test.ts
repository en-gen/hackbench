/**
 * The synthetic $E0 platform cart carries no vanilla routine (the $E0 issue, same rule as SyntheticEeriesNoVanilla):
 * every byte the fixture adds, in the ASSEMBLED cart, is checked against the vanilla ROM. No 8-byte window with at
 * least 3 distinct values may occur in it. Gated on the vanilla ROM; proven able to fail below on a planted copy.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'
import { platformCart } from '../../support/syntheticPlatforms'

const WINDOW = 8
/** The vanilla $E0 loader route (bank_02.asm:5325-5331) is the span the planted copy lifts, at the same place the cart writes its own. */
const ROUTE_AT = 0x02a89c

/** File offsets of the bytes that differ between the platform cart and the plain synthetic cart, as regions (gaps under 16 merged). */
function addedRegions(cart: Uint8Array): [number, number][] {
  const off = buildSyntheticRom({ eeries: {} }).buffer
  const out: [number, number][] = []
  for (let i = 0; i < cart.length; i++) {
    if (cart[i] === off[i]) continue
    const last = out.at(-1)
    if (last && i - last[1] < 16) last[1] = i + 1
    else out.push([i, i + 1])
  }
  return out
}

/** File offsets of every `WINDOW`-byte window in the regions with 3 or more distinct values that occurs in `vanilla`. */
function copied(bytes: Uint8Array, regions: [number, number][], vanilla: Buffer): number[] {
  const hits: number[] = []
  // Each region is widened by WINDOW-1 bytes each side, so a window that straddles an added byte and a neighbour is read too.
  for (const [r0, r1] of regions) {
    const [from, to] = [Math.max(0, r0 - (WINDOW - 1)), Math.min(bytes.length, r1 + WINDOW - 1)]
    for (let i = from; i + WINDOW <= to; i++) {
      const w = bytes.subarray(i, i + WINDOW)
      if (new Set(w).size >= 3 && vanilla.indexOf(w) >= 0) hits.push(i)
    }
  }
  return hits
}

const vanillaBytes = (rom: RomFile): Buffer =>
  Buffer.from(rom.buffer.subarray(rom.hasHeader ? 512 : 0))
/** File offset of a bank-2 SNES address in the headerless LoROM. */
const fileOff = (snes: number) => ((snes >> 16) << 15) | (snes & 0x7fff)

describe.skipIf(!hasRom(VANILLA))('the synthetic platform cart against the vanilla ROM', () => {
  it('adds no 8-byte window that occurs in the vanilla ROM, in any routine or table it writes', () => {
    const cart = platformCart().buffer
    const regions = addedRegions(cart)
    expect(regions.length, 'the fixture adds something').toBeGreaterThan(3)
    const hits = copied(cart, regions, vanillaBytes(freshRom()))
    expect(
      hits.map(h => h.toString(16)),
      'offending file offsets',
    ).toEqual([])
  })

  it('goes red on a planted copy: the vanilla loader route, lifted from the ROM at runtime, is reported', () => {
    const vanilla = vanillaBytes(freshRom())
    const cart = Uint8Array.from(platformCart().buffer)
    const at = fileOff(ROUTE_AT)
    cart.set(vanilla.subarray(at, at + 12), at)
    // Bytes the cart already shares with the vanilla route are not "added", so the region starts inside the span.
    const hits = copied(cart, addedRegions(cart), vanilla)
    expect(hits.length, 'the planted span is found').toBeGreaterThan(0)
    expect(hits.every(h => h > at - WINDOW && h < at + 12)).toBe(true)
  })
})
