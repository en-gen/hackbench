/**
 * The bonus game and Yoshi wings entrances, read from CODE_05DBAC on
 * synthetic ROMs (bank_05.asm:7085-7090, 7607-7620). No corpus needed.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildMapTree, type MapNode } from '../../../src/rom/MapTree'
import {
  BONUS_CALL,
  BONUS_LOAD_JMP,
  BONUS_PICK,
  BONUS_PRIMARY,
  findBonusEntrances,
} from '../../../src/rom/BonusEntrances'
import { SCREEN_EXIT } from '../../../src/rom/SubmapFlagGate'
import { WILD } from '../../../src/rom/BytePattern'
import {
  plantBonusCode,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
  SYNTHETIC_LANDING,
  SYNTHETIC_PICK_AT as P,
  writeSyntheticRom,
} from '../support/syntheticRom'

function bonusRom(): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('bonus.sfc', buf)
  plantStockSubmapCode(rom)
  plantBonusCode(rom)
  return rom
}

const find = (rom: RomFile): ReturnType<typeof findBonusEntrances> =>
  findBonusEntrances(rom, SYNTHETIC_FINGERPRINTS.bonus)
const names = (xs: { role: string; index: number }[]): string =>
  xs.map(m => `${m.role} ${m.index.toString(16)}`).join(', ')
const slots = (rom: RomFile): string => names(find(rom).maps)
const withBytes = (at: number, bytes: number[], rom = bonusRom()): RomFile => {
  rom.writeAt(at, bytes)
  return rom
}

describe('findBonusEntrances', () => {
  it('reads the bonus room and the Yoshi wings sub area in both halves', () => {
    expect(slots(bonusRom())).toBe('bonus-game 0, bonus-game 100, yoshi-wings c8, yoshi-wings 1c8')
    expect(find(bonusRom()).maps[2]!.foundAt).toBe('$05DBAA')
    expect(findBonusEntrances(bonusRom()).maps).toEqual([]) // the stock fingerprint refuses NOPs
  })

  it('indexes the table with the LDY operands', () => {
    const rom = withBytes(0x05dba9, [0x00, 0xc8, 0x33])
    rom.writeAt(P + 1, [0x02]) // LDY #$02 for the bonus game
    expect(slots(rom)).toMatch(/^bonus-game 33, bonus-game 133,/)
  })

  it('follows a relocated table through the LDA operand, in the routine bank', () => {
    const rom = withBytes(0x05e000, [0x11, 0x22])
    rom.writeAt(P + 20, [0x00, 0xe0])
    expect(slots(rom)).toBe('bonus-game 11, bonus-game 111, yoshi-wings 22, yoshi-wings 122')
  })

  it('follows the JSR to a relocated CODE_05DBAC', () => {
    const rom = withBytes(0x05d7a9, [0x00, 0xe1])
    rom.writeAt(0x05e100, [...rom.readAt(P, 29)!])
    rom.writeAt(P, [0xea])
    expect(find(rom).maps).toHaveLength(4)
  })

  it('follows a negative primary-exit displacement to its JMP CODE_05D8B7', () => {
    const rom = withBytes(0x05d7d8, [0x80]) // lands at $05D7D9 - $80
    rom.writeAt(0x05d759, [...BONUS_LOAD_JMP])
    expect(find(rom).maps).toHaveLength(4)
  })

  it('takes the submap high byte from the screen-exit LDA #imm', () => {
    expect(slots(withBytes(0x05d7d1, [0x00]))).toBe('bonus-game 0, yoshi-wings c8')
    expect(find(withBytes(0x05d7d1, [0x02])).notes[0]).toContain('$05D7D1')
  })

  it('refuses an unreadable table, such as an operand below $8000', () => {
    expect(find(withBytes(P + 21, [0x7f])).maps).toEqual([])
  })
})

/** Every byte the gate pins, taken from the checks themselves: one case per position. */
const callBytes = Array.from({ length: BONUS_CALL.length }, (_, i) =>
  BONUS_CALL.mask!.includes(i) ? WILD : 0,
)
const pinned = [
  ...SCREEN_EXIT.map(c => [c.what, c.addr, c.bytes] as const),
  [BONUS_CALL.what, BONUS_CALL.addr, callBytes] as const,
  [BONUS_PRIMARY.what, BONUS_PRIMARY.addr, BONUS_PRIMARY.bytes] as const,
  ['JMP CODE_05D8B7', SYNTHETIC_LANDING, BONUS_LOAD_JMP] as const,
  ['CODE_05DBAC', P, BONUS_PICK] as const,
].flatMap(([what, at, bytes]) =>
  bytes.flatMap((b, i) =>
    b === WILD ? [] : [[`$${(at + i).toString(16)}`, what, at + i] as const],
  ),
)

describe('every pinned byte refuses when changed', () => {
  // Counted per run, so unpinning a byte, which drops its case, is still seen.
  it('pins the counted bytes of each checked run', () => {
    const per = new Map<string, number>()
    for (const [, what] of pinned) per.set(what, (per.get(what) ?? 0) + 1)
    expect([...per.values()]).toEqual([4, 8, 3, 51, 13, 3, 25])
  })

  it.each(pinned)('%s in %s', (_hex, _what, at) => {
    const found = find(withBytes(at, [bonusRom().readByte(at)! ^ 0xff]))
    expect(found.maps).toEqual([])
    expect(found.notes[0]).toMatch(/^Bonus game and Yoshi wings: /)
  })
})

describe('the Maps tree', () => {
  const tree = (plant?: (rom: RomFile) => void): ReturnType<typeof buildMapTree> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bonus-'))
    const rooms = [0x000, 0x001, 0x0c5, 0x0c7, 0x0c8, 0x1c8].map(s => [s, []] as [number, number[]])
    const rom = RomFile.load(writeSyntheticRom(dir, new Map(rooms)))
    plantBonusCode(rom)
    rom.writeAt(0x01f000, [0xa9, 0xeb, 0xa0, 0x00, 0x8d, 0x09, 0x01]) // title: $EB - $24
    rom.writeAt(0x01f010, [0xa9, 0xe9, 0x8d, 0x09, 0x01]) // intro: $E9 - $24
    plant?.(rom)
    return buildMapTree(new SmwRom(rom), SYNTHETIC_FINGERPRINTS)
  }

  it('lists $000 as the bonus room, after the title screen and the intro', () => {
    const t = tree()
    expect(t.overworld.map(n => n.index)).toEqual([0x001])
    expect(names(t.special)).toBe(
      'title-screen c7, new-game c5, bonus-game 0, yoshi-wings c8, yoshi-wings 1c8',
    )
    expect(t.unassigned).toEqual([])
  })

  it('lists $000 once when the walk also roots it', () => {
    // Threshold $10, bias $24: translevel $24 wraps to slot $000.
    const t = tree(rom => rom.writeAt(0x05d8a3, [0x10]))
    const top: MapNode[] = [...t.special, ...t.overworld, ...t.unassigned]
    expect(top.filter(n => n.index === 0x000)).toHaveLength(1)
    expect(t.overworld.map(n => n.index)).toContain(0x000)
  })

  it('a broken path refuses only the special entrances', () => {
    const t = tree(rom => rom.writeAt(0x05d7a9, [0xad]))
    expect(t.overworld.map(n => n.index)).toEqual([0x001])
    expect(names(t.special)).toBe('title-screen c7, new-game c5')
    expect(t.unassigned.map(n => n.index)).toEqual([0x000, 0x0c8, 0x1c8])
    expect(t.notes.join(' ')).toMatch(/Bonus game and Yoshi wings: /)
  })
})
