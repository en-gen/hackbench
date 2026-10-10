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

  // findSecondaryEntranceForLevel reads the target's bit 8 from DATA_05FC00 bit 0, which is also
  // the screen's bit 0, so an entrance into a map $100+ can only sit on an odd screen here.
  it.each([...Array(0x10).keys()].map(k => k * 2 + 1))(
    'secondary entrance on screen %i, horizontal then vertical',
    s => {
      const rom = tables()
      rom.writeAt(0x05f800 + 3, [0x05]) // entrance 3 targets $105
      rom.writeAt(0x05fa00 + 3, [0x04]) // Y index 4: low $34, high 0
      rom.writeAt(0x05fc00 + 3, [(2 << 5) | s]) // X index 2: low $30, high 0
      rom.writeAt(0x05f000 + 0x105, [0x0f]) // the primary bytes differ, so ignoring the entrance shows
      rom.writeAt(0x05f200 + 0x105, [0x07])
      rom.writeAt(0x05f600 + 0x105, [0]) // horizontal
      expect(readMarioStartPos(rom, 0x105)).toEqual({ x: (s << 8) | 0x30, y: 0x34 })
      rom.writeAt(0x05f600 + 0x105, [0x20]) // vertical: screen goes to Y
      expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x30, y: (s << 8) | 0x34 })
    },
  )
})

// The loader (levelSeed's source) runs the PRIMARY path for every map, UseSecondaryExit being 0
// (loadLevelState sets only $0E/$0F), so a sub area with a targeting entrance differs from it by design.
// Measured 2026-10-10, vanilla ROM, one machine: 512 maps, the loader ran all 512, 57 differ, all explained:
//  - X short by 8 (type 6 also Y by 2): the entrance-type nudge in CODE_00A716-00A740 (bank_00.asm),
//    which the loader's $94/$96 carry and this reader does not model. Entrance types 3, 4, 6, 7.
//  - sub areas that findSecondaryEntranceForLevel resolves: this reader follows the entrance, the loader
//    the primary bytes (the screen part of the gap is the entrance's screen vs the map's own).
const NUDGE = '0:-8,0 a:-8,0 b:-8,0 11:-8,0 18:-8,0 be:-8,0 bf:-8,0 c0:-8,0 c1:-8,0 c2:-8,0 c3:-8,0 c6:-8,0 d0:-8,-2 d1:-8,-2 d2:-8,0 d7:-8,0 d8:-8,0 dd:-8,0 e0:-8,0 e1:-8,0 e3:-8,0 e9:-8,0 f5:-8,-2 f6:-8,-2 f7:-8,0 f8:-8,0 ff:-8,0 120:-8,0 130:-8,0 1be:-8,0 1c0:-8,0 1c1:-8,0 1c4:-8,0 1c5:-8,0 1c6:-8,0 1c9:-8,0 1ca:-8,0 1cb:-8,0 1ce:-8,0 1d5:-8,0 1df:-8,0 1e0:-8,0 1e5:-8,0 1f5:-8,0 1f8:-8,0 1fd:-8,0' // prettier-ignore
const SECONDARY = '100:360,112 102:1280,80 10a:3952,80 10d:3440,16 10f:768,32 110:1280,-256 115:2928,-48 116:2416,-80 119:3952,128 123:3536,-96 12c:2512,0' // prettier-ignore

describe.skipIf(!hasRom(VANILLA))('readMarioStartPos vs the ROM loader, every vanilla map', () => {
  it('equals the loader $94/$96 on all 512 maps but the 57 pinned ones', () => {
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
    expect(diffs).toEqual([...NUDGE.split(' '), ...SECONDARY.split(' ')].sort((a, b) => parseInt(a, 16) - parseInt(b, 16))) // prettier-ignore
  }, 600_000)
})

// Spike Top ($2E) faces Mario's side (bank_01.asm:602-612), so a wrong start X flips it. Before #781 the
// 4 placements on map $1BF faced the other way from the loader's Mario (X 16 against 784); 0 of 44 now.
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
      expect({ n, wrong }).toEqual({ n: 44, wrong: [] })
    }, 120_000)
  },
)
