/**
 * The synthetic five-Eerie cart carries no vanilla routine (#1015): every byte the fixture adds, in the ASSEMBLED
 * cart (not the source text a text probe reads), is checked against the vanilla ROM. No 8-byte window with at least
 * 3 distinct values may occur in it, so a copied instruction idiom of any length from 8 up is found at its offset.
 * Gated on the vanilla ROM; the check itself is proven able to fail below on a planted copy.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const WINDOW = 8

/** File offsets of the bytes that differ between the cart with the fixture and the cart without it, as regions (gaps under 16 merged). */
function addedRegions(): [number, number][] {
  const [on, off] = [
    buildSyntheticRom({ eeries: { travel: true } }).buffer,
    buildSyntheticRom().buffer,
  ]
  const out: [number, number][] = []
  for (let i = 0; i < on.length; i++) {
    if (on[i] === off[i]) continue
    const last = out.at(-1)
    if (last && i - last[1] < 16) last[1] = i + 1
    else out.push([i, i + 1])
  }
  // Widened by WINDOW - 1 each side: a window that overlaps an added byte by one byte is still a window of the cart.
  return out.map(([from, to]) => [
    Math.max(0, from - (WINDOW - 1)),
    Math.min(off.length, to + (WINDOW - 1)),
  ])
}

/** SNES address of a file offset in the fixture's LoROM. */
const snes = (off: number) =>
  `$${(off >> 15).toString(16).padStart(2, '0')}:${(0x8000 | (off & 0x7fff)).toString(16).toUpperCase().padStart(4, '0')}`

/** Every window of `WINDOW` bytes in `bytes[from, to)` with 3 or more distinct values that occurs in `vanilla`: file offsets. */
function copied(bytes: Uint8Array, regions: [number, number][], vanilla: Buffer): number[] {
  const hits: number[] = []
  for (const [from, to] of regions)
    for (let i = from; i + WINDOW <= to; i++) {
      const w = bytes.subarray(i, i + WINDOW)
      if (new Set(w).size >= 3 && vanilla.indexOf(w) >= 0) hits.push(i)
    }
  return hits
}

const vanillaBytes = (rom: RomFile): Buffer =>
  Buffer.from(rom.buffer.subarray(rom.hasHeader ? 512 : 0))

describe.skipIf(!hasRom(VANILLA))('the synthetic Eerie cart against the vanilla ROM', () => {
  it('adds no 8-byte window that occurs in the vanilla ROM, in any routine or table it writes', () => {
    const cart = buildSyntheticRom({ eeries: { travel: true } }).buffer
    const regions = addedRegions()
    expect(regions.length, 'the fixture adds something').toBeGreaterThan(3)
    const hits = copied(cart, regions, vanillaBytes(freshRom()))
    expect(hits.map(snes), 'offending offsets').toEqual([])
  })

  it('goes red on a planted copy: a window lifted from the vanilla ROM is reported at its offset', () => {
    const vanilla = vanillaBytes(freshRom())
    const cart = Uint8Array.from(buildSyntheticRom({ eeries: { travel: true } }).buffer)
    const regions = addedRegions()
    // Plant 8 vanilla bytes (the first window with 3 distinct values from a code-dense stretch) into the first region.
    let at = 0x10000
    while (new Set(vanilla.subarray(at, at + WINDOW)).size < 3) at++
    const [target] = regions.filter(([from, to]) => to - from >= WINDOW)
    cart.set(vanilla.subarray(at, at + WINDOW), target![0])
    expect(copied(cart, regions, vanilla)).toContain(target![0])
  })
})
