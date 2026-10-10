/**
 * The level-mode uploader table (#506): found at the strip loop's call, read as 32 long
 * pointers, each classified by the opening bytes of its target. Synthetic ROMs need no
 * corpus; the last block compares the stock table against the real carts.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readL2UploaderTable } from '../../../src/rom/L2UploaderTable'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import { buildL1Inputs } from '../../../src/rom/model/L1Model'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { VANILLA, MAGIC, hasRom, romPath } from '../support/corpus'
import { hGrid, inputs } from '../support/mapInputs'
import {
  CALLER_AT,
  EXEC_AT,
  IMAGE_AT,
  NONE_AT,
  OBJ_A_AT,
  SITE_AT,
  plantUploaderTable,
  stockKind,
} from '../support/l2UploaderRom'

const fresh = (plant = true): RomFile => {
  const rom = new RomFile('t.sfc', Buffer.alloc(0x80000, 0))
  if (plant) plantUploaderTable(rom)
  return rom
}
const refusal = (rom: RomFile) => {
  const t = readL2UploaderTable(rom)
  if (t.ok) throw new Error('expected a refusal')
  return t.reason
}
const kinds = (rom: RomFile) => {
  const t = readL2UploaderTable(rom)
  if (!t.ok) throw new Error(t.reason)
  return t.entries.map(e => e.kind)
}

describe('readL2UploaderTable (synthetic)', () => {
  it('maps every one of the 32 modes to the stock kind', () => {
    const k = kinds(fresh())
    expect(k).toHaveLength(32)
    for (let m = 0; m < 32; m++) expect(k[m], `mode ${m}`).toBe(stockKind(m))
  })

  it('classifies by the target bytes, so a relocated routine still reads', () => {
    const rom = fresh()
    rom.writeAt(0x068000, Array.from(rom.readAt(IMAGE_AT, 14)!))
    plantUploaderTable(rom, () => 0x068000)
    expect(new Set(kinds(rom))).toEqual(new Set(['image']))
  })

  it('refuses when the caller is missing, the dispatch is missing, or the caller is doubled', () => {
    expect(refusal(fresh(false))).toMatch(/strip loop .* not present/)
    const noSite = fresh()
    noSite.writeAt(SITE_AT, [0x00])
    expect(refusal(noSite)).toMatch(/dispatch .* not present/)
    const twice = fresh()
    twice.writeAt(0x0590bd, Array.from(twice.readAt(CALLER_AT, 14)!))
    expect(refusal(twice)).toMatch(/matches more than once/)
  })

  it.each([
    ['SEP operand', SITE_AT + 1],
    ['LDA opcode', SITE_AT + 2],
    ['LevelModeSetting operand', SITE_AT + 3],
    ['JSL opcode', SITE_AT + 5],
  ])('a flipped %s in the dispatch refuses', (_what, at) => {
    const rom = fresh()
    rom.writeAt(at, [rom.readByte(at)! ^ 0x01])
    expect(readL2UploaderTable(rom).ok).toBe(false)
  })

  it('refuses when the JSL no longer reaches ExecutePtrLong', () => {
    const rom = fresh()
    rom.writeAt(EXEC_AT + 2, [0x5a])
    expect(refusal(rom)).toMatch(/no longer calls ExecutePtrLong/)
  })

  it('a target with unknown bytes makes only that mode unrecognized', () => {
    const rom = fresh()
    rom.writeAt(0x078000, [0xea, 0xea, 0xea, 0xea])
    plantUploaderTable(rom, m => (m === 3 ? 0x078000 : [OBJ_A_AT, IMAGE_AT, NONE_AT][m % 3]!))
    const k = kinds(rom)
    expect(k[3]).toBe('unrecognized')
    expect(k.filter(x => x === 'unrecognized')).toHaveLength(1)
  })

  it.each([
    ['image', IMAGE_AT + 7],
    ['objects', OBJ_A_AT + 7],
  ])('one changed byte in the %s routine makes it unrecognized', (_k, at) => {
    const rom = fresh()
    rom.writeAt(at, [rom.readByte(at)! ^ 0x10])
    expect(kinds(rom)).toContain('unrecognized')
  })
})

describe('buildL2Inputs picks the kind by level mode (synthetic)', () => {
  const smw = (rom: RomFile) =>
    ({
      rom,
      getVerticalTable: () => ({ ok: true, table: new Array(32).fill(0) }),
    }) as unknown as SmwRom
  const withMode = (mode: number) => {
    const m = inputs(hGrid(1), false, 1)
    return { ...m, header: { ...m.header, levelMode: mode } }
  }
  const romWithPtr = (bank: number) => {
    const rom = fresh()
    rom.writeAt(0x05e600 + 5 * 3, [0x00, 0x90, bank])
    return rom
  }

  it('mode 0 (an image mode) with an object-stream pointer refuses, naming the mode', () => {
    expect(buildL2Inputs(smw(romWithPtr(0x0c)), 5, withMode(0))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/level mode \$00 uploads an L2 image, but .* object stream/),
    })
  })

  it('mode 1 (an object mode) with an image pointer refuses', () => {
    expect(buildL2Inputs(smw(romWithPtr(0xff)), 5, withMode(1))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/level mode \$01 uploads an L2 object stream, but .* image/),
    })
  })

  it('sweeps all 32 modes against both pointer kinds: nothing-modes and disagreements refuse', () => {
    for (let mode = 0; mode < 32; mode++) {
      const kind = stockKind(mode)
      for (const bank of [0xff, 0x0c]) {
        const r = buildL2Inputs(smw(romWithPtr(bank)), 5, withMode(mode))
        const agrees = (kind === 'image') === (bank === 0xff)
        const mine = r.ok ? '' : /uploads|recognizes|dispatch/.test(r.reason) ? r.reason : ''
        if (kind === 'none') expect(mine, `mode ${mode}`).toMatch(/uploads no L2/)
        else if (!agrees) expect(mine, `mode ${mode} bank ${bank}`).toMatch(/uploads an L2/)
        else expect(mine, `mode ${mode} bank ${bank}`).toBe('')
      }
    }
  })

  it('an unrecognized target and a missing table each refuse with a reason', () => {
    const rom = romWithPtr(0x0c)
    plantUploaderTable(rom, () => 0x078000)
    expect(buildL2Inputs(smw(rom), 5, withMode(1))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not a routine this reader recognizes/),
    })
    expect(buildL2Inputs(smw(fresh(false)), 5, withMode(1))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not present/),
    })
  })
})

describe.each([VANILLA, MAGIC])('the real %s', name => {
  it.skipIf(!hasRom(name))(
    'has the stock table, and no map of it is refused by the uploader check',
    () => {
      const rom = new SmwRom(RomFile.load(romPath(name)))
      const k = kinds(rom.rom)
      for (let m = 0; m < 32; m++) expect(k[m], `mode ${m}`).toBe(stockKind(m))
      let maps = 0
      for (let index = 0; index < 0x200; index++) {
        const built = buildL1Inputs(rom, index, UNCLEARED)
        if (!built.ok) continue
        maps++
        const r = buildL2Inputs(rom, index, built.inputs)
        if (!r.ok) expect(r.reason, `slot ${index}`).not.toMatch(/uploads|recognizes|dispatch/)
      }
      expect(maps).toBeGreaterThan(100)
    },
    600_000,
  )
})
