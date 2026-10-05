/**
 * The layer 3 gate's two readers (#561): which level modes use the standard
 * layer layout (CODE_0584E3's main/sub/special/vertical tables), and where a
 * layer 3 settings byte puts layer 3 (CODE_009FB8). Synthetic ROMs throughout;
 * the corpus block at the end reads the vanilla tables straight by address.
 */
import { describe, it, expect } from 'vitest'
import { layoutRefusal, readModeLayouts } from '../../../src/rom/LevelScreenTables'
import { l3LoadTimeY } from '../../../src/rom/L3Loader'
import { RomFile } from '../../../src/rom/RomFile'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { modeTablesRom, SITE_BYTES, STANDARD_MODES, sweepLayouts } from '../support/l3Rom'

describe('readModeLayouts (synthetic)', () => {
  it('names a standard layout for exactly the standard modes, across all 32', () => {
    const r = readModeLayouts(modeTablesRom(sweepLayouts()))
    if (!r.ok) throw new Error(r.reason)
    const std = r.layouts.map((l, m) => (layoutRefusal(l) === null ? m : -1)).filter(m => m >= 0)
    expect(std).toEqual(STANDARD_MODES)
  })

  it('says interactive layer 2 for a vertical-table bit 7, and a non-standard layout otherwise', () => {
    const r = readModeLayouts(modeTablesRom(sweepLayouts()))
    if (!r.ok) throw new Error(r.reason)
    expect(layoutRefusal(r.layouts[4]!)).toMatch(/non-standard/) // 4 % 4 === 0: main differs
    expect(layoutRefusal(r.layouts[2]!)).toMatch(/interactive layer 2/) // 2 % 4 === 2: bit 7
  })

  it('refuses when the load site is absent, repeated, or stores elsewhere', () => {
    const base = sweepLayouts()
    const absent = modeTablesRom(base)
    absent.writeAt(SITE_BYTES.at, new Array(SITE_BYTES.length).fill(0))
    expect(readModeLayouts(absent)).toMatchObject({ ok: false, reason: /not present/ })

    const twice = modeTablesRom(base)
    twice.writeAt(0x058560, [...twice.readAt(SITE_BYTES.at, SITE_BYTES.length)!])
    expect(readModeLayouts(twice)).toMatchObject({ ok: false, reason: /more than once/ })

    // The first STA targets another address: the bytes read are no longer ThroughMain's source.
    const moved = modeTablesRom(base)
    moved.writeAt(SITE_BYTES.at + 5, [0x9c])
    expect(readModeLayouts(moved).ok).toBe(false)
  })

  it('refuses when the vertical table cannot be read', () => {
    const rom = modeTablesRom(sweepLayouts())
    rom.writeAt(0x058520, [0, 0, 0, 0, 0, 0])
    expect(readModeLayouts(rom).ok).toBe(false)
  })
})

describe('l3LoadTimeY: where CODE_009FB8 puts layer 3 (synthetic bytes, no ROM)', () => {
  const CASTLE1 = 1
  const UNDERGROUND1 = 3
  const OTHER = [0, 2, 4, 5, 8, 15]

  it('tide bytes: $01 starts at $70, $02-$7F at $40, on every tileset', () => {
    for (const ts of [CASTLE1, UNDERGROUND1, ...OTHER]) {
      expect([0x01, 0x02, 0x7f].map(b => l3LoadTimeY(b, ts))).toEqual([0x70, 0x40, 0x40])
    }
  })

  it('$00 is $70 on Castle1 and Underground1 and camera-locked elsewhere (CODE_05C40C non-tide path)', () => {
    expect([CASTLE1, UNDERGROUND1].map(ts => l3LoadTimeY(0x00, ts))).toEqual([0x70, 0x70])
    expect(OTHER.map(ts => l3LoadTimeY(0x00, ts))).toEqual(OTHER.map(() => null))
  })

  it('$80 and $C0-$FF sit at $D0 on every tileset (CODE_00A012)', () => {
    for (const ts of [CASTLE1, UNDERGROUND1, ...OTHER]) {
      expect([0x80, 0xc0, 0xff].map(b => l3LoadTimeY(b, ts))).toEqual([0xd0, 0xd0, 0xd0])
    }
  })

  it('$81-$BF is fixed at $C0 on Castle1 and Underground1 and camera-locked (null) elsewhere', () => {
    for (const b of [0x81, 0x82, 0x9f, 0xbf]) {
      expect([CASTLE1, UNDERGROUND1].map(ts => l3LoadTimeY(b, ts))).toEqual([0xc0, 0xc0])
      expect(OTHER.map(ts => l3LoadTimeY(b, ts))).toEqual(OTHER.map(() => null))
    }
  })
})

/** The vanilla tables by their SMWDisX addresses, read with no gate in between. */
describe.skipIf(!hasRom(VANILLA))('vanilla mode tables (corpus)', () => {
  it('modes 0-$11 are standard for exactly the issue set; the table rule also admits the unused $12-$1D', () => {
    const rom = RomFile.load(romPath(VANILLA))
    const at = (a: number) => Array.from(rom.readAt(a, 32)!)
    const [main, sub, special, vertical] = [0x058437, 0x058457, 0x058497, 0x058417].map(at)
    const std = (m: number) => main![m] === 0x15 && sub![m] === 2 && special![m] === 0 && (vertical![m]! & 0x80) === 0 // prettier-ignore
    const used = Array.from({ length: 0x12 }, (_, m) => m).filter(std)
    expect(used).toEqual(STANDARD_MODES)
    const r = readModeLayouts(rom)
    if (!r.ok) throw new Error(r.reason)
    expect(r.layouts.map(l => layoutRefusal(l) === null)).toEqual(Array.from({ length: 32 }, (_, m) => std(m))) // prettier-ignore
    expect(Array.from({ length: 12 }, (_, i) => i + 0x12).every(std)).toBe(true)
  })
})
