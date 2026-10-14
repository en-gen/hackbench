/**
 * Where a map is first entered (#339), on synthetic ROMs: every byte is built
 * here, so no corpus is needed (bank_05.asm:7300-7395, 7103-7161).
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { WorkingRom } from '../../../src/project/WorkingRom'
import {
  readLevelStart,
  startGate,
  START_EXIT_SPAN,
  START_MAIN_SPAN,
} from '../../../src/rom/LevelStart'
import { SCREEN_EXIT } from '../../../src/rom/SubmapFlagGate'
import {
  plantLmEntryHook,
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

// The sweep reuses one overworld derivation (570 ms a call under coverage) and records the ranges it
// read (readByte goes through readAt), so the sweep can prove it never reads a withheld byte.
const memo = vi.hoisted(() => ({ on: false, hit: undefined as unknown, reads: [] as number[][] }))
vi.mock('../../../src/rom/OverworldEntrances', async orig => {
  const m = await orig<typeof import('../../../src/rom/OverworldEntrances')>()
  const derive: typeof m.deriveOverworldEntrances = (sm, ...rest) => {
    if (!memo.on) return m.deriveOverworldEntrances(sm, ...rest)
    const f = sm.rom
    const readAt = f.readAt
    f.readAt = (a, n) => (memo.reads.push([a, n]), readAt.call(f, a, n))
    try {
      memo.hit ??= m.deriveOverworldEntrances(sm, ...rest)
    } finally {
      f.readAt = readAt
    }
    return memo.hit as ReturnType<typeof derive>
  }
  return { ...m, deriveOverworldEntrances: derive }
})

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
  // Every slot starts as the filler room, as on a real ROM; a test claims the slots it uses.
  for (let i = 0; i < 0x200; i++) rom.writeAt(ADDR.LEVEL_L1_PTR + i * 3, [0x00, 0xf0, 0x07])
  rom.writeAt(0x07f000, [0, 0, 0, 0, 0, 0xff])
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
  // One screen-exit flag per map (the last exit object's; bank_0D.asm:1436-1438), so a map's exits are all
  // primary or all secondary: $001 and $002 use secondary entrances, $003 the primary exit into $0C1.
  room(rom, 0x001, 0x068000, [
    { to: 0xc0, via: 0x10 },
    { to: 0xc4, via: 0x13 },
  ])
  room(rom, 0x003, 0x06a400, [{ to: 0xc1 }])
  room(rom, 0x002, 0x069000, [{ to: 0xc2, via: 0x11 }])
  room(rom, 0x0c0, 0x06a000, [{ to: 0xc3, via: 0x12 }])
  room(rom, 0x0c1, 0x06b000)
  room(rom, 0x0c2, 0x06c000)
  room(rom, 0x0c3, 0x06d000)
  room(rom, 0x0c4, 0x06e000)
  room(rom, 0x0d0, 0x06f000) // nothing leads here
  // $001: horizontal. Y index 1 ($70), X index 2 ($40), screen 3.
  rom.writeAt(F000 + 1, [0xf1]) // high nibble is not the index
  rom.writeAt(F200 + 1, [0xfa]) // bits 3-7 are the entrance type, not the index
  rom.writeAt(F600 + 1, [0x03])
  // $002: vertical (F600 bit 5). Y index 2 ($90), X index 1 ($80), screen 6.
  rom.writeAt(F000 + 2, [0x02])
  rom.writeAt(F200 + 2, [0x01])
  rom.writeAt(F600 + 2, [0x26])
  // $0C1, a primary-exit target: horizontal, X index 3 ($20), screen 2.
  rom.writeAt(F200 + 0xc1, [0x03])
  rom.writeAt(F600 + 0xc1, [0x02])
  // Secondary entrances. $10 -> $0C0 horizontal: Y index 3, X index 4 ($60), screen 5.
  secondary(rom, 0x10, 0xc0, 0xf3, (3 << 5) | 5) // odd X index; high bits of the Y byte are flags
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
      x: 0x520,
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

  it('a nearer parent wins even when its slot number is the higher one', () => {
    const rom = world()
    // $0C3 via $0C0 -> $030 (3 hops, $030 the lower slot) or via $0C5 (2 hops, the higher slot).
    room(rom, 0x001, 0x068000, [{ to: 0xc0, via: 0x10 }, { to: 0xc5 }])
    room(rom, 0x0c0, 0x06a000, [{ to: 0x30 }])
    room(rom, 0x030, 0x06a800, [{ to: 0xc3, via: 0x15 }])
    room(rom, 0x0c5, 0x06a900, [{ to: 0xc3, via: 0x14 }])
    secondary(rom, 0x15, 0xc3, 0x00, 7)
    secondary(rom, 0x14, 0xc3, 0x02, 8)
    expect(start(rom, 0x0c3)).toMatchObject({ ok: true, hops: 2, screen: 8 })
  })

  it('at equal hops the lower parent slot wins, whatever its entrance index', () => {
    const rom = world()
    room(rom, 0x001, 0x068000, [
      { to: 0xc0, via: 0x10 },
      { to: 0xc5, via: 0x17 },
    ])
    secondary(rom, 0x17, 0xc5, 0x00, 0)
    room(rom, 0x0c0, 0x06a000, [{ to: 0xc3, via: 0x15 }])
    room(rom, 0x0c5, 0x06a900, [{ to: 0xc3, via: 0x14 }])
    secondary(rom, 0x15, 0xc3, 0x00, 7) // from the lower parent, the higher index
    secondary(rom, 0x14, 0xc3, 0x02, 8)
    expect(start(rom, 0x0c3)).toMatchObject({ ok: true, hops: 2, screen: 7 })
  })

  it('a submap exit enters the destination with the submap flag as bit 8 of the index', () => {
    const rom = world()
    room(rom, 0x101, 0x078000, [{ to: 0x1c0, via: 0x10 }])
    room(rom, 0x1c0, 0x078800)
    secondary(rom, 0x110, 0xc0, 0x00, 0x0a)
    secondary(rom, 0x010, 0xc4, 0x00, 0x0b) // the main-map index $10, which names another map
    expect(start(rom, 0x1c0)).toMatchObject({ ok: true, kind: 'secondary', screen: 0x0a })
  })

  it('a slot that holds the filler room is unavailable, even where tables look populated', () => {
    const rom = world() // $012 is an entry-map slot with no room of its own
    rom.writeAt(F600 + 0x12, [0x05])
    const s = start(rom, 0x012)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No map is stored/)
  })

  it('a slot number outside the pointer table does not exist', () => {
    for (const bad of [-1, 0x200, 1.5, NaN]) {
      const s = start(world(), bad)
      expect(!s.ok && s.reason, String(bad)).toMatch(/does not exist/)
    }
  })

  it('a map nothing leads to is unavailable, with a reason', () => {
    const s = start(world(), 0x0d0)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })

  it('an exit read from a parent stream that never reaches $FF is not an entrance', () => {
    const rom = world()
    room(rom, 0x0c5, 0x06e800)
    rom.writeAt(F200 + 0xc5, [0x03])
    // $002's stream now holds one primary exit to $0C5 and no $FF: the parse runs off the buffer (terminated false).
    // Free space, all zero after the exit, so no $FF turns up inside the 0x2000-byte read.
    rom.writeAt(0x06f100, [0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0xc5])
    rom.writeAt(ADDR.LEVEL_L1_PTR + 0x002 * 3, [0x00, 0xf1, 0x06])
    const s = start(rom, 0x0c5)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })

  it('an unterminated parent does not make its destination a reachable stepping stone', () => {
    const rom = world()
    room(rom, 0x0c5, 0x06e800, [{ to: 0xc6 }])
    room(rom, 0x0c6, 0x06e900)
    rom.writeAt(F200 + 0xc6, [0x03])
    // Same unterminated $002 as above: its only edge is to $0C5, whose own exit to $0C6 is well formed.
    rom.writeAt(0x06f100, [0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0xc5])
    rom.writeAt(ADDR.LEVEL_L1_PTR + 0x002 * 3, [0x00, 0xf1, 0x06])
    const s = start(rom, 0x0c6)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })

  it('an unterminated parent deeper than the roots is not a stepping stone either', () => {
    const rom = world()
    // $001 (an overworld level) -> $0C5 (well formed) -> $0C6 (never reaches $FF) -> $0C7 -> $0C8.
    room(rom, 0x001, 0x068000, [{ to: 0xc5 }])
    room(rom, 0x0c5, 0x06e800, [{ to: 0xc6 }])
    room(rom, 0x0c7, 0x06ea00, [{ to: 0xc8 }])
    room(rom, 0x0c8, 0x06eb00)
    rom.writeAt(F200 + 0xc8, [0x03])
    rom.writeAt(0x06f100, [0, 0, 0, 0, 0, 0x00, 0x01, 0x00, 0xc7])
    rom.writeAt(ADDR.LEVEL_L1_PTR + 0x0c6 * 3, [0x00, 0xf1, 0x06])
    const s = start(rom, 0x0c8)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toMatch(/No overworld tile or screen exit/)
  })

  it('an exit whose destination byte is $FF is followed: the game reads that byte unchecked', () => {
    // [00 01 00 FF] FF: the $FF at the destination position is data, the next $FF terminates
    // (CODE_0DA512, bank_0D.asm:1417-1419; $FF is tested only at an object start, bank_05.asm:792-795).
    const rom = world()
    room(rom, 0x001, 0x068000, [{ to: 0xff }])
    room(rom, 0x0ff, 0x06ec00)
    rom.writeAt(F200 + 0xff, [0x03])
    rom.writeAt(F600 + 0xff, [0x02])
    const s = start(rom, 0x0ff)
    expect(s.ok).toBe(true)
    expect(s.ok && s.hops).toBe(1)
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
    expect(!s.ok && s.reason).toMatch(/replaces the game's map entrance code/)
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

describe('readLevelStart refuses changed entrance code, in plain words', () => {
  const plain = (s: ReturnType<typeof start>) => {
    expect(s.ok).toBe(false)
    if (s.ok) return
    expect(s.reason).not.toMatch(/\$[0-9A-Fa-f]{4,6}/)
    expect(s.reason).not.toMatch(/\.asm|bank_/)
    expect(s.detail).toMatch(/\$05[0-9A-F]{4}/) // the evidence stays, off the UI path
  }

  it('a screen-exit mismatch with $05D8B1 stock reads as plain words', () => {
    const rom = world()
    rom.writeAt(SCREEN_EXIT[1]!.addr, [0xad]) // LDA OWPlayerSubmap,Y -> $AD
    expect(rom.readByte(0x05d8b1)).toBe(0xf0)
    plain(start(rom, 0x0c0)) // an entry map never uses the exit code, so only a sub area is refused
    expect(start(rom, 0x001).ok).toBe(true)
  })

  it('one flipped byte in the secondary-exit span, or the main-entrance span, is unavailable', () => {
    for (const span of [START_EXIT_SPAN, START_MAIN_SPAN]) {
      for (const at of [0, span.length >> 1, span.length - 1]) {
        const rom = world()
        const addr = span.addr + at
        rom.writeAt(addr, [rom.readByte(addr)! ^ 0x01])
        plain(start(rom, 0x001))
        plain(start(rom, 0x0c0))
      }
    }
    expect(start(world(), 0x001).ok).toBe(true)
  })
})

describe('readLevelStart: the screen mask and the span bounds', () => {
  it('a flipped screen mask ($05D9F1, the AND #$1F operand) is unavailable, not a wrong screen', () => {
    const rom = world()
    expect(rom.readByte(0x05d9f1)).toBe(0x1f)
    expect(start(rom, 0x001).ok).toBe(true)
    rom.writeAt(0x05d9f1, [0x3f])
    expect(start(rom, 0x001).ok).toBe(false)
    expect(start(rom, 0x0c0).ok).toBe(false)
  })

  it('the spans start and end where the cited instructions do, on a test-built layout', () => {
    // Literal addresses, not the constants: moving a span or changing a length goes red here, no corpus.
    const rom = world()
    expect(START_EXIT_SPAN.addr).toBe(0x05d7d4) // LDA UseSecondaryExit, bank_05.asm:7111: 14 bytes before 7117
    expect(START_EXIT_SPAN.addr + 14).toBe(0x05d7e2) // LDA DATA_05F800,Y (7117)
    expect([...rom.readAt(0x05d7e2, 3)!]).toEqual([0xb9, 0x00, 0xf8])
    expect(START_EXIT_SPAN.addr + START_EXIT_SPAN.length).toBe(0x05d83b) // the JMP at 7162
    expect(START_MAIN_SPAN.addr).toBe(0x05d938) // LDA DATA_05F600,Y (7289)
    expect([...rom.readAt(0x05d938, 3)!]).toEqual([0xb9, 0x00, 0xf6])
    expect([...rom.readAt(0x05d9f0, 2)!]).toEqual([0x29, 0x1f]) // AND #$1F (7377)
    expect(START_MAIN_SPAN.addr + START_MAIN_SPAN.length).toBe(0x05da17) // CODE_05DA17 (7396)
  })
})

describe('readLevelStart when the overworld cannot be read', () => {
  it('gives the fixed plain reason, never the derivation note', () => {
    const rom = world()
    const broken = { ...SYNTHETIC_FINGERPRINTS, entry: ['00'.repeat(32)] }
    const note = deriveOverworldEntrances(new SmwRom(rom), undefined, broken).notes[0]
    expect(note).toMatch(/Overworld not readable/)
    const s = readLevelStart(new SmwRom(rom), 0x001, broken)
    expect(s.ok).toBe(false)
    if (s.ok) return
    expect(s.reason).toBe('The overworld could not be read, so the start position cannot be found.')
    expect(s.reason).not.toBe(note)
    expect(s.detail).toBe(note)
  })
})

describe('readLevelStart follows an edit layer', () => {
  it('a layer that rewrites DATA_05F600 moves the start screen', () => {
    // Through WorkingRom, which is what project-server reads (mapStart); the server itself needs Theia.
    const base = world()
    const working = new WorkingRom(Uint8Array.from(base.buffer), false)
    const at = (b: Uint8Array) => readLevelStart(new SmwRom(new RomFile('w.smc', Buffer.from(b))), 0x001, SYNTHETIC_FINGERPRINTS) // prettier-ignore
    expect(at(working.bytes())).toMatchObject({ ok: true, screen: 3 })
    // The word at $05F601 is F600[$001] (low) and F600[$002] (high, $26 here).
    working.append({
      id: 'L1',
      label: 'move start',
      scope: 'edit',
      ops: [{ address: '$05F601', old: '$2603', new: '$2607' }],
    })
    expect(at(working.bytes())).toMatchObject({ ok: true, screen: 7, x: 0x740 })
  })
})

describe('readLevelStart fails closed when a table byte is past the ROM end', () => {
  const CUT = 'The ROM ends before the level entrance tables, so the start position cannot be read.'
  /** The ROM, but `readByte` has nothing at `addr` (a ROM cut short there). */
  const withheld = (rom: RomFile, addr: number): RomFile => {
    const real = rom.readByte.bind(rom)
    rom.readByte = (a: number) => (a === addr ? null : real(a))
    return rom
  }
  // Slot -> the table bytes its start reads (`must`: withholding one refuses) and the ones the
  // other orientation would read (`never`: withholding one changes nothing). Addresses follow the
  // indexes world() plants: Y_LO $05D730, Y_HI $05D740, X_LO $05D750, X_HI $05D758.
  const reads: [string, number, number[], number[]][] = [
    ['entry map $001 (Y idx 1, X idx 2)', 0x001, [F000 + 1, F200 + 1, F600 + 1, 0x05d731, 0x05d741, 0x05d752], [0x05d75a]],
    ['entry map $002 (vertical, Y idx 2, X idx 1)', 0x002, [F000 + 2, F200 + 2, F600 + 2, 0x05d732, 0x05d751, 0x05d759], [0x05d742]],
    ['secondary $0C0 via $10 (Y idx 3, X idx 3)', 0x0c0, [F800 + 0x10, FA00 + 0x10, FC00 + 0x10, F600 + 0xc0, 0x05d733, 0x05d743, 0x05d753], [0x05d75b]],
    ['secondary $0C2 via $11 (vertical, Y idx 1, X idx 2)', 0x0c2, [F800 + 0x11, FA00 + 0x11, FC00 + 0x11, F600 + 0xc2, 0x05d731, 0x05d752, 0x05d75a], [0x05d741]],
    ['main-entered sub area $0C1 (Y idx 0, X idx 3)', 0x0c1, [F000 + 0xc1, F200 + 0xc1, F600 + 0xc1, 0x05d730, 0x05d740, 0x05d753], [0x05d75b]],
  ] // prettier-ignore

  it('every table byte a start reads: withholding it refuses, in plain words', () => {
    let n = 0
    // One world and one overworld derivation for the whole sweep, not one per byte.
    const rom = world()
    const readByte = rom.readByte
    const at = (addr: number, slot: number) => {
      try {
        return start(withheld(rom, addr), slot)
      } finally {
        rom.readByte = readByte
      }
    }
    memo.on = true
    try {
      start(rom, 0x001)
      const read = (a: number) => memo.reads.some(([t, len]) => a >= t! && a < t! + len!)
      expect(
        reads.flatMap(r => [...r[2], ...r[3]]).filter(read),
        'the shared derivation read a swept byte',
      ).toEqual([])
      for (const [what, slot, must, never] of reads) {
        expect(start(rom, slot).ok, `${what} reads fine with nothing withheld`).toBe(true)
        for (const addr of must) {
          const s = at(addr, slot)
          expect(s.ok, `${what} @ $${addr.toString(16)} must refuse`).toBe(false)
          n++
          expect(!s.ok && s.reason, `${what} @ $${addr.toString(16)}`).toBe(CUT)
        }
        for (const addr of never) {
          expect(at(addr, slot).ok, `${what} never reads $${addr.toString(16)}`).toBe(true)
        }
      }
      expect(n).toBe(reads.reduce((t, r) => t + r[2].length, 0))
    } finally {
      memo.on = false
    }
  })

  it('a missing DATA_05F800 byte is not a match for a destination whose low byte is zero', () => {
    const rom = world()
    room(rom, 0x000, 0x078000) // low byte $00
    room(rom, 0x001, 0x068000, [{ to: 0x00, via: 0x20 }])
    secondary(rom, 0x20, 0x00, 0x00, 5)
    const real = rom.readByte.bind(rom)
    expect(start(rom, 0x000)).toMatchObject({ ok: true, kind: 'secondary' }) // the real byte matches
    rom.readByte = (a: number) => (a === F800 + 0x20 ? null : real(a))
    const s = start(rom, 0x000)
    expect(s.ok).toBe(false)
    expect(!s.ok && s.reason).toBe(CUT)
  })
})

describe('one secondary-exit flag per map (#895)', () => {
  // UseSecondaryExit is one byte every exit object overwrites (bank_0D.asm:1436-1438) and the exit
  // path reads once (bank_05.asm:7111-7112), so the LAST exit's flag decides every exit of the map.
  // Exit i carries raw byte $A0+i either way: primary lands in $0A0+i, secondary in $0B0+i.
  const orders = [1, 2, 3, 4].flatMap(n =>
    Array.from({ length: 1 << n }, (_, m) => Array.from({ length: n }, (_, i) => !!((m >> i) & 1))),
  )

  it('covers all 2+4+8+16 orders of 1 to 4 exits', () => {
    expect(orders.length).toBe(30)
  })

  it.each(orders.map(o => [o.map(f => (f ? 'S' : 'P')).join('')]))(
    'a %s map: kind, destination and exit graph follow the last exit',
    order => {
      const flags = [...order!].map(c => c === 'S')
      const last = flags[flags.length - 1]!
      const rom = blank()
      room(
        rom,
        0x001,
        0x068000,
        flags.map((f, i) => (f ? { to: 0, via: 0xa0 + i } : { to: 0xa0 + i })),
      )
      for (let i = 0; i < 4; i++) {
        room(rom, 0xa0 + i, 0x078000 + i * 0x100)
        room(rom, 0xb0 + i, 0x079000 + i * 0x100)
        secondary(rom, 0xa0 + i, 0xb0 + i, 0x00, 5)
      }
      const sm = new SmwRom(rom)
      const roots = deriveOverworldEntrances(sm, undefined, SYNTHETIC_FINGERPRINTS).roots!
      const graph = sm.buildLevelExitGraph(roots, SYNTHETIC_FINGERPRINTS.entry).graph
      expect(graph.get(0x001)).toEqual(flags.map((_, i) => (last ? 0xb0 : 0xa0) + i))
      flags.forEach((_, i) => {
        const hit = start(rom, (last ? 0xb0 : 0xa0) + i)
        expect(hit).toMatchObject({ ok: true, kind: last ? 'secondary' : 'main', hops: 1 })
        expect(start(rom, (last ? 0xa0 : 0xb0) + i).ok).toBe(false)
      })
    },
  )
})
