/**
 * Lunar Magic's stored translevel table on synthetic ROMs: each layout reads,
 * translevels come from the table rather than a count, every pinned byte of
 * the walk entry is load-bearing, and a replaced decompressor refuses.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { encode } from '../../../src/rom/LcLz2'
import { DECOMPRESSOR } from '../../../src/rom/LmTranslevelTable'
import { ENTER_COMPARE, deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { WILD } from '../../../src/rom/BytePattern'
import { blankStockRom, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

const ENTRY = 0x04d7f2
const TABLE_AT = 0x0e8000

/** The walk entry as Lunar Magic lays it out, from its parts; `pinned` marks bytes the reader checks. */
function lmEntry(bankFirst: boolean, blocks: 1 | 2, fastRom = false) {
  const bytes: number[] = []
  const pinned: boolean[] = []
  const put = (b: number[], pin = true): void => {
    bytes.push(...b)
    b.forEach(() => pinned.push(pin))
  }
  const source = (addr: number): void => {
    const [lo, hi, bank] = [addr & 0xff, (addr >> 8) & 0xff, addr >> 16]
    for (const [op, operand, sta] of bankFirst
      ? ([
          [0xa9, [bank], 0x8c],
          [0xa2, [lo, hi], 0x8a],
        ] as const)
      : ([
          [0xa2, [lo, hi], 0x8a],
          [0xa9, [bank], 0x8c],
        ] as const)) {
      put([op])
      put([...operand], false)
      put(sta === 0x8a ? [0x86, 0x8a] : [0x85, 0x8c])
    }
  }
  // prettier-ignore
  const call = (): void =>
    put([0x08, 0x4b, 0x62, 0x06, 0x00, 0xf4, 0x4c, 0x80, 0x5c, 0xde, 0xb8, fastRom ? 0x80 : 0, 0x28])
  put([0xc2, 0x30, 0xa9, 0x00, 0x00, 0xe2, 0x20])
  put([0xa2, 0x00, 0xd0, 0x86, 0x00, 0xa9, 0x7e, 0x85, 0x02])
  source(TABLE_AT)
  call()
  if (blocks === 2) {
    put([0xa2, 0x00, 0xc8, 0x86, 0x00, 0xa9, 0x7f, 0x85, 0x02])
    source(TABLE_AT)
    call()
  }
  put([0x80, 0x10])
  return { bytes, pinned }
}

function build(table: Uint8Array, entry = lmEntry(false, 2)): RomFile {
  const rom = blankStockRom()
  rom.writeAt(ENTRY, entry.bytes)
  rom.writeAt(ENTRY + entry.bytes.length + 0x10, [0x64, 0x0f, 0x20, 0x49, 0xda])
  rom.writeAt(0x00804d, [0x6b])
  rom.writeAt(DECOMPRESSOR.addr, Buffer.alloc(DECOMPRESSOR.length, 0xea))
  rom.writeAt(TABLE_AT, [...encode(table)])
  return rom
}
const derive = (rom: RomFile) =>
  deriveOverworldEntrances(new SmwRom(rom), undefined, SYNTHETIC_FINGERPRINTS)
const tableOf = (entries: Record<number, number>): Uint8Array => {
  const t = new Uint8Array(0x1000)
  for (const [i, tl] of Object.entries(entries)) t[Number(i)] = tl
  return t
}
const walked = (rom: RomFile): number[][] =>
  derive(rom).entrances.map(e => [e.bufferIndex, e.translevel, e.slot])

describe('deriveOverworldEntrances: OWPU_NotOnPipe tile compare', () => {
  const entrances = (rom: RomFile) => derive(rom).entrances
  it('leaves stock classification verified', () => {
    expect(entrances(build(tableOf({ 0x01: 1 })))[0]).not.toHaveProperty('actionUnverified')
  })

  it.each(ENTER_COMPARE.flatMap((b, i) => (b === WILD ? [] : [i])))(
    'marks every entrance unverified with compare byte %i flipped, roots unchanged',
    i => {
      const stock = derive(build(tableOf({ 0x01: 1, 0x420: 0x30 })))
      const rom = build(tableOf({ 0x01: 1, 0x420: 0x30 }))
      rom.writeAt(0x049199 + i, [ENTER_COMPARE[i]! ^ 0xff])
      const result = derive(rom)
      expect(result.roots).toEqual(stock.roots)
      for (const e of result.entrances) expect(e.actionUnverified).toContain('OWPU_NotOnPipe')
    },
  )
})

describe('deriveOverworldEntrances: Lunar Magic stored translevels', () => {
  it.each([
    [false, 1],
    [false, 2],
    [true, 1],
    [true, 2],
  ] as const)('reads the table with bank-first %s and %i block(s)', (bankFirst, blocks) => {
    for (const fastRom of [false, true]) {
      const rom = build(tableOf({ 0x10: 3, 0x420: 0x30 }), lmEntry(bankFirst, blocks, fastRom))
      // $30 is past #601's threshold: slot $10C on either map.
      expect(walked(rom)).toEqual([
        [0x10, 3, 0x003],
        [0x420, 0x30, 0x10c],
      ])
    }
  })

  it('moves an entrance with its table entry', () => {
    expect(walked(build(tableOf({ 0x07: 9, 0x06: 2 })))).toEqual([
      [0x06, 2, 0x002],
      [0x07, 9, 0x009],
    ])
  })

  it('ignores the table past $800, the directions the game keeps there', () => {
    expect(walked(build(tableOf({ 0x01: 1, 0x801: 5 })))).toEqual([[0x01, 1, 0x001]])
  })

  const entry = lmEntry(false, 2)
  const pinned = entry.bytes.flatMap((_, i) => (entry.pinned[i] ? [i] : []))
  it.each(pinned)('refuses with entry byte %i flipped', i => {
    const rom = build(tableOf({ 0x01: 1 }), entry)
    rom.writeAt(ENTRY + i, [entry.bytes[i]! ^ 0xff])
    expect(derive(rom).overworldReadable).toBe(false)
  })

  it.each([
    ['the stock tail', ENTRY + entry.bytes.length + 0x10],
    ['the RTL at $00804D', 0x00804d],
  ])('refuses without %s', (_what, at) => {
    const rom = build(tableOf({ 0x01: 1 }))
    rom.writeAt(at, [0x00])
    expect(derive(rom).overworldReadable).toBe(false)
  })

  it('refuses a replaced decompressor, naming its site', () => {
    const rom = build(tableOf({ 0x01: 1 }))
    rom.writeAt(DECOMPRESSOR.addr, [0x22])
    const result = derive(rom)
    expect(result.overworldReadable).toBe(false)
    expect(result.notes[0]).toContain('$00B8DE')
  })

  it('refuses a table shorter than the $800 tiles', () => {
    const rom = build(new Uint8Array(0x7ff))
    expect(derive(rom).notes[0]).toContain('short of $800')
  })
})
