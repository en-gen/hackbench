/**
 * #781: Mario's start position carries the entrance's screen (bank_05.asm:7375-7387).
 * The synthetic half builds its bytes and runs in CI; the corpus half sweeps EVERY map.
 */
import { describe, expect, it } from 'vitest'
import { readMarioStartPos } from '../../../src/rom/MarioStartPos'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import { freshRom, hasRom, VANILLA } from '../support/corpus'

/** Distinct low/high bytes per index so a wrong table or index shows. */
function tables(): RomFile {
  const rom = RomFile.fromBytes('s.sfc', Buffer.alloc(0x100000))
  for (let i = 0; i < 16; i++) {
    rom.writeAt(0x05d730 + i, [0x30 + i]) // Y low
    rom.writeAt(0x05d740 + i, [i & 3]) // Y high
  }
  for (let i = 0; i < 8; i++) {
    rom.writeAt(0x05d750 + i, [0x20 + i * 8]) // X low
    rom.writeAt(0x05d758 + i, [i & 1]) // X high
  }
  return rom
}

describe('readMarioStartPos puts the entrance screen in the high byte', () => {
  it.each([...Array(0x20).keys()])('primary entrance on screen %i, horizontal then vertical', s => {
    const rom = tables()
    rom.writeAt(0x05f000 + 7, [0x05]) // Y index 5: low $35, high 1
    rom.writeAt(0x05f200 + 7, [0x03]) // X index 3: low $38, high 1
    rom.writeAt(0x05f600 + 7, [s]) // horizontal
    expect(readMarioStartPos(rom, 7)).toEqual({ x: (s << 8) | 0x38, y: 0x135 })
    rom.writeAt(0x05f600 + 7, [0x20 | s]) // vertical: screen goes to Y, X keeps $05D758
    expect(readMarioStartPos(rom, 7)).toEqual({ x: 0x138, y: (s << 8) | 0x35 })
  })

  // The entrance index is (map & $100) | low and DATA_05F800 holds the target's low byte, so every
  // screen 0..$1F is reachable, even and odd (bank_05.asm:7103-7119).
  it.each([...Array(0x20).keys()])(
    'secondary entrance on screen %i, horizontal then vertical',
    s => {
      const rom = tables()
      rom.writeAt(0x05f800 + 0x103, [0x05]) // entrance $103 targets $105
      rom.writeAt(0x05fa00 + 0x103, [0x04]) // Y index 4: low $34, high 0
      rom.writeAt(0x05fc00 + 0x103, [(2 << 5) | s]) // X index 2: low $30, high 0
      rom.writeAt(0x05f000 + 0x105, [0x0f]) // the primary bytes differ, so ignoring the entrance shows
      rom.writeAt(0x05f200 + 0x105, [0x07])
      rom.writeAt(0x05f600 + 0x105, [0]) // horizontal
      expect(readMarioStartPos(rom, 0x105)).toEqual({ x: (s << 8) | 0x30, y: 0x34 })
      rom.writeAt(0x05f600 + 0x105, [0x20]) // vertical: screen goes to Y
      expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x30, y: (s << 8) | 0x34 })
    },
  )

  it('selects by entrance index, not by DATA_05FC00 bit 0, and takes the lowest on a tie', () => {
    const rom = tables()
    // A decoy the old FC00-bit-0 rule would pick for $105: entrance 3, F800 = $05, FC00 bit 0 set.
    rom.writeAt(0x05f800 + 3, [0x05])
    rom.writeAt(0x05fc00 + 3, [(7 << 5) | 1])
    rom.writeAt(0x05fa00 + 3, [0x0f])
    // The real one: entrance $105 (bit 8 matches the map), screen 2 (even).
    rom.writeAt(0x05f800 + 0x105, [0x05])
    rom.writeAt(0x05fc00 + 0x105, [(2 << 5) | 2])
    rom.writeAt(0x05fa00 + 0x105, [0x04])
    expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x230, y: 0x34 })
    // A tie between $105 and $107 (same target): the lower index wins.
    rom.writeAt(0x05f800 + 0x107, [0x05])
    rom.writeAt(0x05fc00 + 0x107, [(4 << 5) | 9])
    expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x230, y: 0x34 })
    // A map below $100 never uses a secondary entrance.
    rom.writeAt(0x05f800 + 0x05, [0x05])
    expect(readMarioStartPos(rom, 0x05).x).toBe(0x20)
  })
})

/** Tables plus the stock code shape the nudge reads (bank_00.asm:A716, A726, A752, A756). */
function withNudgeCode(m = 0x08, n = 0x02): RomFile {
  const rom = tables()
  rom.writeAt(0x00a716, [0xc9, 0x06])
  rom.writeAt(0x00a752, [0xc0, 0x06])
  rom.writeAt(0x00a726, [0xa9, m, 0x04, 0x94, 0xa9, n, 0x04, 0x96])
  rom.writeAt(0x00a756, [0xa9, m, 0x04, 0x94])
  return rom
}

describe('readMarioStartPos entrance-type nudge (CODE_00A716-00A75A)', () => {
  // Type is DATA_05F200 bits 5:3; X idx 0 gives $20, Y idx 0 gives $30. Masks differ from stock so a hard-coded
  // $08/$02 would show; types 3, 4, 7 OR X, type 6 ORs X and Y, 0, 1, 2 and 5 do nothing.
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('type %i', type => {
    const rom = withNudgeCode(0x41, 0x05)
    rom.writeAt(0x05f200 + 7, [type << 3])
    rom.writeAt(0x05f000 + 7, [0])
    const got = readMarioStartPos(rom, 7)
    const x = [3, 4, 6, 7].includes(type) ? 0x20 | 0x41 : 0x20
    const y = type === 6 ? 0x30 | 0x05 : 0x30
    expect(got).toEqual({ x, y })
  })

  it('a secondary entrance takes its type from DATA_05FE00', () => {
    const rom = withNudgeCode()
    rom.writeAt(0x05f800 + 0x103, [0x05])
    rom.writeAt(0x05fe00 + 0x103, [0x07])
    expect(readMarioStartPos(rom, 0x105).x & 0x08).toBe(0x08)
    rom.writeAt(0x05fe00 + 0x103, [0x02])
    expect(readMarioStartPos(rom, 0x105).x & 0x08).toBe(0)
  })

  it.each([
    ['CMP #$06 opcode', 0x00a716, [0xc5], [3, 6]],
    ['CPY #$06 operand', 0x00a753, [0x05], [3, 6]],
    ['type 6 first LDA', 0x00a726, [0xa5], [6]],
    ['type 6 TSB $96', 0x00a72d, [0x95], [6]],
    ['types 3,4,7 TSB', 0x00a758, [0x14], [3]],
  ])('omits the nudge when the code changed: %s', (_n, at, bytes, types) => {
    for (const type of types as number[]) {
      const rom = withNudgeCode()
      rom.writeAt(at as number, bytes as number[])
      rom.writeAt(0x05f200 + 7, [type << 3])
      expect(readMarioStartPos(rom, 7)).toEqual({ x: 0x20, y: 0x30 })
    }
  })
})

// The loader (levelSeed's source) runs the PRIMARY path for every map, UseSecondaryExit being 0
// (loadLevelState sets only $0E/$0F), so a sub area with a targeting entrance differs from it by design:
// this reader follows the entrance, as the game does. Measured 2026-10-10, vanilla ROM, one machine: the
// loader ran all 512 maps, and 18 differ, all sub areas. Every primary-path map ($000-$0FF and the rest)
// equals the loader's $94/$96 exactly, entrance screen and type nudge included.
const SUB_AREAS = '100:-8,-224 102:1288,80 103:2168,-48 105:2056,-46 106:4312,0 10a:3952,80 10b:2672,-128 10f:776,32 113:2056,-80 116:2424,-80 117:1656,0 118:4104,240 119:3960,128 11a:3696,0 11f:2264,-16 123:1032,-32 127:2680,-16 12c:2520,0' // prettier-ignore

describe.skipIf(!hasRom(VANILLA))('readMarioStartPos vs the ROM loader, every vanilla map', () => {
  it('equals the loader $94/$96 on all 512 maps but the 18 pinned sub areas', () => {
    const rom = freshRom()
    let ran = 0
    const refused: number[] = []
    const diffs: string[] = []
    for (let m = 0; m < 0x200; m++) {
      const l = loadLevelState(rom, m)
      if (!l.ok) {
        refused.push(m)
        continue
      }
      ran++
      const got = readMarioStartPos(rom, m)
      const [x, y] = [l.wram[0x94]! | (l.wram[0x95]! << 8), l.wram[0x96]! | (l.wram[0x97]! << 8)]
      if (got.x !== x || got.y !== y) diffs.push(`${m.toString(16)}:${got.x - x},${got.y - y}`)
    }
    expect({ ran, refused }).toEqual({ ran: 512, refused: [] })
    expect(diffs).toEqual(SUB_AREAS.split(' '))
  }, 600_000)
})

// Spike Top ($2E) faces Mario's side (bank_01.asm:602-612), so a wrong start X flips it. Before #781 the
// 4 placements on map $1BF faced the other way from the loader's Mario (X 16 against 784); 0 of 35 outside the pinned sub areas; the other 9 (sub areas $10b, $11a) follow their secondary entrance.
describe.skipIf(!hasRom(VANILLA))(
  'Spike Top facing from the start position, all vanilla placements',
  () => {
    it('the table start and the loader start put Mario on the same side of all 44 Spike Tops', () => {
      const rom = new SmwRom(freshRom())
      let n = 0
      const wrong: string[] = []
      for (let m = 0; m < 0x200; m++) {
        const ptr = rom.getLevelSpritePointer(m)
        const bytes = ptr ? rom.rom.readUpTo(ptr, 0x200) : null
        if (!bytes) continue
        const vertical = ((rom.rom.readByte(0x05f600 + m) ?? 0) & 0x20) !== 0
        const l = loadLevelState(rom.rom, m)
        for (const s of parseLevelSprites(bytes, vertical)) {
          if (s.spriteId !== 0x2e || !l.ok) continue
          n++
          const loaderX = l.wram[0x94]! | (l.wram[0x95]! << 8)
          if (readMarioStartPos(rom.rom, m).x < s.x * 16 !== loaderX < s.x * 16) wrong.push(m.toString(16)) // prettier-ignore
        }
      }
      expect(n).toBe(44)
      // Only the pinned sub areas, which follow their secondary entrance, may differ from the loader.
      const subs = SUB_AREAS.split(' ').map(d => d.split(':')[0])
      for (const w of wrong) expect(subs).toContain(w)
    }, 120_000)
  },
)
