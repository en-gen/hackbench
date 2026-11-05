/**
 * The synthetic line-guided grinder routines carry no vanilla byte run (#792, docs/testing.md Legal position): the
 * ASSEMBLED cart's regions this PR wrote (the dispatch, its 3-byte tails, the chainsaw prelude, the JSL target and the
 * platform arm) are checked against the vanilla ROM. The 17-byte handler shape and the draw routine predate #792
 * and are outside this scan. No 8-byte window with at least 3 distinct values may occur in it. Gated on the vanilla ROM; the
 * check is proven able to fail on a planted copy.
 */
import { describe, expect, it } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const WINDOW = 8
/** [from, to) file offsets in the LoROM fixture ($01:xxxx is file $xxxx, bank 1 being the second 32K). */
const REGIONS: [number, number][] = [
  [0x9220, 0x9260], // the dispatch block
  [0x9610, 0x9631], // the chainsaw prelude
  [0x94f0, 0x94f4], // the JSL target
  [0x9700, 0x9745], // the platform arm
]
const VARIANTS: SyntheticOptions[] = [
  {},
  { alteredGrinder: true },
  { grinderDrawsOnce: true },
  { grinderDrawsOnPass1: true },
]

/** File offsets in REGIONS of every window of `WINDOW` bytes, 3+ distinct values, found in `vanilla`. */
function copied(bytes: Uint8Array, vanilla: Buffer): number[] {
  const hits: number[] = []
  for (const [from, to] of REGIONS)
    for (let i = from; i + WINDOW <= to; i++) {
      const w = bytes.subarray(i, i + WINDOW)
      if (new Set(w).size >= 3 && vanilla.indexOf(w) >= 0) hits.push(i)
    }
  return hits
}

const vanillaBytes = (rom: RomFile): Buffer =>
  Buffer.from(rom.buffer.subarray(rom.hasHeader ? 512 : 0))

describe.skipIf(!hasRom(VANILLA))('the synthetic grinder cart against the vanilla ROM', () => {
  it('has no 8-byte window of the vanilla ROM in the grinder region, in any variant', () => {
    const vanilla = vanillaBytes(freshRom())
    for (const o of VARIANTS) {
      const cart = buildSyntheticRom(o).buffer
      expect(
        cart.subarray(0x9220, 0x9260).some(b => b !== 0),
        'the region is populated',
      ).toBe(true)
      expect(
        copied(cart, vanilla).map(i => i.toString(16)),
        JSON.stringify(o),
      ).toEqual([])
    }
  })

  it('goes red on a planted copy of vanilla bytes', () => {
    const vanilla = vanillaBytes(freshRom())
    const cart = Uint8Array.from(buildSyntheticRom().buffer)
    let at = 0x10000
    while (new Set(vanilla.subarray(at, at + WINDOW)).size < 3) at++
    cart.set(vanilla.subarray(at, at + WINDOW), 0x9230)
    expect(copied(cart, vanilla)).toContain(0x9230)
  })
})
