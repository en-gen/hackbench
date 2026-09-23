/**
 * The refusals an adversarial review found unproven.
 *
 * Each of these gates was correct in the code and had no committed test, so
 * a mutation removing it left the suite green. A gate whose removal nothing
 * notices is not a gate. Every fixture here is built in the test, because
 * CI has no cartridge.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { decompress, encode } from '../../../src/rom/LcLz2'
import { setTilePixel } from '../../../src/rom/GraphicsDecoder'
import { layoutArena, readGfxPointerSites, GFX_FILE_COUNT } from '../../../src/rom/GfxArena'
import {
  buildCart,
  gfxStreams,
  prepareGraphicsFile,
  TABLE_LO,
  DECOMP_ENTRY,
  ROUTINE_AT,
} from '../support/syntheticGfxCart'

describe('the pointer tables must be sized for the file count we write', () => {
  it('refuses tables spaced wider than the count, which would leave a stale tail', () => {
    // 64 slots per table. Writing 50 pointers leaves slots 50..63 aimed at
    // bytes the repack just overwrote, and nothing reports it.
    const routine = prepareGraphicsFile(TABLE_LO, TABLE_LO + 0x40, TABLE_LO + 0x80, DECOMP_ENTRY)
    expect(readGfxPointerSites(buildCart({ routine }).rom)).toBeNull()
  })

  it('refuses tables spaced narrower than the count, which would spill into the next table', () => {
    const routine = prepareGraphicsFile(TABLE_LO, TABLE_LO + 0x20, TABLE_LO + 0x40, DECOMP_ENTRY)
    expect(readGfxPointerSites(buildCart({ routine }).rom)).toBeNull()
  })

  it('accepts the stock spacing, so the check is not simply refusing everything', () => {
    const sites = readGfxPointerSites(buildCart().rom)
    expect(sites).not.toBeNull()
    expect(sites!.hi - sites!.lo).toBe(GFX_FILE_COUNT)
    expect(sites!.bank - sites!.hi).toBe(GFX_FILE_COUNT)
  })
})

describe('an ambiguous routine site is not a site', () => {
  it('refuses when PrepareGraphicsFile matches twice, rather than taking the first', () => {
    const { rom } = buildCart()
    const bytes = Uint8Array.from(rom.buffer)
    // A second, byte-identical copy elsewhere in bank 0. Which one the cart
    // actually calls is unknowable from the bytes, so neither may be used.
    bytes.set(prepareGraphicsFile(), ROUTINE_AT + 0x400)
    expect(readGfxPointerSites(RomFile.fromBytes('twin.sfc', bytes))).toBeNull()
  })
})

describe('aliased files cannot be edited apart', () => {
  /** A cart where file 7 shares file 3's block, as hacks that dedupe do. */
  function aliasedCart() {
    const probe = buildCart()
    const streams = gfxStreams()
    streams[7] = streams[3]!
    return {
      ...buildCart({ streams, outliers: { 7: probe.offsets[3]! } }),
      streams,
    }
  }

  it('lays out an aliased cart when both twins still agree', () => {
    const { rom, streams } = aliasedCart()
    expect(layoutArena(rom, streams).status).toBe('ok')
  })

  it('refuses when an edit reached one twin and not the other', () => {
    const { rom, streams } = aliasedCart()
    // The exact shape that silently lost the edit: file 7's stream differs
    // from file 3's, layoutArena wrote file 3's, and reported success.
    const edited = Uint8Array.from(decompress(streams[7]!, 0))
    edited[edited.length >> 1] ^= 0xff
    const diverged = streams.slice()
    diverged[7] = encode(edited, streams[7]!)

    const result = layoutArena(rom, diverged)
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).toContain('share one block')
    expect(result.reason).toContain('7')
  })
})

describe('a pixel coordinate must be a whole number', () => {
  const tile = (): Uint8Array => new Uint8Array(32)

  it('refuses a fractional y, which would write two plane rows from one call', () => {
    expect(() => setTilePixel(tile(), 0, 4, 0, 0.5, 7)).toThrow(/outside an 8x8 tile/)
  })

  it('refuses a fractional x, which would shift the mask off the named pixel', () => {
    expect(() => setTilePixel(tile(), 0, 4, 1.5, 0, 7)).toThrow(/outside an 8x8 tile/)
  })

  it('still accepts every whole coordinate, so the check is not refusing everything', () => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(() => setTilePixel(tile(), 0, 4, x, y, 1)).not.toThrow()
      }
    }
  })
})
