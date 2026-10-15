/**
 * findSecondaryEntranceForLevel on a synthetic ROM (#860): entrance e arrives in map
 * (e & $100) | DATA_05F800[e] (bank_05.asm:7103-7118, the submap flag is the high byte), and
 * DATA_05FC00 is only the X index (bits 7:5, :7147-7158) and screen (bits 4:0, :7376-7388),
 * never a level high byte.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  DATA_05F800_ADDR,
  DATA_05FC00_ADDR,
  findSecondaryEntranceForLevel,
} from '../../../src/rom/L3Loader'

// A bijection inside each 256 half, so every map in both halves has exactly one entrance.
const lowByte = (e: number) => (e * 7 + 3) & 0xff
const targetOf = (e: number) => (e & 0x100) | lowByte(e)

function build(fc00: (e: number) => number): RomFile {
  const rom = new RomFile('mock.smc', Buffer.alloc(0x400000, 0))
  for (let e = 0; e < 0x200; e++) {
    rom.writeAt(DATA_05F800_ADDR + e, [lowByte(e)])
    rom.writeAt(DATA_05FC00_ADDR + e, [fc00(e) & 0xff])
  }
  return rom
}

const PROBES = [0x000, 0x003, 0x0ff, 0x100, 0x102, 0x1be, 0x1ff]
const expected = (id: number) => {
  for (let e = 0; e < 0x200; e++) if (targetOf(e) === id) return e
  return null
}

describe('findSecondaryEntranceForLevel target map', () => {
  it('ignores every DATA_05FC00 value (all 256, bit 0 set and clear)', () => {
    for (let v = 0; v < 0x100; v++) {
      const rom = build(() => v)
      for (const id of PROBES) {
        expect(findSecondaryEntranceForLevel(rom, id), `fc00=${v} level=${id}`).toBe(expected(id))
      }
    }
  })

  it('ignores a per-entrance FC00 pattern straddling index $100', () => {
    for (const pattern of [(e: number) => e, (e: number) => ~e, (e: number) => (e >> 8) & 1]) {
      const rom = build(pattern)
      for (const id of PROBES) {
        expect(findSecondaryEntranceForLevel(rom, id)).toBe(expected(id))
      }
    }
  })

  it('names the first entrance when two share a target, and null when none does', () => {
    const dup = build(() => 0)
    dup.writeAt(DATA_05F800_ADDR + 0x150, [lowByte(0x120)]) // same target as entrance $120
    expect(findSecondaryEntranceForLevel(dup, targetOf(0x120))).toBe(0x120)
    const gone = build(() => 1)
    gone.writeAt(DATA_05F800_ADDR + 0x100, [lowByte(0x101)]) // nothing targets $100|lowByte($100) now
    expect(findSecondaryEntranceForLevel(gone, targetOf(0x100))).toBe(null)
  })
})
