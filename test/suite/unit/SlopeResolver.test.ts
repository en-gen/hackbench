/**
 * SlopeResolver — port of `CODE_00ED86`'s slope-angle dispatch
 * (bank_00.asm:12334).
 *
 * Tests verify the resolver uses the right SlopesPtr target per
 * tileset, that out-of-range low bytes return null, and that the
 * returned 16-byte heights array matches the ROM's `DATA_00E632`
 * lookup for a known slope index.
 */

import { describe, expect, it } from 'vitest'
import {
  DATA_E55E_LEN,
  DATA_E5C8_LEN,
  DATA_E632_LEN,
  resolveSlope,
  type SlopeTables,
} from '../../../src/rom/SlopeResolver'

/**
 * Vanilla SMW `DATA_00E55E` (bank_00.asm:11572-11586) — default
 * per-tile slope-index map. 106 bytes covering low $6E..$D7.
 */
const VANILLA_E55E = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x01,
  0x01, 0x01, 0x01, 0x02, 0x02, 0x02, 0x02, 0x02,
  0x03, 0x03, 0x03, 0x03, 0x03, 0x04, 0x04, 0x04,
  0x04, 0x04, 0x05, 0x05, 0x05, 0x05, 0x05, 0x06,
  0x06, 0x06, 0x06, 0x06, 0x07, 0x07, 0x07, 0x07,
  0x07, 0x08, 0x08, 0x08, 0x08, 0x08, 0x09, 0x09,
  0x09, 0x09, 0x09, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A,
  0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0C, 0x0C, 0x0C,
  0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D, 0x0D, 0x0E,
  0x0F, 0x10, 0x11, 0x03, 0x03, 0x04, 0x04, 0x09,
  0x09, 0x0A, 0x0A, 0x0C, 0x0C, 0x0D, 0x0D, 0x12,
  0x13, 0x14, 0x15, 0x16, 0x17, 0x1C, 0x1D, 0x1E,
  0x1F, 0x18, 0x19, 0x1A, 0x1B, 0x08, 0x09, 0x0A,
  0x0B, 0x0C, 0x0D,
])

/**
 * Vanilla SMW `DATA_00E5C8` (bank_00.asm:11588-11602) — overworld /
 * cave per-tile slope-index map. Same 106-byte shape. Diverges from
 * `DATA_00E55E` in specific low-byte positions (e.g. entries 80-84).
 */
const VANILLA_E5C8 = new Uint8Array([
  0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x01, 0x01, 0x01, 0x01, 0x02, 0x02, 0x02,
  0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x03, 0x04,
  0x04, 0x04, 0x04, 0x04, 0x05, 0x05, 0x05, 0x05,
  0x05, 0x06, 0x06, 0x06, 0x06, 0x06, 0x07, 0x07,
  0x07, 0x07, 0x07, 0x08, 0x08, 0x08, 0x08, 0x08,
  0x09, 0x09, 0x09, 0x09, 0x09, 0x0A, 0x0A, 0x0A,
  0x0A, 0x0A, 0x0B, 0x0B, 0x0B, 0x0B, 0x0B, 0x0C,
  0x0C, 0x0C, 0x0C, 0x0C, 0x0D, 0x0D, 0x0D, 0x0D,
  0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x03, 0x03, 0x04,
  0x04, 0x09, 0x09, 0x0A, 0x0A, 0x0C, 0x0C, 0x0D,
  0x0D, 0x0C, 0x0D, 0x0D, 0x0C, 0x16, 0x17, 0x1C,
  0x1D, 0x1E, 0x1F, 0x18, 0x19, 0x1A, 0x1B, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D,
])

/**
 * Vanilla SMW `DATA_00E632` (bank_00.asm:11604) — slope-height LUT.
 * Only slope index 0 is asserted here; that's the value both vanilla
 * maps return for low byte $6E. Full 510-byte table is what the ROM
 * ships; the resolver doesn't care about other indices for this test
 * suite.
 */
const SLOPE_0_HEIGHTS = new Uint8Array([
  0x0F, 0x0F, 0x0F, 0x0F, 0x0E, 0x0E, 0x0E, 0x0E,
  0x0D, 0x0D, 0x0D, 0x0D, 0x0C, 0x0C, 0x0C, 0x0C,
])

function makeHeightTable(): Uint8Array {
  const table = new Uint8Array(DATA_E632_LEN)
  table.set(SLOPE_0_HEIGHTS, 0)
  // Fill slope index 1 with a recognisable pattern so the resolver's
  // index math is verifiable by inspecting the returned slice.
  for (let i = 0; i < 16; i++) table[16 + i] = 0x80 | i
  return table
}

const VANILLA_TABLES: SlopeTables = {
  heightTable:       makeHeightTable(),
  indexMapDefault:   VANILLA_E55E,
  indexMapOverworld: VANILLA_E5C8,
}

describe('resolveSlope — range guards', () => {
  it('low < $6E returns null (below CODE_00ED86 guard)', () => {
    expect(resolveSlope(0x00, 1, VANILLA_TABLES)).toBeNull()
    expect(resolveSlope(0x6D, 1, VANILLA_TABLES)).toBeNull()
  })

  it('low > $D7 returns null (above CODE_00ED86 guard)', () => {
    expect(resolveSlope(0xD8, 1, VANILLA_TABLES)).toBeNull()
    expect(resolveSlope(0xFA, 1, VANILLA_TABLES)).toBeNull()
    expect(resolveSlope(0xFF, 1, VANILLA_TABLES)).toBeNull()
  })

  it('high byte is ignored — membership is on low byte only', () => {
    // Matches CODE_00ED86 which reads Map16TileNumber (8-bit).
    const fromLow  = resolveSlope(0x71, 1, VANILLA_TABLES)
    const fromHigh = resolveSlope(0x171, 1, VANILLA_TABLES)
    expect(fromLow?.slopeIndex).toBe(fromHigh?.slopeIndex)
  })
})

describe('resolveSlope — tileset selection', () => {
  // The only vanilla divergence between E55E and E5C8 sits in four
  // adjacent entries at low bytes $C4..$C7 (indices $56..$59):
  //   low $C4: E55E=$12, E5C8=$0C
  //   low $C5: E55E=$13, E5C8=$0D
  //   low $C6: E55E=$14, E5C8=$0D
  //   low $C7: E55E=$15, E5C8=$0C
  // Every other index is identical. Tests that use these four low
  // bytes prove which pointer target the resolver selected.

  it('tileset != 0 && != 7 uses DATA_00E55E (default map)', () => {
    expect(resolveSlope(0xC4, 1, VANILLA_TABLES)?.slopeIndex).toBe(0x12)
    expect(resolveSlope(0xC4, 2, VANILLA_TABLES)?.slopeIndex).toBe(0x12)
    expect(resolveSlope(0xC4, 8, VANILLA_TABLES)?.slopeIndex).toBe(0x12)
    expect(resolveSlope(0xC4, 0x0F, VANILLA_TABLES)?.slopeIndex).toBe(0x12)
    expect(resolveSlope(0xC5, 1, VANILLA_TABLES)?.slopeIndex).toBe(0x13)
  })

  it('tileset == 0 uses DATA_00E5C8 (overworld map)', () => {
    expect(resolveSlope(0xC4, 0, VANILLA_TABLES)?.slopeIndex).toBe(0x0C)
    expect(resolveSlope(0xC5, 0, VANILLA_TABLES)?.slopeIndex).toBe(0x0D)
    expect(resolveSlope(0xC7, 0, VANILLA_TABLES)?.slopeIndex).toBe(0x0C)
  })

  it('tileset == 7 also uses DATA_00E5C8 (CODE_058281 branch)', () => {
    expect(resolveSlope(0xC4, 7, VANILLA_TABLES)?.slopeIndex).toBe(0x0C)
    expect(resolveSlope(0xC6, 7, VANILLA_TABLES)?.slopeIndex).toBe(0x0D)
  })

  it('first slope entry (low $6E) maps to slope 0 in both tables', () => {
    // Vanilla: both DATA_00E55E[0] and DATA_00E5C8[0] are $00.
    expect(resolveSlope(0x6E, 1, VANILLA_TABLES)?.slopeIndex).toBe(0)
    expect(resolveSlope(0x6E, 0, VANILLA_TABLES)?.slopeIndex).toBe(0)
    expect(resolveSlope(0x6E, 7, VANILLA_TABLES)?.slopeIndex).toBe(0)
  })
})

describe('resolveSlope — returned heights', () => {
  it('heights are 16 bytes matching DATA_00E632[slopeIndex*16..+16]', () => {
    const slope = resolveSlope(0x6E, 1, VANILLA_TABLES)  // slope 0
    expect(slope).not.toBeNull()
    expect(slope!.heights.length).toBe(16)
    expect(Array.from(slope!.heights)).toEqual(Array.from(SLOPE_0_HEIGHTS))
  })

  it('heights slice advances by 16 for the next slope index', () => {
    // Pick a low byte that maps to slope 1 — DATA_00E55E[$73-$6E] = $01.
    const slope = resolveSlope(0x73, 1, VANILLA_TABLES)
    expect(slope?.slopeIndex).toBe(1)
    // Our synthetic heightTable fills slope 1 with $80 | px.
    expect(Array.from(slope!.heights)).toEqual([
      0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8A, 0x8B, 0x8C, 0x8D, 0x8E, 0x8F,
    ])
  })

  it('table length constants match the vanilla ROM sizes', () => {
    expect(DATA_E632_LEN).toBe(510)
    expect(DATA_E55E_LEN).toBe(106)
    expect(DATA_E5C8_LEN).toBe(106)
    expect(VANILLA_E55E.length).toBe(DATA_E55E_LEN)
    expect(VANILLA_E5C8.length).toBe(DATA_E5C8_LEN)
  })
})
