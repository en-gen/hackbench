/**
 * Where a map is first entered (#339), on synthetic ROMs: every byte is built
 * here, so no corpus is needed (bank_05.asm:7300-7395, 7103-7161).
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { readLevelStart, startGate } from '../../../src/rom/LevelStart'
import {
  plantLmEntryHook,
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

const F000 = 0x05f000
const F200 = 0x05f200
const F600 = 0x05f600
const F800 = 0x05f800
const FA00 = 0x05fa00
const FC00 = 0x05fc00

function blank(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  plantStockSubmapCode(rom)
  plantOverworldTiles(rom)
  // Position tables: nothing here is vanilla's, so a wrong index reads a visible wrong value.
  rom.writeAt(0x05d730, [0x00, 0x70, 0x90, 0xb0, 0x00, 0x00, 0x00, 0x00])
  rom.writeAt(0x05d740, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  rom.writeAt(0x05d750, [0x00, 0x80, 0x40, 0x20, 0x60, 0x00, 0x00, 0x00])
  rom.writeAt(0x05d758, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
  return rom
}

type Exit = { to: number; via?: number }
/** A room with screen exits: `via` makes it a secondary exit through that DATA_05F800 index. */
function room(rom: RomFile, slot: number, ptr: number, exits: Exit[] = []): void {
  rom.writeAt(ADDR.LEVEL_L1_PTR + slot * 3, [ptr & 0xff, (ptr >> 8) & 0xff, (ptr >> 16) & 0xff])
  const body = exits.length
    ? exits.flatMap(e => (e.via === undefined ? [0x00, 0x01, 0x00, e.to & 0xff] : [0x00, 0x02, 0x00, e.via])) // prettier-ignore
    : [0x42]
  rom.writeAt(ptr, [0, 0, 0, 0, 0, ...body, 0xff])
}
const secondary = (rom: RomFile, index: number, dest: number, y: number, c: number): void => {
  rom.writeAt(F800 + index, [dest & 0xff])
  rom.writeAt(FA00 + index, [y])
  rom.writeAt(FC00 + index, [c])
}
const start = (rom: RomFile, slot: number) =>
  readLevelStart(new SmwRom(rom), slot, SYNTHETIC_FINGERPRINTS)

/** Two entry maps ($001 horizontal, $002 vertical) and sub areas beneath them. */
function world(): RomFile {
  const rom = blank()
  room(rom, 0x001, 0x068000, [{ to: 0xc0, via: 0x10 }, { to: 0xc1 }, { to: 0xc4, via: 0x13 }])
  room(rom, 0x002, 0x069000, [{ to: 0xc2, via: 0x11 }])
  room(rom, 0x0c0, 0x06a000, [{ to: 0xc3, via: 0x12 }])
  room(rom, 0x0c1, 0x06b000)
  room(rom, 0x0c2, 0x06c000)
  room(rom, 0x0c3, 0x06d000)
  room(rom, 0x0c4, 0x06e000)
  room(rom, 0x0d0, 0x06f000) // nothing leads here
  // $001: horizontal. Y index 1 ($70), X index 2 ($40), screen 3.
  rom.writeAt(F000 + 1, [0x01])
  rom.writeAt(F200 + 1, [0x02])
  rom.writeAt(F600 + 1, [0x03])
  // $002: vertical (F600 bit 5). Y index 2 ($90), X index 1 ($80), screen 6.
  rom.writeAt(F000 + 2, [0x02])
  rom.writeAt(F200 + 2, [0x01])
  rom.writeAt(F600 + 2, [0x26])
  // $0C1, a primary-exit target: horizontal, X index 3 ($20), screen 2.
  rom.writeAt(F200 + 0xc1, [0x03])
  rom.writeAt(F600 + 0xc1, [0x02])
  // Secondary entrances. $10 -> $0C0 horizontal: Y index 3, X index 4 ($60), screen 5.
  secondary(rom, 0x10, 0xc0, 0x03, (4 << 5) | 5)
  // $11 -> $0C2 vertical: Y index 1 gives the low byte $70, the screen (4) the high byte; X index 2 ($40).
  rom.writeAt(F600 + 0xc2, [0x20])
  secondary(rom, 0x11, 0xc2, 0x01, (2 << 5) | 4)
  // $12 -> $0C3, two hops down; $13 -> $0C4 one hop down.
  secondary(rom, 0x12, 0xc3, 0x00, 7)
  secondary(rom, 0x13, 0xc4, 0x00, 9)
  return rom
}

describe('readLevelStart (synthetic)', () => {
  it('reads a horizontal entry map from its main entrance', () => {
    expect(start(world(), 0x001)).toEqual({
      ok: true,
      kind: 'main',
      hops: 0,
      screen: 3,
      x: 0x340,
      y: 0x70,
      vertical: false, // prettier-ignore
    })
  })

  it('reads a vertical entry map: the screen is the Y high byte, not X', () => {
    // 6 * 256 + $90 = 1680: the shape of vanilla $109's start.
    expect(start(world(), 0x002)).toEqual({
      ok: true,
      kind: 'main',
      hops: 0,
      screen: 6,
      x: 0x80,
      y: 0x690,
      vertical: true, // prettier-ignore
    })
  })

  it('reads a secondary-only map from the entrance its parent exit indexes, horizontal', () => {
    expect(start(world(), 0x0c0)).toEqual({
      ok: true,
      kind: 'secondary',
      hops: 1,
      screen: 5,
      x: 0x560,
      y: 0xb0,
      vertical: false, // prettier-ignore
    })
  })

  it('reads a secondary-only vertical map: the screen byte becomes Y high', () => {
    expect(start(world(), 0x0c2)).toEqual({
      ok: true,
      kind: 'secondary',
      hops: 1,
      screen: 4,
      x: 0x40,
      y: 0x470,
      vertical: true, // prettier-ignore
    })
  })

  it('counts hops: a map two exits deep reports 2', () => {
    const s = start(world(), 0x0c3)
    expect(s).toMatchObject({ ok: true, kind: 'secondary', hops: 2, screen: 7 })
  })

  it('a primary screen exit enters the destination by its main entrance', () => {
    expect(start(world(), 0x0c1)).toMatchObject({ ok: true, kind: 'main', hops: 1, screen: 2, x: 0x220 }) // prettier-ignore
  })

  it('takes the entrance the fewest hops away when two exits reach a map', () => {
    const rom = world()
    // $0C3 is also reached straight from $002 by entrance $14, one hop.
    room(rom, 0x002, 0x069000, [
      { to: 0xc2, via: 0x11 },
      { to: 0xc3, via: 0x14 },
    ])
    secondary(rom, 0x14, 0xc3, 0x02, 8)
    expect(start(rom, 0x0c3)).toMatchObject({ ok: true, hops: 1, screen: 8, y: 0x90 })
  })

  it('a map nothing leads to is unavailable, with a reason', () => {
    const s = start(world(), 0x0d0)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })

  it('an index whose DATA_05F800 byte names another map is not an entrance here', () => {
    const rom = world()
    rom.writeAt(F800 + 0x10, [0xc4]) // the exit now lands in $0C4, not $0C0
    expect(start(rom, 0x0c0).ok).toBe(false)
  })
})

describe('readLevelStart refuses a replaced entrance loader', () => {
  it('a JSL at $05D8B1 is unavailable even though the tables still read as vanilla-shaped', () => {
    const rom = world()
    expect(start(rom, 0x001).ok).toBe(true) // the same ROM, stock opcode
    plantLmEntryHook(rom)
    const s = start(rom, 0x001)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/\$05D8B1.*\$22.*not the stock BEQ/)
  })

  it('every opcode but BEQ $F0 refuses, for entry maps and sub areas alike', () => {
    for (let op = 0; op < 0x100; op++) {
      const rom = world()
      rom.writeAt(0x05d8b1, [op])
      for (const slot of [0x001, 0x0c0]) {
        expect(start(rom, slot).ok, `opcode $${op.toString(16)} slot ${slot}`).toBe(op === 0xf0)
      }
    }
    expect(startGate(world())).toBeNull()
  })
})
