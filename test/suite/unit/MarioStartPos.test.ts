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

  // The overworld enters a $1xx map by its primary path (UseSecondaryExit 0: Clear_1A_13D3 zeroes
  // $13D3-$1BA1, bank_00.asm:4375-4385; overworld path bank_05.asm:7091-7093, 7164-7226, 7300), so a DATA_05F800 entry targeting it must not move Mario: the reader stays on DATA_05F000/F200.
  it('a $1xx map with a DATA_05F800 entry targeting it still reads its PRIMARY entrance', () => {
    const rom = tables()
    rom.writeAt(0x05f800 + 0x103, [0x05]) // entrance $103 targets $105
    rom.writeAt(0x05fa00 + 0x103, [0x04])
    rom.writeAt(0x05fc00 + 0x103, [(2 << 5) | 3])
    rom.writeAt(0x05fe00 + 0x103, [0x07])
    rom.writeAt(0x05f000 + 0x105, [0x05]) // primary Y index 5: $35 high 1
    rom.writeAt(0x05f200 + 0x105, [0x03]) // primary X index 3: $38 high 1
    rom.writeAt(0x05f600 + 0x105, [0x02]) // screen 2
    expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x238, y: 0x135 })
  })

  it('reads the primary Y index from all four low bits and the X index from three', () => {
    const rom = tables()
    rom.writeAt(0x05f000 + 7, [0x0c]) // Y index 12 (a 3-bit mask would give 4)
    rom.writeAt(0x05f200 + 7, [0x0b]) // X index 3 (bit 3 is the type, not the index)
    expect(readMarioStartPos(rom, 7)).toEqual({ x: 0x38, y: 0x3c })
  })
})

/** Tables plus the stock code shape the nudge reads (bank_00.asm:4985-5060). */
function withNudgeCode(m = 0x08, n = 0x02): RomFile {
  const rom = tables()
  rom.writeAt(0x00a6d8, [0xf0, 0x06, 0xc9, 0x05, 0xd0, 0x38]) // BEQ, CMP #$05, BNE
  rom.writeAt(0x00a716, [0xc9, 0x06, 0x90, 0x26, 0xd0, 0x18]) // CMP #$06, BCC, BNE
  rom.writeAt(0x00a736, [0xad, 0xcf, 0x13, 0x0d, 0x34, 0x14, 0xd0, 0xa2]) // LDA, ORA, BNE CODE_00A6E0 (type 7 entry)
  rom.writeAt(0x00a73e, [0xa9, 0x04, 0x18, 0x69, 0x03]) // LDA #$04, CLC, ADC #$03
  rom.writeAt(0x00a752, [0xc0, 0x06, 0x90, 0x12]) // CPY #$06, BCC
  rom.writeAt(0x00a726, [0xa9, m, 0x04, 0x94, 0xa9, n, 0x04, 0x96])
  rom.writeAt(0x00a756, [0xa9, m, 0x04, 0x94])
  return rom
}

describe('readMarioStartPos refuses unreadable entrance tables (#800 review)', () => {
  // One unreadable byte at a time, so each of the seven reads is proven to be checked on its own:
  // a read that fell back to 0 would give a plausible-looking {x, y} instead of null.
  const idx = (): RomFile => {
    const rom = tables()
    rom.writeAt(0x05f000 + 7, [0x05]) // Y index 5
    rom.writeAt(0x05f200 + 7, [0x03]) // X index 3
    return rom
  }
  const reads = [
    ['DATA_05F000', 0x05f000 + 7], ['DATA_05F200', 0x05f200 + 7], ['DATA_05F600', 0x05f600 + 7],
    ['DATA_05D730 (Y low)', 0x05d730 + 5], ['DATA_05D740 (Y high)', 0x05d740 + 5],
    ['DATA_05D750 (X low)', 0x05d750 + 3], ['DATA_05D758 (X high)', 0x05d758 + 3],
  ] as const // prettier-ignore
  it('reads fine with every byte present', () => {
    expect(readMarioStartPos(idx(), 7)).toEqual({ x: 0x38, y: 0x135 }) // screen 0
  })
  it.each(reads)('returns null when %s cannot be read', (_n, addr) => {
    const real = idx()
    const holey = {
      readByte: (a: number) => (a === addr ? null : real.readByte(a)),
    } as unknown as RomFile
    expect(readMarioStartPos(holey, 7)).toBeNull()
  })
})

describe('readMarioStartPos entrance-type nudge (bank_00.asm:5019-5060)', () => {
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

  // OR, not ADD: X low byte $28 (index 5) already has bit 3, so OR with $08 stays $28 and ADD gives $30.
  it('ORs the mask into X (does not add it)', () => {
    const rom = withNudgeCode(0x08, 0x02)
    rom.writeAt(0x05d750 + 5, [0x28])
    rom.writeAt(0x05f200 + 7, [(3 << 3) | 5])
    expect(readMarioStartPos(rom, 7)!.x).toBe(0x28)
  })

  it.each([
    ['CMP #$06 opcode', 0x00a716, [0xc5], [3, 6]],
    ['CPY #$06 operand', 0x00a753, [0x05], [3, 6]],
    ['type 6 first LDA', 0x00a726, [0xa5], [6]],
    ['type 6 TSB $96', 0x00a72d, [0x95], [6]],
    ['types 3,4,7 TSB', 0x00a758, [0x14], [3]],
    ['type 0 BEQ', 0x00a6d8, [0xd0], [3]],
    ['CMP #$05 operand', 0x00a6db, [0x04], [3]],
    ['BCC to the ADC', 0x00a718, [0xb0], [3]],
    ['BNE to the type 7 path', 0x00a71a, [0xf0], [7]],
    ['type 7 LDA #$04 operand', 0x00a73f, [0x05], [7]],
    ['ADC #$03 operand', 0x00a742, [0x02], [3, 4, 7]],
    ['ADC opcode', 0x00a741, [0xe9], [3]],
    ['BCC after CPY', 0x00a754, [0xb0], [3]],
    // Branch OPERANDS and the type 7 entry (bank_00.asm:5036-5039): a changed offset retargets the nudge.
    ['BNE CODE_00A6E0 offset (type 7)', 0x00a73d, [0x80], [7]],
    ['BNE CODE_00A6E0 opcode (type 7)', 0x00a73c, [0xf0], [7]],
    ['LDA SkipMidwayCastleIntro (type 7)', 0x00a736, [0xae], [7]],
    ['ORA KeyholeTimer (type 7)', 0x00a739, [0x0c], [7]],
    ['BEQ offset', 0x00a6d9, [0x07], [3]],
    ['BNE offset after CMP #$05', 0x00a6dd, [0x39], [3]],
    ['BCC offset after CMP #$06', 0x00a719, [0x28], [3]],
    ['BNE offset after BCC', 0x00a71b, [0x19], [3]],
    ['BCC offset after CPY', 0x00a755, [0x13], [3]],
  ])('omits the nudge when the code changed: %s', (_n, at, bytes, types) => {
    for (const type of types as number[]) {
      const rom = withNudgeCode()
      rom.writeAt(at as number, bytes as number[])
      rom.writeAt(0x05f200 + 7, [type << 3])
      expect(readMarioStartPos(rom, 7)).toEqual({ x: 0x20, y: 0x30 })
    }
  })
})

// The loader runs the PRIMARY path for every map (UseSecondaryExit 0) and so does the overworld's entry into an
// entry map ($1xx included, bank_05.asm:7091-7093, 7164-7226, 7300-7337), so the reader reads primary bytes only.
// Measured on the vanilla ROM, one machine: see the sweep below for the count of maps compared.
describe.skipIf(!hasRom(VANILLA))('readMarioStartPos vs the ROM loader, every vanilla map', () => {
  it('equals the loader $94/$96 on all 512 maps', () => {
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
    expect(diffs).toEqual([])
  }, 600_000)
})

// Spike Top ($2E) faces Mario's side (bank_01.asm:602-612), so a wrong start X flips it. Before #781 the
// 4 placements on map $1BF faced the other way from the loader's Mario (X 16 against 784).
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
          if (readMarioStartPos(rom.rom, m)!.x < s.x * 16 !== loaderX < s.x * 16) wrong.push(m.toString(16)) // prettier-ignore
        }
      }
      expect(n).toBe(44)
      expect(wrong).toEqual([])
    }, 120_000)
  },
)
